"""Daemon pin, legacy LaunchAgent offer, doctor throwaway loop."""

from __future__ import annotations

import plistlib
from pathlib import Path

import pytest

from helpers import make_porch_config
from porch3.config import emit_toml, load_config
from porchd import config as config_mod
from porchd import provision
from porchd.cli import _doctor_reachability_checks, _throwaway_sign_verify


def test_load_config_preserves_source_path(tmp_path):
    import os

    cfg = make_porch_config(tmp_path, owner_room="mara")
    path = tmp_path / "alt" / "config.toml"
    path.parent.mkdir()
    path.write_text(emit_toml(cfg))
    loaded = load_config(path, env={})
    assert loaded.source_path == Path(os.path.abspath(path))


def test_launch_agent_plist_pins_loaded_source_path(tmp_path):
    import os

    cfg = make_porch_config(tmp_path, owner_room="mara")
    path = tmp_path / "override.toml"
    path.write_text(emit_toml(cfg))
    loaded = load_config(path, env={})
    plist = provision.launch_agent_plist(porch_config=loaded)
    env = plist["EnvironmentVariables"]
    assert env["PORCH_CONFIG"] == str(Path(os.path.abspath(path)))
    assert env["POST_MAIL_ROOT"] == str(loaded.mail_root)
    # Must not silently fall back to the global default when source_path is set.
    from porch3.config import CONFIG_PATH

    assert env["PORCH_CONFIG"] != str(CONFIG_PATH) or Path(
        os.path.abspath(path)
    ) == CONFIG_PATH


def test_launch_agent_plist_explicit_path_wins(tmp_path):
    cfg = make_porch_config(tmp_path, owner_room="mara")
    explicit = tmp_path / "explicit.toml"
    plist = provision.launch_agent_plist(
        porch_config=cfg, porch_config_path=explicit
    )
    assert plist["EnvironmentVariables"]["PORCH_CONFIG"] == str(explicit)


def test_legacy_launch_agent_offers_not_auto_unloads(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.plist"
    legacy.write_bytes(b"legacy")
    new_path = tmp_path / "new.plist"
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: legacy)
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")
    unloads: list[str] = []

    def fake_run(cmd, **kwargs):
        if cmd[:2] == ["launchctl", "unload"]:
            unloads.append(cmd[2])

        class R:
            returncode = 0

        return R()

    monkeypatch.setattr(provision.subprocess, "run", fake_run)
    # Decline the offer — legacy must remain; new agent must NOT install.
    result = provision.install_launch_agent(
        porch_config=make_porch_config(tmp_path / "a"),
        replace_legacy=False,
    )
    assert result.status == "declined"
    assert result.path == legacy
    assert legacy.exists()
    assert str(legacy) not in unloads
    assert not new_path.exists()

    # Accept the offer — legacy unloaded+unlinked.
    legacy.write_bytes(b"legacy")
    result = provision.install_launch_agent(
        porch_config=make_porch_config(tmp_path / "b"),
        replace_legacy=True,
    )
    assert result.status == "installed"
    assert result.path == new_path
    assert not legacy.exists()
    assert any(str(legacy) == u for u in unloads)
    assert new_path.exists()


def test_install_launch_agent_raises_when_launchctl_load_fails(tmp_path, monkeypatch):
    """Item 23: a failed `launchctl load` must not be reported as loaded."""
    new_path = tmp_path / "new.plist"
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: tmp_path / "no-legacy.plist")
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""

        r = R()
        if cmd[:2] == ["launchctl", "load"]:
            r.returncode = 1
            r.stderr = b"could not find service"
        return r

    monkeypatch.setattr(provision.subprocess, "run", fake_run)
    with pytest.raises(provision.LaunchAgentInstallError, match="launchctl load failed"):
        provision.install_launch_agent(porch_config=make_porch_config(tmp_path / "c"))
    # The plist itself was written; only the "it's loaded" claim is refused.
    assert new_path.exists()


def test_launch_agent_pins_resolved_state_root(tmp_path):
    """Ambient/resolved state root must always appear in the plist env."""
    root = tmp_path / "relocated-state"
    root.mkdir()
    cfg = make_porch_config(tmp_path, owner_room="mara")
    plist = provision.launch_agent_plist(state_root=root, porch_config=cfg)
    assert plist["EnvironmentVariables"]["PORCHD_STATE_ROOT"] == str(root)


def test_declined_setup_aborts_without_pairing(tmp_path, monkeypatch):
    """cmd_setup must not pair when legacy install is declined."""
    from porchd import cli as porchd_cli

    legacy = tmp_path / "legacy.plist"
    legacy.write_bytes(b"legacy")
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: legacy)
    monkeypatch.setattr(
        provision, "launch_agent_path", lambda label=None: tmp_path / "new.plist"
    )
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(porchd_cli, "_root", lambda args: tmp_path / "state")
    monkeypatch.setattr(
        porchd_cli.config_mod,
        "load",
        lambda root: type("C", (), {"port": 8741, "hostname": None})(),
    )
    monkeypatch.setattr(porchd_cli.config_mod, "save", lambda root, cfg: None)
    monkeypatch.setattr(provision, "tailscale_hostname", lambda: None)
    monkeypatch.setattr(porchd_cli, "_porch_config", lambda: make_porch_config(tmp_path))
    paired = {"n": 0}

    def boom(args):
        paired["n"] += 1
        return 0

    monkeypatch.setattr(porchd_cli, "cmd_pair", boom)
    args = type("A", (), {"state_root": None, "port": None, "base_url": None})()
    # install declines via replace_legacy=False path — force via monkeypatch.
    monkeypatch.setattr(
        provision,
        "install_launch_agent",
        lambda **kw: provision.LaunchAgentResult("declined", legacy),
    )
    rc = porchd_cli.cmd_setup(args)
    assert rc == 1
    assert paired["n"] == 0


def test_legacy_unload_failure_retains_legacy(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.plist"
    legacy.write_bytes(b"legacy")
    new_path = tmp_path / "new.plist"
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: legacy)
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 1 if cmd[:2] == ["launchctl", "unload"] else 0
            stdout = b""
            stderr = b"unload refused"

        return R()

    monkeypatch.setattr(provision.subprocess, "run", fake_run)
    with pytest.raises(provision.LaunchAgentInstallError, match="unload failed"):
        provision.install_launch_agent(
            porch_config=make_porch_config(tmp_path / "d"),
            replace_legacy=True,
        )
    assert legacy.exists()
    assert not new_path.exists()


def test_legacy_unlink_failure_reloads_legacy(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.plist"
    legacy.write_bytes(b"legacy")
    new_path = tmp_path / "new.plist"
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: legacy)
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")
    loads: list[str] = []

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""

        if cmd[:2] == ["launchctl", "load"]:
            loads.append(cmd[2])
        return R()

    monkeypatch.setattr(provision.subprocess, "run", fake_run)
    real_unlink = Path.unlink

    def gated_unlink(self, *a, **k):
        if self == legacy:
            raise OSError("busy")
        return real_unlink(self, *a, **k)

    monkeypatch.setattr(Path, "unlink", gated_unlink)
    with pytest.raises(provision.LaunchAgentInstallError, match="unlink failed"):
        provision.install_launch_agent(
            porch_config=make_porch_config(tmp_path / "e"),
            replace_legacy=True,
        )
    assert legacy.exists()
    assert not new_path.exists()
    assert any(str(legacy) == u for u in loads)


def test_legacy_new_load_failure_restores_legacy(tmp_path, monkeypatch):
    legacy = tmp_path / "legacy.plist"
    legacy.write_bytes(b"legacy-bytes")
    new_path = tmp_path / "new.plist"
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: legacy)
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")
    loads: list[str] = []

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""

        r = R()
        if cmd[:2] == ["launchctl", "load"]:
            loads.append(cmd[2])
            if cmd[2] == str(new_path):
                r.returncode = 1
                r.stderr = b"load refused"
        return r

    monkeypatch.setattr(provision.subprocess, "run", fake_run)
    with pytest.raises(provision.LaunchAgentInstallError, match="load failed"):
        provision.install_launch_agent(
            porch_config=make_porch_config(tmp_path / "f"),
            replace_legacy=True,
        )
    assert legacy.exists()
    assert legacy.read_bytes() == b"legacy-bytes"
    assert any(str(legacy) == u for u in loads)


def test_target_symlink_refused(tmp_path, monkeypatch):
    new_path = tmp_path / "new.plist"
    target = tmp_path / "elsewhere.plist"
    target.write_bytes(b"prior")
    new_path.symlink_to(target)
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: tmp_path / "no-legacy.plist")
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")
    monkeypatch.setattr(
        provision.subprocess,
        "run",
        lambda *a, **k: type("R", (), {"returncode": 0, "stdout": b"", "stderr": b""})(),
    )
    with pytest.raises(provision.LaunchAgentInstallError, match="regular|symlink"):
        provision.install_launch_agent(porch_config=make_porch_config(tmp_path / "g"))
    assert target.read_bytes() == b"prior"


def test_target_symlink_with_legacy_reload_failure_compounds(tmp_path, monkeypatch):
    """Item 4: planted target symlink + legacy reload rc1 names BOTH failures."""
    legacy = tmp_path / "legacy.plist"
    legacy.write_bytes(b"legacy-bytes")
    new_path = tmp_path / "new.plist"
    target = tmp_path / "elsewhere.plist"
    target.write_bytes(b"prior")
    new_path.symlink_to(target)
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: legacy)
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""

        r = R()
        if cmd[:2] == ["launchctl", "load"] and cmd[2] == str(legacy):
            r.returncode = 1
            r.stderr = b"legacy reload refused"
        return r

    monkeypatch.setattr(provision.subprocess, "run", fake_run)
    with pytest.raises(provision.LaunchAgentInstallError) as ei:
        provision.install_launch_agent(
            porch_config=make_porch_config(tmp_path / "g2"),
            replace_legacy=True,
        )
    msg = str(ei.value)
    assert "regular" in msg or "symlink" in msg
    assert "launchctl load failed" in msg
    assert "legacy reload refused" in msg or "rc=1" in msg
    assert legacy.exists()
    assert legacy.read_bytes() == b"legacy-bytes"


def test_restore_failure_does_not_load_unrestored_path(tmp_path, monkeypatch):
    """Item 4 sibling: after restore fails, do not launchctl-load that path."""
    legacy = tmp_path / "legacy.plist"
    legacy.write_bytes(b"legacy-bytes")
    new_path = tmp_path / "new.plist"
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: legacy)
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")
    loads: list[str] = []

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""

        if cmd[:2] == ["launchctl", "load"]:
            loads.append(cmd[2])
        return R()

    monkeypatch.setattr(provision.subprocess, "run", fake_run)

    def boom_write(path, data):
        raise OSError("restore refused")

    monkeypatch.setattr(provision, "_atomic_write_plist", boom_write)
    # Force the unlink-failure rollback path which must restore+load.
    real_unlink = Path.unlink

    def gated_unlink(self, *a, **k):
        if self == legacy:
            raise OSError("busy")
        return real_unlink(self, *a, **k)

    monkeypatch.setattr(Path, "unlink", gated_unlink)
    with pytest.raises(provision.LaunchAgentInstallError) as ei:
        provision.install_launch_agent(
            porch_config=make_porch_config(tmp_path / "e2"),
            replace_legacy=True,
        )
    msg = str(ei.value)
    assert "unlink failed" in msg
    assert "restore" in msg and "failed" in msg
    assert str(legacy) not in loads  # must not load after restore failure


def test_plist_read_io_errors_map_to_install_error(tmp_path, monkeypatch):
    """Item 5: fstat/read/close failures become LaunchAgentInstallError."""
    path = tmp_path / "agent.plist"
    path.write_bytes(b"plist-bytes")
    real_open = provision.os.open
    real_read = provision.os.read
    target = {"fd": None}

    def spy_open(name, *args, **kwargs):
        fd = real_open(name, *args, **kwargs)
        if Path(str(name)) == path:
            target["fd"] = fd
        return fd

    def boom_read(fd, *args, **kwargs):
        if target["fd"] is not None and fd == target["fd"]:
            raise OSError("injected read EIO")
        return real_read(fd, *args, **kwargs)

    monkeypatch.setattr(provision.os, "open", spy_open)
    monkeypatch.setattr(provision.os, "read", boom_read)
    with pytest.raises(provision.LaunchAgentInstallError, match="cannot read"):
        provision._read_regular_plist_bytes(path)


def test_plist_close_error_does_not_override_prior_read_error(tmp_path, monkeypatch):
    path = tmp_path / "agent.plist"
    path.write_bytes(b"plist-bytes")
    real_open = provision.os.open
    real_read = provision.os.read
    real_close = provision.os.close
    target = {"fd": None}

    def spy_open(name, *args, **kwargs):
        fd = real_open(name, *args, **kwargs)
        if Path(str(name)) == path:
            target["fd"] = fd
        return fd

    def boom_read(fd, *args, **kwargs):
        if target["fd"] is not None and fd == target["fd"]:
            raise OSError("injected read failure")
        return real_read(fd, *args, **kwargs)

    def boom_close(fd):
        if target["fd"] is not None and fd == target["fd"]:
            raise OSError("injected close failure")
        return real_close(fd)

    monkeypatch.setattr(provision.os, "open", spy_open)
    monkeypatch.setattr(provision.os, "read", boom_read)
    monkeypatch.setattr(provision.os, "close", boom_close)
    with pytest.raises(provision.LaunchAgentInstallError, match="cannot read") as ei:
        provision._read_regular_plist_bytes(path)
    assert str(ei.value).startswith("cannot read")
    assert "cannot close" not in str(ei.value)


def test_target_load_failure_restores_prior(tmp_path, monkeypatch):
    new_path = tmp_path / "new.plist"
    new_path.write_bytes(b"prior-working")
    monkeypatch.setattr(provision, "legacy_launch_agent_path", lambda: tmp_path / "no-legacy.plist")
    monkeypatch.setattr(provision, "launch_agent_path", lambda label=None: new_path)
    monkeypatch.setattr(provision, "log_dir", lambda: tmp_path / "logs")

    def fake_run(cmd, **kwargs):
        class R:
            returncode = 0
            stdout = b""
            stderr = b""

        r = R()
        if cmd[:2] == ["launchctl", "load"]:
            r.returncode = 1
            r.stderr = b"load refused"
        return r

    monkeypatch.setattr(provision.subprocess, "run", fake_run)
    with pytest.raises(provision.LaunchAgentInstallError, match="load failed"):
        provision.install_launch_agent(porch_config=make_porch_config(tmp_path / "h"))
    assert new_path.read_bytes() == b"prior-working"


def test_restore_then_load_spawn_exception_compounds_prior(tmp_path, monkeypatch):
    """Round 8: spawn/IO from launchctl load compounds with prior_errors."""
    plist = tmp_path / "agent.plist"
    plist.write_bytes(b"restored-bytes")
    prior = "target load failed: refused"

    def boom_launchctl(verb, path):
        raise OSError("spawn EIO")

    monkeypatch.setattr(provision, "_launchctl", boom_launchctl)
    with pytest.raises(provision.LaunchAgentInstallError) as ei:
        provision._restore_then_load(
            plist,
            prior_errors=[prior],
            bytes_to_restore=b"restored-bytes",
        )
    msg = str(ei.value)
    assert type(ei.value).__name__ == "LaunchAgentInstallError"
    assert "spawn EIO" in msg
    assert prior in msg or "target load failed" in msg
    assert plist.read_bytes() == b"restored-bytes"


def test_doctor_reachability_override_without_tailscale_passes(monkeypatch):
    """Operator HTTPS base is configured (not probed); Tailscale is optional."""
    monkeypatch.setattr(provision, "tailscale_bin", lambda: None)
    monkeypatch.setattr(provision, "serve_configured", lambda port: False)
    cfg = config_mod.Config(
        port=8765, hostname="", base_url="https://escape.example.ts.net"
    )
    checks = _doctor_reachability_checks(cfg)
    by_label = {label: ok for ok, label in checks}
    assert any(
        ok
        and label.startswith(
            "pairing HTTPS base configured (reachability not probed): "
            "https://escape.example.ts.net"
        )
        for ok, label in checks
    )
    assert by_label.get("tailscale present (optional)") is False
    # Optional MISS must not count toward doctor failures (same rule as qrencode).
    failures = sum(1 for ok, label in checks if not ok and "optional" not in label)
    assert failures == 0


def test_doctor_reachability_default_path_fails_without_tailscale(monkeypatch):
    """No override: missing Tailscale fails the configured-base diagnostic."""
    monkeypatch.setattr(provision, "tailscale_bin", lambda: None)
    monkeypatch.setattr(provision, "serve_configured", lambda port: False)
    cfg = config_mod.Config(port=8765, hostname="", base_url="")
    checks = _doctor_reachability_checks(cfg)
    reach = [
        (ok, label)
        for ok, label in checks
        if label.startswith("pairing HTTPS base configured (reachability not probed):")
    ]
    assert len(reach) == 1
    assert reach[0][0] is False
    ts = [(ok, label) for ok, label in checks if "tailscale" in label]
    assert len(ts) == 1
    assert ts[0][0] is False
    assert "optional" not in ts[0][1]
    failures = sum(1 for ok, label in checks if not ok and "optional" not in label)
    assert failures >= 2


def test_doctor_reachability_default_path_ok_with_hostname_and_serve(monkeypatch):
    monkeypatch.setattr(provision, "tailscale_bin", lambda: "/usr/bin/tailscale")
    monkeypatch.setattr(provision, "serve_configured", lambda port: True)

    class FakeProbe:
        ok = True
        label = "1.68.0"

    monkeypatch.setattr(
        "porchd.toolprobe.probe_resolved_binary",
        lambda path, *, name, optional=False: FakeProbe(),
    )
    cfg = config_mod.Config(port=8765, hostname="mac.example.ts.net", base_url="")
    checks = _doctor_reachability_checks(cfg)
    assert any(
        ok
        and label.startswith(
            "pairing HTTPS base via local Tailscale Serve wiring "
            "(phone reachability not probed): https://mac.example.ts.net"
        )
        for ok, label in checks
    )
    failures = sum(1 for ok, label in checks if not ok and "optional" not in label)
    assert failures == 0


def test_throwaway_sign_verify_round_trip(tmp_path):
    """Generate a real keypair under tmp and prove the doctor loop."""
    import subprocess

    cfg = make_porch_config(tmp_path, owner_room="mara", marker="🦊", label="Mara")
    cfg.key_file.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ssh-keygen",
            "-t",
            "ed25519",
            "-f",
            str(cfg.key_file),
            "-N",
            "",
            "-C",
            cfg.principal,
            "-q",
        ],
        check=True,
    )
    pub = Path(str(cfg.key_file) + ".pub").read_text().split()
    line = (
        f'{cfg.principal} namespaces="{cfg.signing_namespace}" '
        f"{pub[0]} {pub[1]}\n"
    )
    cfg.allowed_signers.write_text(line)
    ok, detail = _throwaway_sign_verify(cfg)
    assert ok, detail


def test_throwaway_skipped_when_signing_disabled(tmp_path):
    cfg = make_porch_config(tmp_path).with_signing_disabled("boom")
    ok, detail = _throwaway_sign_verify(cfg)
    assert not ok
    assert "disabled" in detail


def test_throwaway_sign_verify_uses_the_armed_service_agent_for_an_encrypted_key(
    tmp_path,
):
    """Regression (item 23): a passphrased key must route through the armed
    service agent, not an empty-passphrase stdin attempt that always fails
    for a real passphrase."""
    import os
    import subprocess

    from porchd import lease

    cfg = make_porch_config(tmp_path, owner_room="mara", marker="🦊", label="Mara")
    cfg.key_file.parent.mkdir(parents=True, exist_ok=True)
    passphrase = "s3cret-throwaway"
    subprocess.run(
        [
            "ssh-keygen", "-t", "ed25519", "-f", str(cfg.key_file),
            "-N", passphrase, "-C", cfg.principal, "-q",
        ],
        check=True,
    )
    pub = Path(str(cfg.key_file) + ".pub").read_text().split()
    cfg.allowed_signers.write_text(
        f'{cfg.principal} namespaces="{cfg.signing_namespace}" {pub[0]} {pub[1]}\n'
    )

    # macOS bounds AF_UNIX socket paths (~104 bytes); pytest's nested
    # tmp_path is too deep for ssh-agent's own socket, so use a short-lived
    # dir directly under /tmp (never $HOME) just for the agent socket.
    import tempfile

    state_root = Path(tempfile.mkdtemp(prefix="porch-lease-", dir="/tmp"))
    agent = lease.Agent(state_root)
    agent.start()
    try:
        askpass = tmp_path / "askpass.sh"
        askpass.write_text(f"#!/bin/sh\necho {passphrase}\n")
        askpass.chmod(0o700)
        add_env = {
            **os.environ,
            "SSH_AUTH_SOCK": str(agent.socket),
            "SSH_ASKPASS": str(askpass),
            "SSH_ASKPASS_REQUIRE": "force",
        }
        added = subprocess.run(
            ["ssh-add", str(cfg.key_file)],
            env=add_env,
            capture_output=True,
            stdin=subprocess.DEVNULL,
        )
        assert added.returncode == 0, added.stderr

        # Without the agent, the empty-passphrase attempt must fail closed —
        # proving the round trip below is genuinely exercising the agent path.
        ok_no_agent, detail_no_agent = _throwaway_sign_verify(cfg, state_root=None)
        assert not ok_no_agent, detail_no_agent

        ok, detail = _throwaway_sign_verify(cfg, state_root=state_root)
        assert ok, detail
    finally:
        agent.stop()
        import shutil

        shutil.rmtree(state_root, ignore_errors=True)
