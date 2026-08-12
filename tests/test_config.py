"""Unit tests for porch3.config — PorchConfig load/emit/validate."""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

from porch3.config import (
    ConfigError,
    build_config,
    emit_toml,
    legacy_hardcoded_values,
    load_config,
    parse_config_dict,
    resolve_mail_root,
    validate_label,
    validate_marker,
)


def test_build_resolves_defaults(tmp_path: Path):
    room = tmp_path / "mara-room"
    room.mkdir()
    cfg = build_config(
        owner_room="mara",
        owner_room_dir=room,
        env={},
    )
    assert cfg.owner_room == "mara"
    assert cfg.sidecar_dir == room
    assert cfg.allowed_signers == room / "allowed_signers"
    assert cfg.key_file == room / "mara_porch_key"
    assert cfg.signing_namespace == "mara-porch"
    assert cfg.principal == "mara@porch"
    assert cfg.label == "Mara"
    assert cfg.marker == "🦊"
    assert cfg.mail_root == Path.home() / ".claude-mail"
    assert cfg.dr_log_path == room / "decision-records.jsonl"
    assert "mail_root" not in cfg.as_emit_dict()


def test_mail_root_precedence(tmp_path: Path, monkeypatch):
    room = tmp_path / "room"
    room.mkdir()
    env_root = tmp_path / "env-mail"
    explicit = tmp_path / "explicit-mail"
    monkeypatch.setenv("POST_MAIL_ROOT", str(env_root))

    assert resolve_mail_root(None, env={"POST_MAIL_ROOT": str(env_root)}) == env_root
    assert resolve_mail_root(explicit, env={"POST_MAIL_ROOT": str(env_root)}) == explicit

    cfg = build_config(
        owner_room="mara",
        owner_room_dir=room,
        mail_root=explicit,
        env={"POST_MAIL_ROOT": str(env_root)},
    )
    assert cfg.mail_root == explicit
    assert cfg.as_emit_dict()["mail_root"] == str(explicit)


def test_deny_unknown_fields(tmp_path: Path):
    with pytest.raises(ConfigError, match="unknown config field") as ei:
        parse_config_dict(
            {
                "owner_room": "mara",
                "owner_room_dir": str(tmp_path),
                "extra": "nope",
            },
            env={},
        )
    assert ei.value.field == "extra"


def test_marker_and_label_validation():
    assert validate_marker("🦊") == "🦊"
    assert validate_marker("👩‍🚀") == "👩‍🚀"
    assert validate_marker("⚖️") == "⚖️"
    assert validate_marker("🇺🇸") == "🇺🇸"  # regional-indicator pair = one grapheme
    assert validate_marker("👋🏻") == "👋🏻"
    assert validate_marker("👨🏻‍💻") == "👨🏻‍💻"
    # Grapheme-cluster cross-check vectors (regex \\X / UAX #29), matching Post's marker predicate.
    assert validate_marker("🏴󠁧󠁢󠁳󠁣󠁴󠁿") == "🏴󠁧󠁢󠁳󠁣󠁴󠁿"  # Scotland tag-flag
    assert validate_marker("\u1100\u1161") == "\u1100\u1161"  # Hangul Jamo 가
    assert validate_marker("e\u0301") == "e\u0301"  # combining mark cluster
    with pytest.raises(ConfigError, match="exactly one"):
        validate_marker("é\u200db")  # ZWJ + ASCII — Post REJECT
    with pytest.raises(ConfigError, match="exactly one"):
        validate_marker("🚀\u200dx")
    with pytest.raises(ConfigError, match="non-ASCII|ASCII"):
        validate_marker("A")
    with pytest.raises(ConfigError, match="exactly one"):
        validate_marker("🦊🐉")
    with pytest.raises(ConfigError, match="exactly one"):
        validate_marker("🇺🇸🇺🇸")
    with pytest.raises(ConfigError, match="ZWJ"):
        validate_marker("\u200d🚀")
    with pytest.raises(ConfigError, match="ZWJ"):
        validate_marker("🚀\u200d")
    with pytest.raises(ConfigError, match="control|bidi"):
        validate_marker("\u202e")
    assert validate_label("Mara") == "Mara"
    with pytest.raises(ConfigError, match="whitespace-only|empty"):
        validate_label("")
    with pytest.raises(ConfigError, match="whitespace-only"):
        validate_label("   ")
    with pytest.raises(ConfigError, match="1-32"):
        validate_label("x" * 33)
    with pytest.raises(ConfigError, match="control"):
        validate_label("bad\nlabel")


def test_marker_uax29_corpus_matches_post_vectors():
    """Broader UAX #29 corpus: flags, tags, Jamo, ZWJ+ASCII, VS16, skin, marks."""
    from porch3.config import _grapheme_clusters

    accept = [
        "👩‍🚀",
        "\u1100\u1161",  # decomposed Hangul
        "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
        "🇺🇸",
        "⚖️",
        "👋🏻",
        "👨🏻‍💻",
        "e\u0301",
        "🦊",
    ]
    reject_multi = [
        "é\u200db",
        "🚀\u200dx",
        "🦊🐉",
        "🇺🇸🇺🇸",
        "⚖️x",
    ]
    for marker in accept:
        assert len(_grapheme_clusters(marker)) == 1, marker
        assert validate_marker(marker) == marker
    for marker in reject_multi:
        assert len(_grapheme_clusters(marker)) != 1, marker
        with pytest.raises(ConfigError):
            validate_marker(marker)


def test_empty_post_mail_root_refused_absent_uses_default(tmp_path: Path):
    """Present-empty POST_MAIL_ROOT is refused; absent falls back to default."""
    with pytest.raises(ConfigError, match="absolute"):
        resolve_mail_root(None, env={"POST_MAIL_ROOT": ""})
    assert resolve_mail_root(None, env={}) == Path.home() / ".claude-mail"
    explicit = tmp_path / "mail"
    assert resolve_mail_root(explicit, env={"POST_MAIL_ROOT": ""}) == explicit


def test_read_regular_nofollow_includes_post_fstat_growth(tmp_path: Path):
    """File grown after fstat must be fully read (or over-limit), never stale prefix."""
    import os

    from porch3 import config as config_mod
    from porch3.config import read_regular_nofollow

    path = tmp_path / "cfg"
    path.write_bytes(b"old")
    real_fstat = config_mod.os.fstat
    state = {"appended": False}

    def flaky_fstat(fd):
        st = real_fstat(fd)
        if not state["appended"]:
            afd = os.open(path, os.O_WRONLY | os.O_APPEND)
            try:
                os.write(afd, b"-appended")
            finally:
                os.close(afd)
            state["appended"] = True
        return st

    config_mod.os.fstat = flaky_fstat
    try:
        data = read_regular_nofollow(path, limit=64, label="config")
    finally:
        config_mod.os.fstat = real_fstat
    assert data == b"old-appended"
    assert state["appended"] is True


def test_read_regular_nofollow_refuses_symlink_fifo_oversize(tmp_path: Path):
    import os

    from porch3.config import read_regular_nofollow

    target = tmp_path / "real"
    target.write_bytes(b"x")
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(ConfigError, match="regular|unreadable|non-follow"):
        read_regular_nofollow(link, limit=64, label="config")

    fifo = tmp_path / "fifo"
    os.mkfifo(fifo)
    with pytest.raises(ConfigError, match="regular|FIFO|unreadable|non-follow"):
        read_regular_nofollow(fifo, limit=64, label="config")

    big = tmp_path / "big"
    big.write_bytes(b"x" * 100)
    with pytest.raises(ConfigError, match="exceeds"):
        read_regular_nofollow(big, limit=16, label="config")


def test_load_config_lexical_source_path_no_resolve_follow(tmp_path: Path):
    """source_path stays absolute lexical — no path-following resolve()."""
    import os

    from porch3.config import emit_toml, load_config, load_config_bytes

    room = tmp_path / "room"
    room.mkdir()
    cfg = build_config(owner_room="mara", owner_room_dir=room, env={})
    real = tmp_path / "real.toml"
    real.write_text(emit_toml(cfg))
    link = tmp_path / "link.toml"
    raw = real.read_bytes()
    loaded = load_config_bytes(raw, env={}, source_path=link)
    assert loaded.source_path == Path(os.path.abspath(link))

    loaded2 = load_config(real, env={})
    assert loaded2.source_path == Path(os.path.abspath(real))


def test_load_config_refuses_fifo(tmp_path: Path):
    import os

    fifo = tmp_path / "config.toml"
    os.mkfifo(fifo)
    with pytest.raises(ConfigError, match="regular|FIFO|unreadable|non-follow"):
        load_config(fifo, env={})


def test_path_inputs_reject_controls(tmp_path: Path):
    """CLI Path values with embedded controls must fail like string paths."""
    room = tmp_path / "room"
    room.mkdir()
    nasty = tmp_path / ("bad\nname")
    with pytest.raises(ConfigError, match="control"):
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            mail_root=Path(str(tmp_path / "mail") + "\n"),
            env={},
        )
    with pytest.raises(ConfigError, match="control"):
        build_config(
            owner_room="mara",
            owner_room_dir=Path(str(room) + "\t"),
            env={},
        )
    with pytest.raises(ConfigError, match="control"):
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            sidecar_dir=Path(str(tmp_path) + "\r" + "/sc"),
            env={},
        )
    with pytest.raises(ConfigError, match="control"):
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            allowed_signers=Path(str(tmp_path / "s") + "\n"),
            env={},
        )
    with pytest.raises(ConfigError, match="control"):
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            key_file=Path(str(tmp_path / "k") + "\n"),
            env={},
        )
    _ = nasty  # path shape reserved; controls caught before mkdir


def test_emit_round_trip_property(tmp_path: Path):
    """Property: tomllib.loads(emit(config)) reconstructs accepted values."""
    room = tmp_path / "room"
    room.mkdir()
    cases = [
        build_config(owner_room="mara", owner_room_dir=room, env={}),
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            marker="🦊",
            label='Mara "the" Fox',
            mail_root=tmp_path / "mail",
            env={},
        ),
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            label="Mara\\Back",
            principal="mara@porch",
            signing_namespace="mara-porch",
            env={},
        ),
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            label="Mara — 日本語",
            owner_accent="#aabbcc",
            env={},
        ),
    ]
    for cfg in cases:
        text = emit_toml(cfg)
        loaded = tomllib.loads(text)
        again = parse_config_dict(loaded, env={})
        # Compare resolved identity fields (paths may differ only by str form).
        assert again.owner_room == cfg.owner_room
        assert again.owner_room_dir == cfg.owner_room_dir
        assert again.marker == cfg.marker
        assert again.label == cfg.label
        assert again.principal == cfg.principal
        assert again.signing_namespace == cfg.signing_namespace
        assert again.owner_accent == cfg.owner_accent
        if "mail_root" in cfg.explicit_fields:
            assert again.mail_root == cfg.mail_root


def test_newline_rejected_never_emittable(tmp_path: Path):
    room = tmp_path / "room"
    room.mkdir()
    with pytest.raises(ConfigError):
        build_config(
            owner_room="mara",
            owner_room_dir=room,
            label="line\nbreak",
            env={},
        )


def test_load_config_file(tmp_path: Path):
    room = tmp_path / "mara-room"
    room.mkdir()
    path = tmp_path / "config.toml"
    cfg = build_config(
        owner_room="mara",
        owner_room_dir=room,
        mail_root=tmp_path / "mail",
        env={},
    )
    path.write_text(emit_toml(cfg))
    loaded = load_config(path, env={})
    assert loaded.owner_room == "mara"
    assert loaded.mail_root == tmp_path / "mail"


def test_legacy_hardcoded_values_marked():
    vals = legacy_hardcoded_values(home=Path("/tmp/fake-home"))
    assert vals["owner_room"]
    assert Path(vals["owner_room_dir"]).parent == Path("/tmp/fake-home")
    assert vals["label"]


def test_regex_dependency_is_exactly_pinned():
    """Marker equality with Post rides on one UAX #29 table — pin it exactly.

    A floating `regex` would let a routine upgrade silently re-segment markers,
    so the pin moves only after the cross-language corpus is re-run.
    """
    from importlib.metadata import version

    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    deps = data["project"]["dependencies"]
    assert "regex==2026.7.19" in deps, deps
    assert version("regex") == "2026.7.19"


def _fd_scoped_failure(monkeypatch, module, path: Path, call: str, message: str):
    """Make one os call fail only for the fd opened on ``path``.

    Process-wide ``os.read``/``os.fstat`` patches would break pytest's own
    plumbing, so the injected failure is scoped to our held fd.
    """
    real_open = module.os.open
    real_call = getattr(module.os, call)
    target: dict[str, int | None] = {"fd": None}

    def spy_open(name, *args, **kwargs):
        fd = real_open(name, *args, **kwargs)
        if not isinstance(name, int) and Path(str(name)) == path:
            target["fd"] = fd
        return fd

    def boom(fd, *args, **kwargs):
        if target["fd"] is not None and fd == target["fd"]:
            raise OSError(message)
        return real_call(fd, *args, **kwargs)

    monkeypatch.setattr(module.os, "open", spy_open)
    monkeypatch.setattr(module.os, call, boom)


def test_read_regular_nofollow_maps_fstat_failure_to_config_error(
    tmp_path: Path, monkeypatch
):
    """An fstat OSError on the held fd is a ConfigError, never a raw OSError."""
    from porch3 import config as config_mod
    from porch3.config import read_regular_nofollow

    path = tmp_path / "cfg"
    path.write_bytes(b"owner_room = 'mara'\n")
    _fd_scoped_failure(
        monkeypatch, config_mod, path, "fstat", "injected fstat failure"
    )
    with pytest.raises(ConfigError, match="cannot fstat"):
        read_regular_nofollow(path, limit=64, label="config")


def test_read_regular_nofollow_maps_read_failure_to_config_error(
    tmp_path: Path, monkeypatch
):
    """A mid-read OSError on the held fd is a ConfigError, never a raw OSError."""
    from porch3 import config as config_mod
    from porch3.config import read_regular_nofollow

    path = tmp_path / "cfg"
    path.write_bytes(b"owner_room = 'mara'\n")
    _fd_scoped_failure(
        monkeypatch, config_mod, path, "read", "injected read failure"
    )
    with pytest.raises(ConfigError, match="cannot read"):
        read_regular_nofollow(path, limit=64, label="config")


def test_held_read_returns_fstat_snapshot_from_the_same_fd(tmp_path: Path):
    """HeldRegular carries the mode that governed the bytes it returned."""
    import os
    import stat as stat_mod

    from porch3.config import held_read_regular_nofollow

    path = tmp_path / "key"
    path.write_bytes(b"secret\n")
    os.chmod(path, 0o600)
    held = held_read_regular_nofollow(path, limit=64, label="private key")
    os.chmod(path, 0o644)
    assert held.data == b"secret\n"
    assert stat_mod.S_IMODE(held.st.st_mode) == 0o600
