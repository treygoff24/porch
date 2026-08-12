"""Offline probes for doctor: versions + required CLI surfaces.

Presence alone is not enough — a ``post`` that prints a version but lacks
``owner show`` cannot satisfy porch's identity crosscheck (live finding:
post 0.4.0 without the owner surface).
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass


@dataclass(frozen=True)
class ToolProbe:
    ok: bool
    label: str


def _run(argv: list[str], *, timeout: float = 5.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def version_string(binary: str, *, name: str) -> str:
    """Best-effort version line from ``--version`` / ``-V`` (rc 0 only)."""
    for flag in ("--version", "-V"):
        try:
            result = _run([binary, flag])
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode != 0:
            continue
        blob = (result.stdout or result.stderr or "").strip()
        if not blob:
            continue
        first = blob.splitlines()[0].strip()
        if first:
            return first
    return f"{name} (version unavailable)"


def probe_named_tool(name: str, *, optional: bool = False) -> ToolProbe:
    path = shutil.which(name)
    if path is None:
        suffix = " (optional)" if optional else ""
        return ToolProbe(False, f"{name} on PATH{suffix}")
    ver = version_string(path, name=name)
    suffix = " (optional)" if optional else ""
    return ToolProbe(True, f"{ver}{suffix}")


def probe_resolved_binary(
    path: str | None, *, name: str, optional: bool = False
) -> ToolProbe:
    """Probe a resolved absolute/PATH binary (e.g. Tailscale app bundle)."""
    suffix = " (optional)" if optional else ""
    if path is None:
        return ToolProbe(False, f"{name} present{suffix}")
    return ToolProbe(True, f"{version_string(path, name=name)}{suffix}")


def post_owner_show_present(binary: str) -> tuple[bool, str]:
    """True when ``post owner show --help`` advertises the stable Usage line.

    Do not infer subcommand existence from arbitrary failure prose — probe the
    parser surface only. Configured-state crosscheck later proves operation.
    """
    try:
        result = _run([binary, "owner", "show", "--help"])
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    blob = f"{result.stdout or ''}\n{result.stderr or ''}"
    if result.returncode != 0:
        return False, "owner show --help failed"
    if "Usage: post owner show" not in blob:
        return False, "owner show --help missing Usage: post owner show"
    return True, "owner show present"


def probe_post() -> ToolProbe:
    """post must be on PATH, report a version, and expose ``owner show``."""
    path = shutil.which("post")
    if path is None:
        return ToolProbe(False, "post on PATH")
    ver = version_string(path, name="post")
    ok, detail = post_owner_show_present(path)
    if not ok:
        return ToolProbe(
            False,
            f"{ver}: missing required `post owner show` ({detail})",
        )
    return ToolProbe(True, f"{ver}: {detail}")
