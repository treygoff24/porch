"""Presence via `post who --json`."""

from __future__ import annotations

import json
import subprocess

from porch3.config import PorchConfig


def fetch_presence(*, config: PorchConfig) -> dict[str, bool]:
    """room → live_watch bool. Empty dict on failure."""
    try:
        r = subprocess.run(
            ["post", "who", "--json"],
            cwd=config.owner_room_dir,
            env=config.post_env(),
            capture_output=True,
            text=True,
            timeout=5,
        )
        data = json.loads(r.stdout)
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return {}
    out: dict[str, bool] = {}
    for entry in data.get("rooms") or []:
        if not isinstance(entry, dict):
            continue
        room = entry.get("room")
        if isinstance(room, str):
            out[room] = bool(entry.get("live_watch"))
    return out
