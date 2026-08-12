"""Sender theme (treaty colors from theme.json)."""

from __future__ import annotations

import json
from pathlib import Path

from porch3.constants import DEFAULT_THEME, FALLBACK_PALETTE, THEME_PATH


def load_theme(path: Path | None = None) -> dict:
    path = Path(path) if path is not None else THEME_PATH
    try:
        theme = json.loads(path.read_text())
        if isinstance(theme.get("senders"), dict):
            return theme
    except FileNotFoundError:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(DEFAULT_THEME, indent=2) + "\n")
        except OSError:
            pass
    except (ValueError, OSError):
        pass
    return DEFAULT_THEME


class SenderTheme:
    """Resolve room → hex color, with arrival-order fallback palette."""

    def __init__(self, theme: dict | None = None):
        theme = theme if theme is not None else load_theme()
        self._fixed = {
            str(k): str(v)
            for k, v in theme.get("senders", {}).items()
            if isinstance(k, str) and isinstance(v, str)
        }
        self._assigned: dict[str, str] = {}

    def color(self, sender: str) -> str:
        if sender in self._fixed:
            return self._fixed[sender]
        if sender not in self._assigned:
            idx = len(self._assigned) % len(FALLBACK_PALETTE)
            self._assigned[sender] = FALLBACK_PALETTE[idx]
        return self._assigned[sender]
