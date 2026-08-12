"""Signing lease (§3): a service-owned, empty-at-start ssh-agent.

The agent's own `-t` TTL is the enforcement clock. Everything here that
reports a deadline is display; authorization is always a live `ssh-add -l`
against the service socket.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from porchd.oplock import operation_lock
from porchd.state import ensure_dir, is_within, read_json, write_json

DEFAULT_DURATION_S = 8 * 3600
MAX_DURATION_S = 24 * 3600


def agent_root(root: Path) -> Path:
    return root / "agent"


def agent_state_path(root: Path) -> Path:
    return root / "agent.json"


def lease_path(root: Path) -> Path:
    return root / "lease.json"


def clamp_duration(seconds: float | None) -> int:
    if not seconds or seconds <= 0:
        return DEFAULT_DURATION_S
    return int(min(seconds, MAX_DURATION_S))


def parse_duration(text: str | None) -> int:
    """Accept `8h`, `45m`, `3600`, or nothing (→ the 8h default)."""
    if not text:
        return DEFAULT_DURATION_S
    text = text.strip().lower()
    units = {"s": 1, "m": 60, "h": 3600}
    factor = 1
    if text and text[-1] in units:
        factor = units[text[-1]]
        text = text[:-1]
    try:
        return clamp_duration(float(text) * factor)
    except ValueError:
        return DEFAULT_DURATION_S


def _cleanup_stale(root: Path) -> None:
    """Remove a previous run's socket dir — paths only, never signals.

    PID reuse means a recorded pid is not evidence about the process that
    holds it now, so a restart never signals it (§3). The orphaned agent's
    identity remains bounded by the TTL ssh-add gave it.
    """
    old = read_json(agent_state_path(root), {})
    if not isinstance(old, dict):
        return
    for key in ("socket", "dir"):
        value = old.get(key)
        if not isinstance(value, str) or not value:
            continue
        candidate = Path(value)
        if not is_within(candidate, agent_root(root)):
            continue
        if candidate.is_dir():
            shutil.rmtree(candidate, ignore_errors=True)
        else:
            try:
                candidate.unlink()
            except OSError:
                pass


class Agent:
    """The service's own ssh-agent process, empty until someone arms it."""

    def __init__(self, root: Path):
        self.root = root
        self.dir: Path | None = None
        self.socket: Path | None = None
        self.pid: str | None = None

    def start(self) -> None:
        _cleanup_stale(self.root)
        ensure_dir(agent_root(self.root))
        self.dir = ensure_dir(agent_root(self.root) / secrets.token_hex(8))
        self.socket = self.dir / "agent.sock"
        out = subprocess.run(
            ["ssh-agent", "-a", str(self.socket)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.pid = next(
            (
                line.split("=", 1)[1].split(";")[0]
                for line in out.splitlines()
                if line.startswith("SSH_AGENT_PID=")
            ),
            None,
        )
        write_json(
            agent_state_path(self.root),
            {
                "socket": str(self.socket),
                "dir": str(self.dir),
                "pid": self.pid,
                "started": time.time(),
            },
        )

    def stop(self) -> None:
        """Kill the agent we started in THIS process (a verified pid)."""
        if self.socket is not None and self.pid is not None:
            env = {**os.environ, "SSH_AUTH_SOCK": str(self.socket), "SSH_AGENT_PID": self.pid}
            subprocess.run(["ssh-agent", "-k"], env=env, capture_output=True)
        if self.dir is not None and is_within(self.dir, agent_root(self.root)):
            shutil.rmtree(self.dir, ignore_errors=True)
        self.dir = self.socket = self.pid = None
        write_json(agent_state_path(self.root), {})


def socket_path(root: Path) -> Path | None:
    """The live service socket, only if it sits under the state root."""
    state = read_json(agent_state_path(root), {})
    if not isinstance(state, dict):
        return None
    value = state.get("socket")
    if not isinstance(value, str) or not value:
        return None
    candidate = Path(value)
    if not is_within(candidate, agent_root(root)):
        return None
    return candidate


def agent_env(root: Path) -> dict | None:
    sock = socket_path(root)
    if sock is None or not sock.exists():
        return None
    return {**os.environ, "SSH_AUTH_SOCK": str(sock)}


def loaded_identities(root: Path) -> int:
    """Live authorization: how many identities the service agent holds."""
    env = agent_env(root)
    if env is None:
        return 0
    try:
        result = subprocess.run(
            ["ssh-add", "-l"], env=env, capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return 0
    if result.returncode != 0:
        return 0
    return len([line for line in (result.stdout or "").splitlines() if line.strip()])


def is_armed(root: Path) -> bool:
    return loaded_identities(root) > 0


def deadline(root: Path) -> float | None:
    data = read_json(lease_path(root), {})
    if not isinstance(data, dict):
        return None
    value = data.get("deadline")
    return float(value) if isinstance(value, (int, float)) else None


def status(root: Path) -> dict:
    """Armed/dark from the live agent; the deadline is display only."""
    armed = is_armed(root)
    ends = deadline(root) if armed else None
    return {
        "armed": armed,
        "deadline": ends,
        "deadline_utc": (
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ends)) if ends else None
        ),
        "socket_present": socket_path(root) is not None,
    }


def arm(root: Path, seconds: float | None = None, *, key: Path,
        timeout: float | None = None) -> tuple[bool, str]:
    """Load the key into the service agent with ssh-add's own TTL.

    Takes the operation lock (§3) so a send in the daemon cannot interleave
    with the mutation. The lock lives here rather than in the CLI so every
    future caller inherits it. ``key`` is required — no module-level default
    (F5: two configs in one process must not share a captured KEY).
    """
    env = agent_env(root)
    if env is None:
        return False, "porchd is not running (no signing agent socket) — start the service first"
    if not Path(key).exists():
        return False, f"no signing key at {key}"
    duration = clamp_duration(seconds)
    with operation_lock(root, timeout=timeout):
        result = subprocess.run(["ssh-add", "-t", str(duration), str(key)], env=env)
        if result.returncode != 0:
            return False, "ssh-add refused the key (wrong passphrase?)"
        write_json(
            lease_path(root),
            {"armed_at": time.time(), "duration": duration, "deadline": time.time() + duration},
        )
    hours = duration / 3600
    return True, f"armed for {hours:.1f}h — no renewal, re-arm to extend"


def lock(root: Path, *, timeout: float | None = None) -> tuple[bool, str]:
    """Kill the lease. Serialized against sends on the operation lock (§3)."""
    with operation_lock(root, timeout=timeout):
        env = agent_env(root)
        if env is None:
            write_json(lease_path(root), {})
            return True, "already dark (no agent socket)"
        result = subprocess.run(["ssh-add", "-D"], env=env, capture_output=True)
        write_json(lease_path(root), {})
        if result.returncode != 0:
            return False, "ssh-add -D failed"
    return True, "locked — signing is dark"
