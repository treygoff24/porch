"""B4: reachable HTTPS pairing base URL gate — no more 127.0.0.1 QRs."""

from __future__ import annotations

from pathlib import Path

import pytest

from helpers import make_porch_config
from porchd import config as config_mod
from porchd import devices, provision
from porchd import cli as porchd_cli


def _args(**kwargs):
    base = {"state_root": None, "port": None, "base_url": None}
    base.update(kwargs)
    return type("A", (), base)()


def test_validate_https_base_url_accepts_absolute_https():
    assert (
        config_mod.validate_https_base_url("https://mac.example.ts.net/")
        == "https://mac.example.ts.net"
    )


@pytest.mark.parametrize(
    "bad",
    [
        "http://mac.example.ts.net",
        "https://127.0.0.1",
        "https://localhost",
        "not-a-url",
        "https://mac.example.ts.net/path",
        "https://mac.example.ts.net?x=1",
        "https://user:pass@mac.example.ts.net",
        "https://user@mac.example.ts.net",
        "https://mac.example.ts.net:notaport",
        "https://mac.example.ts.net:abc",
        "https://mac example.ts.net",
        "https://mac.\nexample.ts.net",
        "https://mac.\texample.ts.net",
        "https://mac.example.ts.net\x00",
    ],
)
def test_validate_https_base_url_rejects_bad(bad):
    with pytest.raises(config_mod.BaseUrlError):
        config_mod.validate_https_base_url(bad)


def test_base_url_override_populates_hosts_and_origins():
    cfg = config_mod.Config(
        port=8765, hostname="", base_url="https://escape.example.ts.net"
    )
    assert "https://escape.example.ts.net" in cfg.allowed_origins
    assert "escape.example.ts.net" in cfg.allowed_hosts
    assert "escape.example.ts.net:443" in cfg.allowed_hosts


def test_explicit_default_https_port_normalizes_and_allows_both_host_spellings():
    """`:443` must not be the only allowlisted Host/Origin spelling."""
    assert (
        config_mod.validate_https_base_url("https://escape.example.ts.net:443")
        == "https://escape.example.ts.net"
    )
    cfg = config_mod.Config(
        port=8765, hostname="", base_url="https://escape.example.ts.net:443"
    )
    assert "https://escape.example.ts.net" in cfg.allowed_origins
    assert "https://escape.example.ts.net:443" not in cfg.allowed_origins
    assert "escape.example.ts.net" in cfg.allowed_hosts
    assert "escape.example.ts.net:443" in cfg.allowed_hosts


def test_custom_nondefault_https_port_is_retained():
    assert (
        config_mod.validate_https_base_url("https://escape.example.ts.net:8443")
        == "https://escape.example.ts.net:8443"
    )
    cfg = config_mod.Config(
        port=8765, hostname="", base_url="https://escape.example.ts.net:8443"
    )
    assert "https://escape.example.ts.net:8443" in cfg.allowed_origins
    assert "escape.example.ts.net:8443" in cfg.allowed_hosts
    assert "escape.example.ts.net" not in cfg.allowed_hosts


@pytest.mark.parametrize(
    "bad",
    [
        "https://localhost.",
        "https://LOCALHOST.",
        "https://localhost..",
        "https://127.0.0.2",
        "https://127.1.2.3",
        "https://127.255.255.255",
        "https://[::1]",
        "https://[::ffff:127.0.0.1]",
        "https://[::ffff:7f00:1]",
        "https://[::ffff:127.0.0.2]",
    ],
)
def test_validate_https_base_url_rejects_loopback_spellings(bad):
    with pytest.raises(config_mod.BaseUrlError, match="loopback"):
        config_mod.validate_https_base_url(bad)


def test_config_persists_base_url_field(tmp_path):
    root = tmp_path / "state"
    root.mkdir()
    cfg = config_mod.Config(
        port=8765, hostname="", base_url="https://phone.example.ts.net"
    )
    config_mod.save(root, cfg)
    loaded = config_mod.load(root)
    assert loaded.base_url == "https://phone.example.ts.net"
    assert loaded.derived_base_url() == "https://phone.example.ts.net"


def test_setup_without_serve_fails_before_token(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    tokens_before = {"n": 0}
    real_create = devices.create_pairing_token

    def counting_create(root, **kw):
        tokens_before["n"] += 1
        return real_create(root, **kw)

    monkeypatch.setattr(devices, "create_pairing_token", counting_create)
    monkeypatch.setattr(porchd_cli, "_root", lambda args: state)
    monkeypatch.setattr(porchd_cli, "_porch_config", lambda: make_porch_config(tmp_path))
    monkeypatch.setattr(provision, "tailscale_hostname", lambda: None)
    monkeypatch.setattr(
        provision,
        "install_launch_agent",
        lambda **kw: provision.LaunchAgentResult("installed", tmp_path / "plist"),
    )
    monkeypatch.setattr(
        provision, "ensure_serve", lambda port: (False, "needs hands")
    )
    monkeypatch.setattr(porchd_cli.time, "sleep", lambda s: None)

    rc = porchd_cli.cmd_setup(_args())
    assert rc == 1
    assert tokens_before["n"] == 0
    assert not (state / "pairing.json").exists()


def test_direct_pair_without_reachable_base_fails_before_token(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    config_mod.save(state, config_mod.Config(port=8765, hostname=""))
    monkeypatch.setattr(porchd_cli, "_root", lambda args: state)
    monkeypatch.setattr(provision, "serve_configured", lambda port: False)
    created = {"n": 0}

    def boom(*a, **k):
        created["n"] += 1
        raise AssertionError("must not mint token")

    monkeypatch.setattr(devices, "create_pairing_token", boom)
    rc = porchd_cli.cmd_pair(_args())
    assert rc == 1
    assert created["n"] == 0


def test_pair_parser_rejects_base_url_flag():
    """Direct pair must not accept --base-url (escape hatch is setup-only)."""
    parser = porchd_cli.build_parser()
    with pytest.raises(SystemExit) as ei:
        parser.parse_args(
            ["pair", "--base-url", "https://escape.example.ts.net"]
        )
    assert ei.value.code == 2


def test_pair_uses_already_persisted_base_url(tmp_path, monkeypatch, capsys):
    """Direct pair reads config.json; it does not take or persist --base-url."""
    state = tmp_path / "state"
    state.mkdir()
    override = "https://override.example.ts.net"
    config_mod.save(
        state, config_mod.Config(port=8765, hostname="", base_url=override)
    )
    monkeypatch.setattr(porchd_cli, "_root", lambda args: state)
    monkeypatch.setattr(provision, "qr", lambda url: f"QR:{url}")
    monkeypatch.setattr(devices, "create_pairing_token", lambda root: "tok123")

    rc = porchd_cli.cmd_pair(_args())
    assert rc == 0
    out = capsys.readouterr().out
    assert f"QR:{override}/#pair=tok123" in out
    assert "127.0.0.1" not in out
    assert "http://" not in out
    # Pair must not mutate a persisted base.
    assert config_mod.load(state).base_url == override


def test_pairing_url_never_contains_loopback_http(tmp_path, monkeypatch, capsys):
    state = tmp_path / "state"
    state.mkdir()
    # Hostname present but Serve down and no override → refuse (no loopback QR).
    config_mod.save(
        state, config_mod.Config(port=8765, hostname="mac.example.ts.net")
    )
    monkeypatch.setattr(porchd_cli, "_root", lambda args: state)
    monkeypatch.setattr(provision, "serve_configured", lambda port: False)
    minted = []

    def capture(root):
        minted.append(True)
        return "tok"

    monkeypatch.setattr(devices, "create_pairing_token", capture)
    rc = porchd_cli.cmd_pair(_args())
    assert rc == 1
    assert not minted
    out = capsys.readouterr().out
    assert "127.0.0.1" not in out
    assert "#pair=" not in out


def test_setup_with_base_url_override_pairs_despite_serve_failure(
    tmp_path, monkeypatch, capsys
):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setattr(porchd_cli, "_root", lambda args: state)
    monkeypatch.setattr(porchd_cli, "_porch_config", lambda: make_porch_config(tmp_path))
    monkeypatch.setattr(provision, "tailscale_hostname", lambda: None)
    monkeypatch.setattr(
        provision,
        "install_launch_agent",
        lambda **kw: provision.LaunchAgentResult("installed", tmp_path / "plist"),
    )
    monkeypatch.setattr(
        provision, "ensure_serve", lambda port: (False, "needs hands")
    )
    monkeypatch.setattr(porchd_cli.time, "sleep", lambda s: None)
    monkeypatch.setattr(provision, "qr", lambda url: f"QR:{url}")
    monkeypatch.setattr(devices, "create_pairing_token", lambda root: "tokXYZ")

    override = "https://escape.example.ts.net"
    rc = porchd_cli.cmd_setup(_args(base_url=override))
    assert rc == 0
    out = capsys.readouterr().out
    assert f"QR:{override}/#pair=tokXYZ" in out
    assert "127.0.0.1" not in out
    # Setup persists before install/reload so the daemon allowlists match the QR.
    loaded = config_mod.load(state)
    assert loaded.base_url == override
    assert override in loaded.allowed_origins
    assert "escape.example.ts.net" in loaded.allowed_hosts
