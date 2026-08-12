"""`porch-mobile` — the operator CLI (§10).

Setup is one command; daily use is none. Everything here is idempotent and
safe to re-run, and `doctor` is offline by default per house rules.
"""

from __future__ import annotations

import argparse
import signal
import sys
import time
from pathlib import Path

from porch3.config import ConfigError, load_config
from porch3.platform import require_macos
from porchd import config as config_mod
from porchd import devices, lease, provision, server
from porchd.service import Service
from porchd.state import default_root, ensure_root


def _root(args) -> Path:
    return ensure_root(Path(args.state_root).expanduser() if args.state_root else None)


def _apply_base_url_arg(config: config_mod.Config, args) -> None:
    """Apply --base-url onto config (validated); leave unchanged if absent."""
    raw = getattr(args, "base_url", None)
    if not raw:
        return
    config.base_url = config_mod.validate_https_base_url(raw)


def _pairing_url(base: str, token: str) -> str:
    return f"{base.rstrip('/')}/#pair={token}"


def _porch_config():
    try:
        return load_config()
    except ConfigError as exc:
        print(f"porch config: {exc}", file=sys.stderr)
        print("Run `porch init` before starting porch-mobile.", file=sys.stderr)
        raise SystemExit(2) from exc


def cmd_run(args) -> int:
    root = _root(args)
    config = config_mod.load(root)
    porch_config = _porch_config()
    service = Service(root, porch_config=porch_config, config=config)
    service.start()
    httpd = server.serve(service)

    def _shutdown(*_):
        service.stop()
        httpd.shutdown()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    print(f"porchd listening on 127.0.0.1:{config.port} (loopback only)", flush=True)
    try:
        httpd.serve_forever()
    finally:
        service.stop()
    return 0


def cmd_setup(args) -> int:
    root = _root(args)
    config = config_mod.load(root)
    if args.port:
        config.port = args.port
    try:
        _apply_base_url_arg(config, args)
    except config_mod.BaseUrlError as exc:
        print(f"base URL: {exc}", file=sys.stderr)
        return 1
    hostname = provision.tailscale_hostname()
    if hostname:
        config.hostname = hostname
    config_mod.save(root, config)

    print(f"state root      {root} (0700)")
    try:
        # Always pin the *resolved* root (CLI flag OR ambient PORCHD_STATE_ROOT),
        # never omit it — otherwise launchd starts in the default home root.
        result = provision.install_launch_agent(
            state_root=root,
            porch_config=_porch_config(),
        )
    except provision.LaunchAgentInstallError as exc:
        print(f"LaunchAgent     FAILED — {exc}")
        return 1
    if result.status == "declined":
        print(
            f"LaunchAgent     declined — leaving {result.path}; "
            "aborting setup (no pairing)"
        )
        return 1
    print(f"LaunchAgent     {result.path} (loaded, KeepAlive)")

    ok, message = provision.ensure_serve(config.port)
    print(f"tailscale serve {'ok' if ok else 'needs you'} — {message}")
    if hostname:
        print(f"hostname        {hostname}")
    else:
        print("hostname        unknown — is Tailscale running? Re-run setup once it is.")

    # Fail closed before minting any pairing token / QR when no usable pairing
    # HTTPS base is configured. Operator --base-url on setup (persisted before
    # install/reload) or an already-saved config base_url is the escape hatch —
    # not direct pair. Configuration only: nothing here probes the network.
    try:
        config_mod.resolve_pairing_base_url(config, serve_ok=ok)
    except config_mod.BaseUrlError as exc:
        print(f"pairing refused: {exc}", file=sys.stderr)
        return 1

    # Give the freshly loaded agent a moment before pairing against it.
    time.sleep(1.0)
    return cmd_pair(args)


def cmd_pair(args) -> int:
    """Print a pairing QR using the already-persisted config base.

    ``--base-url`` is setup-only: changing the base requires re-running setup
    so the daemon reloads allowlists. Direct pair never mutates config.json.
    """
    root = _root(args)
    config = config_mod.load(root)
    try:
        base = config_mod.resolve_pairing_base_url(config)
    except config_mod.BaseUrlError as exc:
        print(f"pairing refused: {exc}", file=sys.stderr)
        return 1
    token = devices.create_pairing_token(root)
    url = _pairing_url(base, token)
    print()
    print(provision.qr(url))
    print()
    print(provision.ADD_TO_HOME_SCREEN)
    print()
    print("This link is good for 2 minutes and one device.")
    return 0


def cmd_devices(args) -> int:
    root = _root(args)
    paired = devices.list_devices(root)
    if not paired:
        print("no paired devices — run `porch-mobile pair`")
        return 0
    for device in paired:
        seen = time.strftime("%Y-%m-%d %H:%M", time.localtime(device.last_seen))
        print(f"{device.label:<16} {device.device_id}  last seen {seen}")
    return 0


def cmd_revoke(args) -> int:
    removed = devices.revoke(_root(args), args.label)
    print(f"revoked {removed} device(s)" if removed else f"no device matching {args.label!r}")
    return 0 if removed else 1


def cmd_arm(args) -> int:
    root = _root(args)
    pc = _porch_config()
    from porch3.roomcheck import RoomInvariantError, apply_owner_crosscheck, assert_acting_room

    try:
        assert_acting_room(pc)
        pc = apply_owner_crosscheck(pc)
    except RoomInvariantError as exc:
        print(f"arm refused: room invariant: {exc}")
        return 1
    if pc.signing_disabled:
        print(
            f"arm refused: signing disabled — {pc.signing_disabled_reason}"
        )
        return 1
    ok, message = lease.arm(root, lease.parse_duration(args.duration), key=pc.key_file)
    print(message)
    if ok:
        print(_lease_line(root))
    return 0 if ok else 1


def cmd_lock(args) -> int:
    ok, message = lease.lock(_root(args))
    print(message)
    return 0 if ok else 1


def _lease_line(root: Path) -> str:
    status = lease.status(root)
    if not status["armed"]:
        return "signing: dark"
    if status["deadline"]:
        until = time.strftime("%H:%M", time.localtime(status["deadline"]))
        return f"signing: ARMED until {until}"
    return "signing: ARMED"


def cmd_status(args) -> int:
    root = _root(args)
    config = config_mod.load(root)
    print(f"url        {config.derived_base_url()}")
    print(f"port       {config.port} (loopback)")
    print(f"service    {'loaded' if provision.launch_agent_loaded() else 'not loaded'}")
    print(f"devices    {len(devices.list_devices(root))} paired")
    print(_lease_line(root))
    return 0


def _doctor_reachability_checks(
    config: config_mod.Config,
) -> list[tuple[bool, str]]:
    """Pairing-base + Tailscale diagnostics — offline, never a network probe.

    A validated operator ``base_url`` satisfies the configured-base check
    without Tailscale; Tailscale version is then informational/optional.
    On the default path, require hostname + local Serve wiring (not phone
    reachability), and treat Tailscale as required.
    """
    from porchd import toolprobe

    checks: list[tuple[bool, str]] = []
    override = config._validated_base()
    try:
        base = config_mod.resolve_pairing_base_url(config)
        if override:
            checks.append(
                (
                    True,
                    f"pairing HTTPS base configured (reachability not probed): {base}",
                )
            )
        else:
            checks.append(
                (
                    True,
                    "pairing HTTPS base via local Tailscale Serve wiring "
                    f"(phone reachability not probed): {base}",
                )
            )
    except config_mod.BaseUrlError as exc:
        checks.append(
            (
                False,
                f"pairing HTTPS base configured (reachability not probed): {exc}",
            )
        )

    ts_probe = toolprobe.probe_resolved_binary(
        provision.tailscale_bin(),
        name="tailscale",
        optional=bool(override),
    )
    checks.append((ts_probe.ok, ts_probe.label))
    return checks


def cmd_doctor(args) -> int:
    """Offline diagnostics: presence and shape, never a network probe."""
    root = _root(args)
    config = config_mod.load(root)
    checks: list[tuple[bool, str]] = []

    checks.append((root.is_dir(), f"state root exists: {root}"))
    checks.append((oct(root.stat().st_mode)[-3:] == "700" if root.is_dir() else False,
                   "state root is 0700"))
    from porchd import toolprobe

    checks.extend(_doctor_reachability_checks(config))
    checks.append((provision.launch_agent_path().exists(), "LaunchAgent plist installed"))
    checks.append((provision.launch_agent_loaded(), "LaunchAgent loaded"))
    checks.append((bool(devices.list_devices(root)), "at least one paired device"))
    pc = _porch_config()
    checks.append((pc.key_file.exists(), f"signing key present: {pc.key_file}"))
    checks.append((lease.socket_path(root) is not None, "signing agent socket recorded"))
    checks.append((lease.is_armed(root), "signing lease armed (optional)"))

    post_probe = toolprobe.probe_post()
    checks.append((post_probe.ok, post_probe.label))
    for tool in ("porch-verify", "ssh-add", "ssh-agent", "ssh-keygen"):
        probe = toolprobe.probe_named_tool(tool)
        checks.append((probe.ok, probe.label))
    qr = toolprobe.probe_named_tool("qrencode", optional=True)
    checks.append((qr.ok, qr.label))
    checks.append(((server.STATIC_DIR / "index.html").is_file(),
                   "web client assets present (static/index.html)"))

    failures = 0
    for ok, label in checks:
        print(f"{'ok  ' if ok else 'MISS'}  {label}")
        if not ok and "optional" not in label:
            failures += 1

    # Owner-field report + throwaway sign/verify (B0 onboarding).
    print()
    print("--- owner crosscheck ---")
    from porch3.roomcheck import RoomInvariantError, apply_owner_crosscheck, assert_acting_room

    try:
        assert_acting_room(pc)
        print(f"ok    acting room matches owner_room={pc.owner_room!r}")
    except RoomInvariantError as exc:
        print(f"MISS  acting room: {exc}")
        failures += 1

    try:
        checked = apply_owner_crosscheck(pc)
    except RoomInvariantError as exc:
        print(f"MISS  owner room: {exc}")
        failures += 1
        checked = pc
    else:
        if checked.signing_disabled:
            print(f"MISS  owner fields: {checked.signing_disabled_reason}")
            failures += 1
        else:
            print(
                f"ok    owner room={checked.owner_room} "
                f"marker={checked.marker} label={checked.label} "
                f"principal={checked.principal} ns={checked.signing_namespace}"
            )
            print(
                f"ok    sidecar={checked.sidecar_dir} "
                f"signers={checked.allowed_signers}"
            )

    print()
    print("--- throwaway sign/verify ---")
    ok_loop, detail = _throwaway_sign_verify(checked, state_root=root)
    print(f"{'ok  ' if ok_loop else 'MISS'}  {detail}")
    if not ok_loop:
        failures += 1

    print()
    print("doctor: all good" if not failures else f"doctor: {failures} thing(s) to fix")
    return 0 if not failures else 1


def _throwaway_sign_verify(pc, *, state_root: Path | None = None) -> tuple[bool, str]:
    """Sign and verify a disposable payload with the configured key material.

    Prefer an armed service agent (SSH_AUTH_SOCK) so passphrased keys work
    without an empty-stdin attempt; otherwise prompt securely when on a TTY.
    """
    import getpass
    import shutil
    import subprocess
    import sys
    import tempfile
    from pathlib import Path

    if pc.signing_disabled:
        return False, f"skipped: signing disabled ({pc.signing_disabled_reason})"
    if shutil.which("ssh-keygen") is None:
        return False, "ssh-keygen missing"
    pub = Path(str(pc.key_file) + ".pub")
    if not pc.key_file.is_file() or not pub.is_file():
        return False, f"key pair missing at {pc.key_file}"
    if not pc.allowed_signers.is_file():
        return False, f"allowed_signers missing at {pc.allowed_signers}"

    env = dict(__import__("os").environ)
    agent_env = None
    if state_root is not None:
        try:
            sock = lease.socket_path(state_root)
            if sock and lease.is_armed(state_root):
                agent_env = {**env, "SSH_AUTH_SOCK": str(sock)}
        except OSError:
            agent_env = None

    try:
        with tempfile.TemporaryDirectory(prefix="porch-doctor-") as tmp:
            payload = Path(tmp) / "payload.txt"
            payload.write_text("porch-doctor-throwaway\n", encoding="utf-8")
            sign_cmd = [
                "ssh-keygen",
                "-Y",
                "sign",
                "-f",
                str(pc.key_file),
                "-n",
                pc.signing_namespace,
                str(payload),
            ]
            # 1) Try empty passphrase (unencrypted keys).
            result = subprocess.run(
                sign_cmd,
                capture_output=True,
                timeout=15,
                input=b"\n",
                env=agent_env or env,
            )
            # 2) If that failed and we have an agent, retry under agent env only.
            if result.returncode != 0 and agent_env is not None:
                result = subprocess.run(
                    sign_cmd,
                    capture_output=True,
                    timeout=15,
                    env=agent_env,
                )
            # 3) Interactive passphrase via SSH_ASKPASS — never -P on argv.
            if result.returncode != 0 and sys.stdin.isatty():
                try:
                    phrase = getpass.getpass(
                        "doctor throwaway: key passphrase: "
                    )
                except (EOFError, KeyboardInterrupt):
                    phrase = ""
                if phrase:
                    from porch3.initcli import _ssh_askpass_env

                    with _ssh_askpass_env(phrase) as ask_env:
                        result = subprocess.run(
                            sign_cmd,
                            capture_output=True,
                            timeout=15,
                            env=ask_env,
                            stdin=subprocess.DEVNULL,
                        )
            if result.returncode != 0:
                err = (result.stderr or result.stdout or b"").decode(
                    "utf-8", "replace"
                )
                return False, f"throwaway sign failed: {err.strip()[:200]}"
            sig = Path(str(payload) + ".sig")
            if not sig.is_file():
                return False, "throwaway sign produced no .sig"
            verify = subprocess.run(
                [
                    "ssh-keygen",
                    "-Y",
                    "verify",
                    "-f",
                    str(pc.allowed_signers),
                    "-I",
                    pc.principal,
                    "-n",
                    pc.signing_namespace,
                    "-s",
                    str(sig),
                ],
                input=payload.read_bytes(),
                capture_output=True,
                timeout=15,
            )
            if verify.returncode != 0:
                return False, "throwaway verify failed"
            return True, "throwaway sign/verify ok"
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"throwaway sign/verify error: {exc}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="porch-mobile", description="porch mobile companion server")
    parser.add_argument("--state-root", default=None, help=f"default: {default_root()}")
    sub = parser.add_subparsers(dest="cmd", required=True)

    setup = sub.add_parser("setup", help="one-time setup, then pair (idempotent)")
    setup.add_argument("--port", type=int, default=None)
    setup.add_argument(
        "--base-url",
        default=None,
        help="operator HTTPS base for pairing QR (escape hatch when Serve is unavailable)",
    )
    setup.set_defaults(func=cmd_setup)

    sub.add_parser("run", help="run the server in the foreground").set_defaults(func=cmd_run)
    pair = sub.add_parser(
        "pair",
        help="print a pairing QR (uses persisted base; change base via setup --base-url)",
    )
    pair.set_defaults(func=cmd_pair)
    sub.add_parser("devices", help="list paired devices").set_defaults(func=cmd_devices)

    revoke = sub.add_parser("revoke", help="revoke a device by label or id")
    revoke.add_argument("label")
    revoke.set_defaults(func=cmd_revoke)

    arm = sub.add_parser("arm", help="arm the signing lease (8h default, 24h max)")
    arm.add_argument("duration", nargs="?", default=None, help="e.g. 8h, 45m, 3600")
    arm.set_defaults(func=cmd_arm)

    sub.add_parser("lock", help="lock signing immediately").set_defaults(func=cmd_lock)
    sub.add_parser("status", help="url, service, devices, lease").set_defaults(func=cmd_status)
    sub.add_parser("doctor", help="offline diagnostics").set_defaults(func=cmd_doctor)
    return parser


def main(argv: list[str] | None = None) -> int:
    require_macos()
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
