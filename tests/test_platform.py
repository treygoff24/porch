"""macOS-only entrypoint guard."""

from __future__ import annotations

import pytest

from porch3 import platform as platform_mod
from porch3.platform import UnsupportedPlatformError, require_macos


def test_require_macos_passes_on_darwin(monkeypatch):
    monkeypatch.setattr(platform_mod.sys, "platform", "darwin")
    require_macos()  # does not raise


def test_require_macos_fails_fast_on_non_darwin(monkeypatch):
    monkeypatch.setattr(platform_mod.sys, "platform", "linux")
    with pytest.raises(UnsupportedPlatformError, match="macOS only"):
        require_macos()


@pytest.mark.parametrize(
    "entrypoint,callable_name",
    [
        ("porch3.app", "main"),
        ("porch3.initcli", "main"),
        ("porch3.verifycli", "main"),
        ("porchd.cli", "main"),
        ("porch3.drstore", "_cli"),
    ],
)
def test_entrypoints_invoke_platform_guard(entrypoint, callable_name, monkeypatch):
    """Each public entrypoint must call require_macos before other work."""
    import importlib

    mod = importlib.import_module(entrypoint)
    called = {"n": 0}

    def boom():
        called["n"] += 1
        raise UnsupportedPlatformError("guarded")

    monkeypatch.setattr(platform_mod.sys, "platform", "linux")
    monkeypatch.setattr(mod, "require_macos", boom)
    target = getattr(mod, callable_name)
    with pytest.raises(UnsupportedPlatformError, match="guarded"):
        target([]) if callable_name == "main" else target()
    assert called["n"] == 1
