"""macOS-only v1 platform gate.

Porch v1 is macOS-only (LaunchAgent, Tailscale Serve UX). Every CLI/TUI
entrypoint calls ``require_macos()`` before doing work. Cross-OS test
harnesses monkeypatch ``sys.platform`` in-process; there is no shipped
environment escape hatch.
"""

from __future__ import annotations

import sys


class UnsupportedPlatformError(SystemExit):
    """Non-darwin host."""

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.default_message())

    @staticmethod
    def default_message() -> str:
        return (
            f"porch v1 supports macOS only (sys.platform={sys.platform!r})"
        )


def require_macos() -> None:
    """Fail fast unless running on darwin."""
    if sys.platform == "darwin":
        return
    raise UnsupportedPlatformError()
