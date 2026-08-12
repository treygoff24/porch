"""porch3 — Textual groupchat TUI for post channels."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as _pkg_version

try:
    __version__ = _pkg_version("porch3")
except PackageNotFoundError:
    # Source-tree import without an installed distribution — keep in lockstep
    # with pyproject.toml [project].version (release bump updates both).
    __version__ = "1.0.0"
