"""porch-verify CLI contract tests (B0 §4) — real ssh-keygen where needed."""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

from helpers import make_porch_config
from porch3.config import emit_toml
from porch3.signature_v2 import MAX_SIGNED_BODY_BYTES, manifest_bytes
from porch3.verifycli import (
    EXIT_ENV,
    EXIT_FAIL,
    EXIT_LOOKUP,
    EXIT_OK,
    EXIT_USAGE,
    main,
    held_read_channel_record,
    held_read_unique_message_record,
    validate_channel_name,
    validate_message_id,
    verify_body_bytes,
    verify_message_id,
)

CANON_MID = "20250111-120000-000001-abcdef"
CANON_MID_B = "20250111-120000-000002-abcdef"


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    config = make_porch_config(tmp_path, owner_room="mara", marker="🦊")
    config.sigs_dir.mkdir(parents=True, exist_ok=True)
    conf = tmp_path / "config.toml"
    conf.write_text(emit_toml(config))
    monkeypatch.setenv("PORCH_CONFIG", str(conf))
    return config


def _write_msg(
    cfg,
    channel: str,
    mid: str,
    body: str,
    *,
    sender: str = "mara",
    signature_ref=...,
    envelope_channel: str | None = None,
) -> Path:
    store = cfg.channels_dir / channel / "messages"
    store.mkdir(parents=True, exist_ok=True)
    path = store / f"{mid}.msg"
    envelope = {"id": mid, "from": sender, "sent": "x"}
    if envelope_channel is not None:
        envelope["channel"] = envelope_channel
    if signature_ref is not ...:
        envelope["signature_ref"] = signature_ref
    path.write_bytes(
        json.dumps(envelope, separators=(",", ":")).encode()
        + b"\n---\n"
        + body.encode()
    )
    return path


def _install_signing_identity(cfg, tmp_path: Path, *, passphrase: str = "") -> None:
    """Real ed25519 key + allowed_signers line for crypto tests."""
    key = tmp_path / "testkey"
    subprocess.run(
        [
            "ssh-keygen",
            "-t",
            "ed25519",
            "-f",
            str(key),
            "-C",
            cfg.principal,
            "-N",
            passphrase,
            "-q",
        ],
        check=True,
        capture_output=True,
    )
    pub = key.with_suffix(key.suffix + ".pub") if False else Path(str(key) + ".pub")
    pub_line = pub.read_text().strip()
    parts = pub_line.split()
    line = (
        f'{cfg.principal} namespaces="{cfg.signing_namespace}" '
        f"{parts[0]} {parts[1]}\n"
    )
    cfg.allowed_signers.write_text(line)
    os.chmod(cfg.allowed_signers, 0o600)
    return key


def _sign_payload(cfg, key: Path, tag: str, channel_text: str) -> bytes:
    """Sign bare channel text (no marker prefix) into sigs/{tag}.txt[.sig]."""
    payload = f"{tag}\n{channel_text}\n".encode()
    payload_path = cfg.sigs_dir / f"{tag}.txt"
    payload_path.write_bytes(payload)
    subprocess.run(
        [
            "ssh-keygen",
            "-Y",
            "sign",
            "-f",
            str(key),
            "-n",
            cfg.signing_namespace,
            str(payload_path),
        ],
        check=True,
        capture_output=True,
        input=b"\n",
    )
    return payload


def _sign_v2(cfg, key: Path, tag: str, channel: str, body: str) -> bytes:
    payload = manifest_bytes(tag, channel, body)
    payload_path = cfg.sigs_dir / f"{tag}.txt"
    payload_path.write_bytes(payload)
    subprocess.run(
        [
            "ssh-keygen",
            "-Y",
            "sign",
            "-f",
            str(key),
            "-n",
            cfg.signing_namespace,
            str(payload_path),
        ],
        check=True,
        capture_output=True,
        input=b"\n",
    )
    return payload


def test_usage_without_args(cfg):
    assert main([]) == EXIT_USAGE


def test_stdin_with_channel_is_usage(cfg, monkeypatch):
    class FakeStdin:
        buffer = type("B", (), {"read": staticmethod(lambda: b"x")})()

    from porch3 import verifycli

    monkeypatch.setattr(verifycli.sys, "stdin", FakeStdin())
    monkeypatch.setattr(
        "porch3.roomcheck.apply_owner_crosscheck", lambda c: c
    )
    assert main(["--stdin", "--channel", "commons"]) == EXIT_USAGE


def test_message_id_grammar():
    assert validate_message_id(CANON_MID) is None
    assert validate_message_id("star-msg") is not None
    assert validate_message_id("*") is not None
    assert validate_message_id("20250111-120000-000001-abcdeg") is not None  # g


def test_channel_name_grammar():
    assert validate_channel_name("commons") is None
    assert validate_channel_name("../etc") is not None
    assert validate_channel_name("archive") is not None
    assert validate_channel_name("rooms.json") is not None


def test_not_found(cfg):
    code, _ = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_LOOKUP


def test_duplicate_id(cfg):
    body = f"🦊🔏 hello [signed:20250111T120000Z]"
    _write_msg(cfg, "commons", CANON_MID, body)
    _write_msg(cfg, "backporch", CANON_MID, body)
    code, msg = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_LOOKUP
    assert "duplicate" in msg


def test_invalid_utf8_fails(cfg):
    code, msg = verify_body_bytes(b"\xff\xfe not utf-8", config=cfg)
    assert code == EXIT_FAIL
    assert "UTF-8" in msg


def test_forged_body(cfg):
    tag = "20250111T120000Z"
    payload = cfg.sigs_dir / f"{tag}.txt"
    sig = cfg.sigs_dir / f"{tag}.txt.sig"
    payload.write_bytes(f"{tag}\nreal text\n".encode())
    sig.write_bytes(b"not-a-real-sig")
    body = f"🦊🔏 FORGED text [signed:{tag}]".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_FAIL
    assert "FORGED" in msg or "differs" in msg


def test_rename_replay(cfg):
    tag = "TAGA"
    payload = cfg.sigs_dir / f"{tag}.txt"
    sig = cfg.sigs_dir / f"{tag}.txt.sig"
    payload.write_bytes(b"OTHER\nhello\n")
    sig.write_bytes(b"x")
    body = f"🦊🔏 hello [signed:{tag}]".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_FAIL
    assert "rename-replay" in msg


def test_wildcard_message_id_rejected(cfg):
    _write_msg(cfg, "commons", CANON_MID, "🦊🔏 x [signed:T]")
    code, msg = verify_message_id("*", config=cfg)
    assert code == EXIT_USAGE
    assert "invalid" in msg
    code2, msg2 = verify_message_id("star-msg", config=cfg)
    assert code2 == EXIT_USAGE


def test_channel_traversal_rejected(cfg):
    code, msg = verify_message_id(CANON_MID, config=cfg, channel="../etc")
    assert code == EXIT_USAGE
    assert "invalid" in msg


def test_multi_tag_rejected(cfg):
    body = "🦊🔏 hello [signed:AAA] extra [signed:BBB]".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_FAIL
    assert "exactly one" in msg


def test_hyphen_tag_accepted_through_wire(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "2025-01-11T12-00-00Z"
    text = "hyphen tag body"
    _sign_payload(cfg, key, tag, text)
    body = f"🦊🔏 {text} [signed:{tag}]\n".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_OK, msg


def test_prefix_line_does_not_lend_verified(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T120000Z"
    text = "real"
    _sign_payload(cfg, key, tag, text)
    # Unsigned prefix line before a valid tagged line must not verify.
    body = f"unsigned decoy\n🦊🔏 {text} [signed:{tag}]\n".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_FAIL
    assert "exact one-line" in msg or "channel text" in msg


def test_appended_line_does_not_lend_verified(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T120000Z"
    text = "real"
    _sign_payload(cfg, key, tag, text)
    body = f"🦊🔏 {text} [signed:{tag}]\nappended unsigned\n".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_FAIL


def test_mid_line_prefix_salvage_refused(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T120000Z"
    text = "real"
    _sign_payload(cfg, key, tag, text)
    body = f"noise🦊🔏 {text} [signed:{tag}]\n".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_FAIL


def test_crlf_payload_rejected(cfg):
    tag = "20250111T120000Z"
    (cfg.sigs_dir / f"{tag}.txt").write_bytes(f"{tag}\r\nhello\r\n".encode())
    (cfg.sigs_dir / f"{tag}.txt.sig").write_bytes(b"x")
    body = f"🦊🔏 hello [signed:{tag}]".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_FAIL
    assert "newline" in msg or "noncanonical" in msg


def test_missing_allowed_signers_is_fail_not_usage(cfg):
    tag = "20250111T120000Z"
    (cfg.sigs_dir / f"{tag}.txt").write_bytes(f"{tag}\nhello\n".encode())
    (cfg.sigs_dir / f"{tag}.txt.sig").write_bytes(b"x")
    body = f"🦊🔏 hello [signed:{tag}]".encode()
    from dataclasses import replace

    missing = replace(cfg, allowed_signers=cfg.sidecar_dir / "no-such-signers")
    code, msg = verify_body_bytes(body, config=missing)
    assert code == EXIT_FAIL
    assert "allowed_signers" in msg


def test_payload_read_race_is_environment(cfg, monkeypatch):
    tag = "RACE1"
    payload = cfg.sigs_dir / f"{tag}.txt"
    sig = cfg.sigs_dir / f"{tag}.txt.sig"
    payload.write_bytes(f"{tag}\nhello\n".encode())
    sig.write_bytes(b"x")
    body = f"🦊🔏 hello [signed:{tag}]".encode()

    import porch3.verifycli as vc

    real = vc._read_regular_nofollow

    def flaky(path, *, limit, label):
        if path == payload:
            raise FileNotFoundError("raced")
        return real(path, limit=limit, label=label)

    monkeypatch.setattr(vc, "_read_regular_nofollow", flaky)
    code, msg = verify_body_bytes(body, config=cfg)
    # Missing at the single open is FAIL (not a mid-read ENV race).
    assert code == EXIT_FAIL
    assert "payload" in msg


def test_payload_toctou_uses_compared_bytes(cfg, tmp_path, monkeypatch):
    """Replacement after the held open must not re-open the payload path.

    After the nofollow read, swap the on-disk payload to a different signed
    blob but leave the original signature. Re-reading would fail crypto;
    using the already-held bytes still verifies. ssh-keygen must never see
    the original payload/sig/signers pathnames.
    """
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T120000Z"
    good_text = "original"
    bad_text = "replaced"
    good_payload = _sign_payload(cfg, key, tag, good_text)
    other_tag = "20250111T120001Z"
    bad_payload = _sign_payload(cfg, key, other_tag, bad_text)
    payload_path = cfg.sigs_dir / f"{tag}.txt"
    sig_path = cfg.sigs_dir / f"{tag}.txt.sig"
    payload_path.write_bytes(good_payload)
    body = f"🦊🔏 {good_text} [signed:{tag}]".encode()

    import porch3.verifycli as vc

    real = vc._read_regular_nofollow
    opens: list[Path] = []
    state = {"n": 0}

    def track_and_swap(path, *, limit, label):
        opens.append(Path(path))
        data = real(path, limit=limit, label=label)
        if path == payload_path:
            state["n"] += 1
            if state["n"] == 1:
                payload_path.write_bytes(bad_payload)
        return data

    seen_cmds: list[list[str]] = []
    real_run = vc.subprocess.run

    def spy_run(cmd, **kwargs):
        seen_cmds.append(list(cmd))
        return real_run(cmd, **kwargs)

    monkeypatch.setattr(vc, "_read_regular_nofollow", track_and_swap)
    monkeypatch.setattr(vc.subprocess, "run", spy_run)
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_OK, msg
    assert state["n"] == 1
    assert opens.count(payload_path) == 1
    assert opens.count(sig_path) == 1
    assert opens.count(cfg.allowed_signers) == 1
    # Crypto argv must use private copies, never the live paths.
    assert seen_cmds
    crypto = seen_cmds[-1]
    assert str(payload_path) not in crypto
    assert str(sig_path) not in crypto
    assert str(cfg.allowed_signers) not in crypto


def test_sig_and_signers_swap_after_open_still_verifies(cfg, tmp_path, monkeypatch):
    """Deterministic swap of sig + allowed_signers after the held read."""
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T130000Z"
    text = "stable"
    _sign_payload(cfg, key, tag, text)
    body = f"🦊🔏 {text} [signed:{tag}]".encode()
    sig_path = cfg.sigs_dir / f"{tag}.txt.sig"
    signers = cfg.allowed_signers

    import porch3.verifycli as vc

    real = vc._read_regular_nofollow

    def swap_after(path, *, limit, label):
        data = real(path, limit=limit, label=label)
        if path == sig_path:
            # FIFO / garbage where the live sig was — crypto must use held copy.
            sig_path.unlink()
            os.mkfifo(sig_path)
        if path == signers:
            signers.write_text("bogus-principal namespaces=\"x\" ssh-ed25519 AAAA\n")
        return data

    monkeypatch.setattr(vc, "_read_regular_nofollow", swap_after)
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_OK, msg
    # Cleanup FIFO so tmp teardown doesn't hang.
    if sig_path.exists() or sig_path.is_fifo():
        sig_path.unlink()


def test_symlink_channel_dir_outside_refused(cfg, tmp_path):
    """A channel directory that is a symlink outside channels/ is skipped."""
    outside = tmp_path / "outside-channel"
    (outside / "messages").mkdir(parents=True)
    (outside / "messages" / f"{CANON_MID}.msg").write_text("x")
    cfg.channels_dir.mkdir(parents=True, exist_ok=True)
    link = cfg.channels_dir / "evil"
    link.symlink_to(outside)
    code, msg = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_LOOKUP
    assert "not found" in msg


def test_channel_open_eio_does_not_yield_unique_success(cfg, monkeypatch):
    """Environmental open failure must not collapse into a unique good hit."""
    import errno

    import porch3.verifycli as vc

    good = b'{"id":"x"}\n---\ngood-body\n'
    path = _write_msg(cfg, "commons", CANON_MID, "placeholder")
    path.write_bytes(good)
    noisy = cfg.channels_dir / "noisy"
    (noisy / "messages").mkdir(parents=True)

    real_open = vc._open_dir_nofollow

    def flaky_open(name, *, dir_fd=None, label=""):
        if name == "noisy" or (isinstance(name, str) and name.endswith("noisy")):
            raise vc.LookupIOError("cannot open channel 'noisy': [Errno 5] I/O error") from OSError(
                errno.EIO, "I/O error"
            )
        return real_open(name, dir_fd=dir_fd, label=label)

    monkeypatch.setattr(vc, "_open_dir_nofollow", flaky_open)
    with pytest.raises(vc.LookupIOError, match="I/O error|cannot open"):
        vc.held_read_unique_message(cfg.mail_root, CANON_MID)
    code, msg = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_ENV
    assert "open" in msg or "I/O" in msg or "cannot" in msg


def test_expected_unsafe_channel_entries_still_skipped(cfg, tmp_path, monkeypatch):
    """ENOENT/ELOOP/ENOTDIR channel opens remain skippable, not EXIT_ENV."""
    import errno

    import porch3.verifycli as vc

    path = _write_msg(cfg, "commons", CANON_MID, "🦊🔏 x [signed:T]")
    genuine = path.read_bytes()
    # Symlink channel (ELOOP under O_NOFOLLOW) must stay skipped.
    outside = tmp_path / "outside-channel"
    (outside / "messages").mkdir(parents=True)
    (cfg.channels_dir / "evil").symlink_to(outside)
    # Plain file sitting where a channel dir should be (ENOTDIR).
    (cfg.channels_dir / "notadir").write_text("nope")

    real_open = vc._open_dir_nofollow
    seen_enotdir = {"n": 0}

    def spy_open(name, *, dir_fd=None, label=""):
        try:
            return real_open(name, dir_fd=dir_fd, label=label)
        except vc.LookupIOError as exc:
            cause = exc.__cause__
            if isinstance(cause, OSError) and cause.errno == errno.ENOTDIR:
                seen_enotdir["n"] += 1
            raise

    monkeypatch.setattr(vc, "_open_dir_nofollow", spy_open)
    # Unique good hit still wins; unsafe entries were skipped, not env.
    assert vc.held_read_unique_message(cfg.mail_root, CANON_MID) == genuine
    code, msg = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_FAIL  # no signature — but lookup succeeded
    assert "not found" not in msg
    assert seen_enotdir["n"] >= 1

def test_symlink_messages_dir_outside_refused(cfg, tmp_path):
    channel = cfg.channels_dir / "commons"
    channel.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside-messages"
    outside.mkdir()
    (outside / f"{CANON_MID}.msg").write_text("x")
    (channel / "messages").symlink_to(outside)
    code, msg = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_LOOKUP


def test_explicit_channel_symlink_refused(cfg, tmp_path):
    outside = tmp_path / "outside-channel"
    (outside / "messages").mkdir(parents=True)
    (outside / "messages" / f"{CANON_MID}.msg").write_bytes(b"body")
    cfg.channels_dir.mkdir(parents=True, exist_ok=True)
    (cfg.channels_dir / "commons").symlink_to(outside)
    code, msg = verify_message_id(CANON_MID, config=cfg, channel="commons")
    assert code == EXIT_ENV
    assert "symlink" in msg or "real directory" in msg


def test_message_regular_to_symlink_swap_refused(cfg, tmp_path, monkeypatch):
    """Deterministic regular→symlink swap after messages fd held, before openat."""
    path = _write_msg(cfg, "commons", CANON_MID, "🦊🔏 x [signed:T]")
    outside = tmp_path / "swapped.msg"
    outside.write_text("swapped")

    import porch3.verifycli as vc

    def swap_after_hold(mail_root, channel, message_id):
        path.unlink()
        path.symlink_to(outside)

    monkeypatch.setattr(vc, "_AFTER_MESSAGES_HELD", swap_after_hold)
    code, msg = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_ENV
    assert (
        "regular" in msg
        or "symlink" in msg
        or "cannot open" in msg
        or "symbolic" in msg
    )


def test_message_regular_to_fifo_swap_refused(cfg, tmp_path, monkeypatch):
    path = _write_msg(cfg, "commons", CANON_MID, "🦊🔏 x [signed:T]")

    import porch3.verifycli as vc

    def swap_fifo(mail_root, channel, message_id):
        path.unlink()
        os.mkfifo(path)

    monkeypatch.setattr(vc, "_AFTER_MESSAGES_HELD", swap_fifo)
    try:
        code, msg = verify_message_id(CANON_MID, config=cfg)
        assert code == EXIT_ENV
        assert (
            "regular" in msg
            or "cannot open" in msg
            or "FIFO" in msg
            or "not a regular" in msg
        )
    finally:
        if path.exists() or path.is_fifo():
            path.unlink()


def test_messages_ancestor_swap_keeps_held_bytes(cfg, tmp_path, monkeypatch):
    """After messages/ dirfd is held, swapping the pathname to an outside
    dir with the same basename must not feed outside bytes to verify."""
    import porch3.verifycli as vc

    outside = tmp_path / "outside-messages"
    outside.mkdir()
    (outside / f"{CANON_MID}.msg").write_bytes(b"outside")
    genuine = b'{"id":"x"}\n---\ngenuine-body\n'

    def run_once(*, channel: str | None):
        path = _write_msg(cfg, "commons", CANON_MID, "placeholder")
        path.write_bytes(genuine)
        # Undo any prior swap from a previous call in this test.
        channel_dir = cfg.channels_dir / "commons"
        messages = channel_dir / "messages"
        real = channel_dir / "messages.real"
        if messages.is_symlink():
            messages.unlink()
        if real.exists():
            if messages.exists():
                import shutil

                shutil.rmtree(messages)
            os.rename(real, messages)
            path.write_bytes(genuine)

        seen = {}

        def swap_ancestor(mail_root, ch, message_id):
            msgs = mail_root / "channels" / ch / "messages"
            renamed = mail_root / "channels" / ch / "messages.real"
            if msgs.exists() and not msgs.is_symlink():
                os.rename(msgs, renamed)
                os.symlink(outside, msgs)

        def capture(body, **kw):
            seen["body"] = body
            return EXIT_FAIL, "captured"

        monkeypatch.setattr(vc, "_AFTER_MESSAGES_HELD", swap_ancestor)
        monkeypatch.setattr(vc, "verify_body_bytes", capture)
        code, _ = verify_message_id(CANON_MID, config=cfg, channel=channel)
        assert code == EXIT_FAIL
        assert seen["body"] == b"genuine-body\n"
        assert b"outside" not in seen["body"]

    run_once(channel=None)
    run_once(channel="commons")


def test_symlink_message_refused(cfg, tmp_path):
    store = cfg.channels_dir / "commons" / "messages"
    store.mkdir(parents=True, exist_ok=True)
    real = tmp_path / "outside.msg"
    real.write_text("x")
    link = store / f"{CANON_MID}.msg"
    link.symlink_to(real)
    code, msg = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_ENV
    assert "regular" in msg or "cannot open" in msg or "symbolic" in msg


def test_open_regular_nofollow_includes_post_fstat_growth(tmp_path, monkeypatch):
    """Append after fstat must be included (or over-limit), never stale prefix."""
    import porch3.verifycli as vc

    path = tmp_path / "payload"
    path.write_bytes(b"old")
    real_fstat = vc.os.fstat
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

    monkeypatch.setattr(vc.os, "fstat", flaky_fstat)
    data = vc._read_regular_nofollow(path, limit=64, label="payload")
    assert data == b"old-appended"


def test_unreadable_message_is_environment(cfg):
    path = _write_msg(cfg, "commons", CANON_MID, "🦊🔏 x [signed:T]")
    os.chmod(path, 0)
    try:
        code, msg = verify_message_id(CANON_MID, config=cfg)
        assert code in (EXIT_ENV, EXIT_FAIL, EXIT_LOOKUP)
        if code == EXIT_ENV:
            assert "read" in msg or "stat" in msg or "open" in msg
    finally:
        os.chmod(path, 0o600)


def test_read_regular_nofollow_maps_read_failure_to_safe_read_error(
    tmp_path, monkeypatch
):
    """The shared held reader still yields SafeReadError, never a raw OSError."""
    import porch3.verifycli as vc

    path = tmp_path / "payload"
    path.write_bytes(b"x" * 10)
    real_open = vc.os.open
    real_read = vc.os.read
    target: dict[str, int | None] = {"fd": None}

    def spy_open(name, *args, **kwargs):
        fd = real_open(name, *args, **kwargs)
        if not isinstance(name, int) and Path(str(name)) == path:
            target["fd"] = fd
        return fd

    def boom_read(fd, *args, **kwargs):
        if target["fd"] is not None and fd == target["fd"]:
            raise OSError("injected read failure")
        return real_read(fd, *args, **kwargs)

    monkeypatch.setattr(vc.os, "open", spy_open)
    monkeypatch.setattr(vc.os, "read", boom_read)
    with pytest.raises(vc.SafeReadError, match="cannot read"):
        vc._read_regular_nofollow(path, limit=64, label="payload")


def test_read_regular_nofollow_refuses_fifo_as_safe_read_error(tmp_path):
    """Non-regular targets keep the historic 'not a regular file' phrasing."""
    import porch3.verifycli as vc

    fifo = tmp_path / "fifo"
    os.mkfifo(fifo)
    with pytest.raises(vc.SafeReadError, match="not a regular file"):
        vc._read_regular_nofollow(fifo, limit=64, label="payload")


def test_genuine_signature_round_trip(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T120000Z"
    text = "hello porch"
    _sign_payload(cfg, key, tag, text)
    body = f"🦊🔏 {text} [signed:{tag}]\n".encode()
    code, msg = verify_body_bytes(body, config=cfg)
    assert code == EXIT_OK, msg
    assert "VERIFIED" in msg


def test_stdin_bounded_rejects_oversize_without_ssh(cfg, monkeypatch, tmp_path):
    """--stdin reads at most MAX+1 and never spawns ssh-keygen on oversize."""
    from porch3 import verifycli as vc
    from porch3.config import emit_toml

    conf = tmp_path / "config.toml"
    conf.write_text(emit_toml(cfg))
    spawned = []

    class CountingStream:
        def __init__(self):
            self.requests = []

        def read(self, n=-1):
            self.requests.append(n)
            # Would be infinite if unbounded; return one oversize chunk.
            return b"x" * (n if n is not None and n > 0 else (vc._MAX_MSG_BYTES + 1))

    stream = CountingStream()

    def boom(*a, **k):
        spawned.append(1)
        raise AssertionError("ssh-keygen must not run")

    monkeypatch.setattr(vc.subprocess, "run", boom)
    monkeypatch.setattr(
        "porch3.roomcheck.apply_owner_crosscheck", lambda c: c
    )

    class FakeStdin:
        buffer = stream

    monkeypatch.setattr(vc.sys, "stdin", FakeStdin())
    monkeypatch.setattr(vc, "load_config", lambda path=None: cfg)
    code = vc.main(["--stdin"])
    assert code == EXIT_FAIL
    assert stream.requests == [vc._MAX_MSG_BYTES + 1]
    assert not spawned


def test_main_runs_owner_crosscheck(cfg, monkeypatch):
    from porch3 import verifycli

    calls = []

    def fake_cross(config):
        calls.append(config)
        return config.with_signing_disabled("test-disable")

    class FakeStdin:
        buffer = type("B", (), {"read": staticmethod(lambda n=-1: b"")})()

    monkeypatch.setattr(
        "porch3.roomcheck.apply_owner_crosscheck", fake_cross
    )
    monkeypatch.setattr(verifycli.sys, "stdin", FakeStdin())
    code = verifycli.main(["--stdin"])
    assert calls
    assert code == EXIT_FAIL


def test_v2_genuine_multiline_round_trip_is_body_exact(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T200000Z"
    body = "  first line\r\n\n🦊🔏 bait [signed:NOT-A-REF]\nlast\t \n"
    _sign_v2(cfg, key, tag, "commons", body)
    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        body,
        signature_ref={"version": 2, "tag": tag},
        envelope_channel="commons",
    )

    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_OK, message
    assert "VERIFIED" in message

    # Body-only input is deliberately the legacy v1 surface; it cannot infer
    # v2's storage channel or envelope locator.
    body_code, _ = verify_body_bytes(body.encode(), config=cfg)
    assert body_code == EXIT_FAIL

    held = held_read_unique_message_record(cfg.mail_root, CANON_MID)
    assert held.storage_channel == "commons"
    assert held.envelope["signature_ref"] == {"version": 2, "tag": tag}
    assert held.signature_ref_present is True
    assert held.body == body.encode()


def test_v2_explicit_channel_record_retains_absent_vs_null(cfg):
    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        "body",
        signature_ref=None,
        envelope_channel="commons",
    )
    held = held_read_channel_record(cfg.mail_root, "commons", CANON_MID)
    assert held.signature_ref_present is True
    assert held.envelope["signature_ref"] is None

    _write_msg(cfg, "commons", CANON_MID_B, "body")
    absent = held_read_channel_record(cfg.mail_root, "commons", CANON_MID_B)
    assert absent.signature_ref_present is False


@pytest.mark.parametrize(
    "locator",
    [
        None,
        [],
        {"version": True, "tag": "TAG"},
        {"version": 1, "tag": "TAG"},
        {"version": 2, "tag": "bad_tag"},
        {"version": 2, "tag": "TAG", "extra": 1},
        {"tag": "TAG"},
    ],
)
def test_owner_present_malformed_v2_locator_is_loud_without_v1_fallback(
    cfg, locator
):
    # The body is valid-looking v1 syntax. A present owner locator must still
    # select v2 and fail rather than falling back.
    body = "🦊🔏 hello [signed:TAG]"
    (cfg.sigs_dir / "TAG.txt").write_bytes(b"TAG\nhello\n")
    (cfg.sigs_dir / "TAG.txt.sig").write_bytes(b"x")
    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        body,
        signature_ref=locator,
        envelope_channel="commons",
    )
    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_FAIL
    assert "signature_ref" in message


def test_owner_present_null_never_calls_v1_verifier(cfg, monkeypatch):
    import porch3.verifycli as vc

    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        "🦊🔏 copied valid-looking v1 [signed:TAG]",
        signature_ref=None,
        envelope_channel="commons",
    )

    def forbidden(*args, **kwargs):
        raise AssertionError("present owner locator must not fall back to v1")

    monkeypatch.setattr(vc, "verify_body_bytes", forbidden)
    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_FAIL
    assert "signature_ref" in message


def test_non_owner_locator_cannot_fall_through_to_copied_valid_v1(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T201000Z"
    text = "legacy proof"
    _sign_payload(cfg, key, tag, text)
    body = f"🦊🔏 {text} [signed:{tag}]"
    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        body,
        sender="not-mara",
        signature_ref={"version": 999, "tag": "BAD"},
        envelope_channel="wrong-channel",
    )
    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_FAIL
    assert "configured owner" in message


def test_v2_binds_actual_storage_channel_and_body(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T202000Z"
    body = "signed body\n"
    _sign_v2(cfg, key, tag, "commons", body)
    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        body,
        signature_ref={"version": 2, "tag": tag},
        envelope_channel="renamed",
    )
    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_FAIL
    assert "storage channel" in message or "channel" in message

    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        body + "mutated",
        signature_ref={"version": 2, "tag": tag},
        envelope_channel="commons",
    )
    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_FAIL
    assert "manifest" in message or "differs" in message


def test_v2_oversize_fails_before_sidecar_reads_or_hash(cfg, monkeypatch):
    import porch3.verifycli as vc

    body = "x" * (MAX_SIGNED_BODY_BYTES + 1)
    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        body,
        signature_ref={"version": 2, "tag": "TAG"},
        envelope_channel="commons",
    )

    real_read = vc._read_regular_nofollow

    def forbidden(path, *, limit, label, dir_fd=None):
        if label == "message":
            return real_read(path, limit=limit, label=label, dir_fd=dir_fd)
        raise AssertionError("oversize v2 must fail before sidecars or hashing")

    monkeypatch.setattr(vc, "_read_regular_nofollow", forbidden)
    monkeypatch.setattr(vc, "manifest_bytes", forbidden)
    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_FAIL
    assert "1048576" in message or "1 MiB" in message


def test_v2_exact_cap_verifies(cfg, tmp_path):
    key = _install_signing_identity(cfg, tmp_path)
    tag = "20250111T203000Z"
    body = "x" * MAX_SIGNED_BODY_BYTES
    _sign_v2(cfg, key, tag, "commons", body)
    _write_msg(
        cfg,
        "commons",
        CANON_MID,
        body,
        signature_ref={"version": 2, "tag": tag},
        envelope_channel="commons",
    )
    code, message = verify_message_id(CANON_MID, config=cfg)
    assert code == EXIT_OK, message
