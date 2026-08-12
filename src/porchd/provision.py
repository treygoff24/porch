"""Operator UX plumbing (§10): LaunchAgent, Tailscale Serve, QR codes.

Everything here degrades politely. A missing `qrencode` prints a URL; a
Serve command that needs the operator's own hands is printed rather than
half-run, because a flow that silently fails is worse than one that says
what to type.

``PORCH_CONFIG`` in the LaunchAgent environment pins the resolved config
source path (not merely the global default) so an override cannot split
TUI vs daemon identity.
"""

from __future__ import annotations

import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

LABEL = "dev.porch.porchd"
LEGACY_LABEL = "com.treygoff.porchd"  # legacy-migration: unload and replace the prior label


@dataclass(frozen=True)
class LaunchAgentResult:
    """Explicit install outcome — callers must not assume loaded on decline."""

    status: Literal["installed", "declined"]
    path: Path


class LaunchAgentInstallError(RuntimeError):
    """Unload/unlink/load failure — legacy retained when applicable."""


def launch_agent_path(label: str = LABEL) -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"


def legacy_launch_agent_path() -> Path:
    return launch_agent_path(LEGACY_LABEL)


def log_dir() -> Path:
    return Path.home() / "Library" / "Logs"


def launch_agent_plist(
    *,
    python: str | None = None,
    state_root: Path | None = None,
    porch_config=None,
    porch_config_path: Path | None = None,
) -> dict:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/local/bin")}
    if state_root is not None:
        env["PORCHD_STATE_ROOT"] = str(state_root)
    if porch_config is not None:
        env["POST_MAIL_ROOT"] = str(porch_config.mail_root)
        # Pin the actual loaded source path (B0); fall back to CONFIG_PATH only
        # when the config was built in-memory without a file.
        from porch3.config import CONFIG_PATH

        pin = porch_config_path
        if pin is None:
            pin = getattr(porch_config, "source_path", None) or CONFIG_PATH
        env["PORCH_CONFIG"] = str(pin)
    elif porch_config_path is not None:
        env["PORCH_CONFIG"] = str(porch_config_path)
    return {
        "Label": LABEL,
        "ProgramArguments": [python or sys.executable, "-m", "porchd", "run"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "EnvironmentVariables": env,
        "StandardOutPath": str(log_dir() / "porchd.log"),
        "StandardErrorPath": str(log_dir() / "porchd.err.log"),
    }


def _read_regular_plist_bytes(path: Path) -> bytes:
    """Read a LaunchAgent plist without following a final-component symlink.

    All open/fstat/read/close failures become ``LaunchAgentInstallError``;
    close errors never override a prior failure.
    """
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = -1
    pending: BaseException | None = None
    result: bytes | None = None
    try:
        try:
            fd = os.open(path, flags)
        except FileNotFoundError:
            raise
        except OSError as exc:
            raise LaunchAgentInstallError(
                f"LaunchAgent path {path} is unreadable/non-followable: {exc}"
            ) from exc
        try:
            st = os.fstat(fd)
        except OSError as exc:
            raise LaunchAgentInstallError(
                f"cannot fstat LaunchAgent plist {path}: {exc}"
            ) from exc
        if not stat.S_ISREG(st.st_mode):
            raise LaunchAgentInstallError(
                f"LaunchAgent path {path} must be a regular file "
                "(symlink/special refused)"
            )
        chunks: list[bytes] = []
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError as exc:
                raise LaunchAgentInstallError(
                    f"cannot read LaunchAgent plist {path}: {exc}"
                ) from exc
            if not chunk:
                break
            chunks.append(chunk)
            if sum(len(c) for c in chunks) > 1 << 20:
                raise LaunchAgentInstallError(
                    f"LaunchAgent plist {path} exceeds 1 MiB"
                )
        result = b"".join(chunks)
    except BaseException as exc:
        pending = exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError as exc:
                if pending is None:
                    pending = LaunchAgentInstallError(
                        f"cannot close LaunchAgent plist {path}: {exc}"
                    )
                    pending.__cause__ = exc
    if pending is not None:
        raise pending
    assert result is not None
    return result


def _atomic_write_plist(path: Path, data: bytes) -> None:
    """Refuse symlink/nonregular target; write private temp + atomic replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        st = None
    if st is not None:
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise LaunchAgentInstallError(
                f"LaunchAgent path {path} is not a regular file "
                "(symlink/special refused)"
            )
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        written = 0
        view = memoryview(data)
        while written < len(data):
            n = os.write(fd, view[written:])
            if n <= 0:
                raise OSError("short write")
            written += n
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
        tmp_name = ""
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass


def _launchctl(verb: str, plist: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["launchctl", verb, str(plist)], capture_output=True
    )


def _restore_then_load(
    plist: Path, *, prior_errors: list[str], bytes_to_restore: bytes | None = None
) -> None:
    """Strict rollback: restore must succeed before load; compound ALL failures.

    Never loads an unrestored path after a restore failure, and never discards
    a restore/load failure just because a later load returned 0.
    """
    errors = [e for e in prior_errors if e]
    if bytes_to_restore is not None:
        try:
            _atomic_write_plist(plist, bytes_to_restore)
        except Exception as exc:  # noqa: BLE001 — collect for compound
            errors.append(f"restore {plist} failed: {exc}")
            raise LaunchAgentInstallError(" — ".join(errors)) from exc
    try:
        load = _launchctl("load", plist)
    except (OSError, subprocess.SubprocessError) as exc:
        errors.append(f"launchctl load failed for {plist}: {exc}")
        raise LaunchAgentInstallError(" — ".join(errors)) from exc
    if load.returncode != 0:
        err = (load.stderr or load.stdout or b"").decode("utf-8", "replace")
        errors.append(
            f"launchctl load failed for {plist} (rc={load.returncode}): "
            f"{err.strip()}"
        )
        raise LaunchAgentInstallError(" — ".join(errors))
    if not errors:
        return
    raise LaunchAgentInstallError(" — ".join(errors))


def _reload_or_compound(
    plist: Path, *, prior_error: str, bytes_to_restore: bytes | None = None
) -> None:
    """Compat wrapper — prefer ``_restore_then_load`` at new call sites."""
    _restore_then_load(
        plist, prior_errors=[prior_error], bytes_to_restore=bytes_to_restore
    )


def install_launch_agent(
    *,
    python: str | None = None,
    state_root: Path | None = None,
    porch_config=None,
    porch_config_path: Path | None = None,
    replace_legacy: bool | None = None,
    input_fn: Callable[[str], str] | None = None,
) -> LaunchAgentResult:
    # Migration: legacy label on this machine → OFFER unload+replace (B0).
    legacy = legacy_launch_agent_path()
    legacy_bytes: bytes | None = None
    legacy_removed = False
    if legacy.exists() or legacy.is_symlink():
        do_replace = replace_legacy
        if do_replace is None:
            ask = input_fn or input
            try:
                ans = ask(
                    f"legacy LaunchAgent {LEGACY_LABEL} detected — "
                    f"unload and replace with {LABEL}? [y/N] "
                )
            except EOFError:
                ans = "n"
            do_replace = ans.strip().lower() in {"y", "yes"}
        if not do_replace:
            print(
                f"note: leaving legacy LaunchAgent {LEGACY_LABEL} in place; "
                f"aborting install of {LABEL}",
                file=sys.stderr,
            )
            return LaunchAgentResult(status="declined", path=legacy)
        print(
            f"note: unloading legacy LaunchAgent {LEGACY_LABEL}",
            file=sys.stderr,
        )
        try:
            legacy_bytes = _read_regular_plist_bytes(legacy)
        except FileNotFoundError:
            legacy_bytes = None
        unload = _launchctl("unload", legacy)
        if unload.returncode != 0:
            err = (unload.stderr or unload.stdout or b"").decode(
                "utf-8", "replace"
            )
            raise LaunchAgentInstallError(
                f"legacy LaunchAgent unload failed for {LEGACY_LABEL} "
                f"(rc={unload.returncode}): {err.strip()} — retaining {legacy}"
            )
        try:
            legacy.unlink()
            legacy_removed = True
        except OSError as exc:
            _restore_then_load(
                legacy,
                prior_errors=[
                    f"legacy LaunchAgent unlink failed for {legacy}: {exc} — "
                    f"retaining legacy; refusing to install {LABEL}"
                ],
                bytes_to_restore=legacy_bytes,
            )

    path = launch_agent_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    log_dir().mkdir(parents=True, exist_ok=True)

    prior_bytes: bytes | None = None
    try:
        prior_bytes = _read_regular_plist_bytes(path)
    except FileNotFoundError:
        prior_bytes = None
    except LaunchAgentInstallError as exc:
        # Symlink/nonregular target — refuse before destroying anything.
        # Restore+reload legacy strictly; compound every failure into the raise.
        if legacy_removed and legacy_bytes is not None:
            _restore_then_load(
                legacy,
                prior_errors=[str(exc)],
                bytes_to_restore=legacy_bytes,
            )
        raise

    new_bytes = plistlib.dumps(
        launch_agent_plist(
            python=python,
            state_root=state_root,
            porch_config=porch_config,
            porch_config_path=porch_config_path,
        )
    )
    try:
        _atomic_write_plist(path, new_bytes)
    except Exception as exc:
        if legacy_removed and legacy_bytes is not None:
            _restore_then_load(
                legacy,
                prior_errors=[f"target LaunchAgent write failed: {exc}"],
                bytes_to_restore=legacy_bytes,
            )
        raise LaunchAgentInstallError(
            f"target LaunchAgent write failed for {path}: {exc}"
        ) from exc

    _launchctl("unload", path)
    load = _launchctl("load", path)
    if load.returncode != 0:
        err = (load.stderr or b"").decode("utf-8", "replace")
        prior = (
            f"launchctl load failed for {LABEL} (rc={load.returncode}): "
            f"{err.strip()}"
        )
        # Prefer restoring the previous target plist when we displaced one;
        # otherwise restore the legacy job we removed.
        if prior_bytes is not None:
            try:
                _atomic_write_plist(path, prior_bytes)
            except Exception as exc:
                prior = f"{prior} — rollback restore failed: {exc}"
                if legacy_removed and legacy_bytes is not None:
                    _restore_then_load(
                        legacy,
                        prior_errors=[prior],
                        bytes_to_restore=legacy_bytes,
                    )
                raise LaunchAgentInstallError(prior) from exc
            reload = _launchctl("load", path)
            if reload.returncode != 0:
                rerr = (reload.stderr or b"").decode("utf-8", "replace")
                prior = (
                    f"{prior} — rollback load also failed "
                    f"(rc={reload.returncode}): {rerr.strip()}"
                )
                if legacy_removed and legacy_bytes is not None:
                    _restore_then_load(
                        legacy,
                        prior_errors=[prior],
                        bytes_to_restore=legacy_bytes,
                    )
                raise LaunchAgentInstallError(prior)
            raise LaunchAgentInstallError(prior)
        if legacy_removed and legacy_bytes is not None:
            _restore_then_load(
                legacy,
                prior_errors=[prior],
                bytes_to_restore=legacy_bytes,
            )
        raise LaunchAgentInstallError(prior)
    return LaunchAgentResult(status="installed", path=path)


def launch_agent_loaded() -> bool:
    result = subprocess.run(["launchctl", "list", LABEL], capture_output=True)
    return result.returncode == 0


def tailscale_bin() -> str | None:
    for candidate in ("tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"):
        found = shutil.which(candidate) if "/" not in candidate else (
            candidate if Path(candidate).exists() else None
        )
        if found:
            return found
    return None


def tailscale_hostname() -> str | None:
    binary = tailscale_bin()
    if binary is None:
        return None
    try:
        result = subprocess.run(
            [binary, "status", "--json"], capture_output=True, text=True, timeout=10
        )
        data = json.loads(result.stdout or "{}")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    name = ((data.get("Self") or {}).get("DNSName") or "").rstrip(".")
    return name or None


def serve_command(port: int) -> list[str]:
    return [tailscale_bin() or "tailscale", "serve", "--bg", "--https=443",
            f"http://127.0.0.1:{port}"]


def serve_status() -> dict | None:
    binary = tailscale_bin()
    if binary is None:
        return None
    try:
        result = subprocess.run(
            [binary, "serve", "status", "--json"], capture_output=True, text=True, timeout=10
        )
        return json.loads(result.stdout or "{}")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def serve_configured(port: int) -> bool:
    status = serve_status()
    return bool(status) and f"127.0.0.1:{port}" in json.dumps(status)


def ensure_serve(port: int) -> tuple[bool, str]:
    """Wire Tailscale Serve, or hand back the exact command to run."""
    if tailscale_bin() is None:
        return False, "Tailscale is not installed — install it, then re-run `porch-mobile setup`."
    if serve_configured(port):
        return True, "Tailscale Serve already points at porchd."
    command = serve_command(port)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, f"Run this yourself:\n  {' '.join(command)}\n({exc})"
    if result.returncode == 0:
        return True, "Tailscale Serve wired to porchd."
    detail = (result.stderr or result.stdout or "").strip().splitlines()
    hint = detail[0] if detail else "tailscale serve refused"
    return False, f"Run this yourself (it needs your hands):\n  {' '.join(command)}\n  → {hint}"


def qr(url: str) -> str:
    """A scannable QR in the terminal, or the plain URL if qrencode is absent."""
    binary = shutil.which("qrencode")
    if binary is None:
        return (
            f"{url}\n\n"
            "(install `qrencode` — `brew install qrencode` — for a scannable code)"
        )
    try:
        result = subprocess.run(
            [binary, "-t", "ANSIUTF8", "-o", "-", url],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return url
    if result.returncode != 0 or not result.stdout:
        return url
    return result.stdout + "\n" + url


ADD_TO_HOME_SCREEN = """
On the phone:
  1. Scan the code above with the camera — Safari opens the porch.
  2. Tap Share (the square with the arrow), then "Add to Home Screen".
  3. Tap the new icon. No login: the device stays paired until you revoke it.
""".strip()
