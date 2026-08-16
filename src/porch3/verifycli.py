"""porch-verify CLI — verify signed owner messages (A0a sibling / B0 §4).

Exit codes:
  0 verified
  1 failed-verification (any pipeline stage; message names the stage)
  2 usage/config
  3 not-found / duplicate id
  4 environment (ssh-keygen missing, IO, timeout)
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from porch3.config import (
    CONFIG_PATH,
    ConfigError,
    HeldIOError,
    PorchConfig,
    held_read_regular_nofollow,
    load_config,
)
from porch3.platform import require_macos
from porch3.signature_v2 import (
    MAX_SIGNED_BODY_BYTES,
    manifest_bytes,
    validate_tag,
)
from porch3.wire import WireFormat

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2
EXIT_LOOKUP = 3
EXIT_ENV = 4

# Post canonical channel message id: YYYYmmdd-HHMMSS-UUUUUU-<6 hex> (29 bytes).
_MSG_ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9]{6}-[0-9a-fA-F]{6}$")
# Post tag grammar: non-empty alnum-or-hyphen.
_TAG_RE = re.compile(r"\[signed:([0-9A-Za-z-]+)\]")
_VERIFY_TIMEOUT_S = 10.0

_MAX_MSG_BYTES = 4 << 20
_MAX_PAYLOAD_BYTES = 1 << 20
_MAX_SIG_BYTES = 64 * 1024
_MAX_SIGNERS_BYTES = 1 << 20

# Post reserved room/channel names (mailbox.rs RESERVED_ROOM_NAMES).
_RESERVED_NAMES = frozenset(
    {
        "*",
        "archive",
        "rooms.json",
        "rules.json",
        "profiles.json",
        "owner.json",
        ".rooms.lock",
    }
)


class LookupIOError(Exception):
    """Root/per-channel IO during lookup — must be exit 4, never false zero."""


class SafeReadError(Exception):
    """O_NOFOLLOW open / fstat / bounded-read failure (maps to exit 4)."""


class MessageNotFound(Exception):
    """No unique channel message hit under the held channels tree."""


class DuplicateMessage(Exception):
    """Multiple channel message hits for one id — fail closed."""


@dataclass(frozen=True)
class HeldMessage:
    """One channel message read through a held storage-directory chain.

    ``storage_channel`` comes from the directory opened by the verifier; it is
    never inferred from the sender-controlled JSON envelope. ``body`` retains
    every byte after Post's exact envelope separator.
    """

    storage_channel: str
    envelope: dict[str, object] | None
    body: bytes
    raw: bytes

    @property
    def signature_ref_present(self) -> bool:
        return self.envelope is not None and "signature_ref" in self.envelope


# Dir-open failures that mean "skip this entry" rather than environment IO.
# EACCES/EIO and friends must NOT be swallowed — they are EXIT_ENV.
_EXPECTED_UNSAFE_DIR_ERRNOS = frozenset(
    {
        errno.ENOENT,
        errno.ELOOP,
        errno.ENOTDIR,
    }
)


def _is_expected_unsafe_dir_open(exc: BaseException) -> bool:
    """True for absent/symlink/non-directory entries during channel walks."""
    if isinstance(exc, FileNotFoundError):
        return True
    if isinstance(exc, NotADirectoryError):
        return True
    if isinstance(exc, LookupIOError) and exc.__cause__ is not None:
        return _is_expected_unsafe_dir_open(exc.__cause__)
    if isinstance(exc, OSError) and exc.errno in _EXPECTED_UNSAFE_DIR_ERRNOS:
        return True
    return False


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def validate_message_id(value: str) -> str | None:
    """Return an error message if ``value`` is not a Post channel-message id."""
    if not value or not _MSG_ID_RE.fullmatch(value):
        return (
            f"invalid message id {value!r} "
            "(want YYYYmmdd-HHMMSS-UUUUUU-<6 hex>)"
        )
    return None


def validate_channel_name(value: str) -> str | None:
    """Post room/channel grammar: one path-safe component, not reserved."""
    if not value:
        return "invalid channel name ''"
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value):
        return f"invalid channel name {value!r}"
    if value in {".", ".."} or "/" in value or "\\" in value:
        return f"invalid channel name {value!r}"
    # Path component check (refuse multi-component / empty).
    parts = Path(value).parts
    if len(parts) != 1 or parts[0] != value:
        return f"invalid channel name {value!r}"
    folded = value.lower()
    if folded in _RESERVED_NAMES or (
        folded.startswith(".rooms.json.") and folded.endswith(".tmp")
    ):
        return f"invalid channel name {value!r} (reserved)"
    return None


# Back-compat alias used by older tests / callers.
def validate_lookup_name(value: str, *, kind: str) -> str | None:
    if kind == "message id":
        return validate_message_id(value)
    return validate_channel_name(value)


def _strip_msg_envelope(raw: bytes) -> bytes:
    """If raw starts with a JSON header + --- separator, return body bytes only.

    Byte-exact: only the literal ``\\n---\\n`` separator is recognized.
    """
    if not raw.startswith(b"{"):
        return raw
    sep = b"\n---\n"
    idx = raw.find(sep)
    if idx < 0:
        return raw
    return raw[idx + len(sep) :]


def _held_message(storage_channel: str, raw: bytes) -> HeldMessage:
    """Parse held bytes without weakening the legacy body-only fallback."""
    envelope: dict[str, object] | None = None
    body = _strip_msg_envelope(raw)
    if raw.startswith(b"{"):
        sep = b"\n---\n"
        idx = raw.find(sep)
        if idx >= 0:
            try:
                parsed = json.loads(raw[:idx].decode("utf-8", errors="strict"))
            except (UnicodeDecodeError, ValueError, TypeError):
                parsed = None
            if isinstance(parsed, dict):
                envelope = parsed
                body = raw[idx + len(sep) :]
    return HeldMessage(
        storage_channel=storage_channel,
        envelope=envelope,
        body=body,
        raw=raw,
    )


def _is_real_dir(path: Path) -> bool:
    """True only for a non-symlink directory (lstat, never follow)."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and not stat.S_ISLNK(st.st_mode)


def _symlink_free_under(path: Path, root: Path) -> bool:
    """True when ``path`` is under ``root`` with no symlink ancestors.

    Uses lexical containment plus per-component lstat — never resolves
    through a symlink that escapes the root.
    """
    try:
        path_abs = path if path.is_absolute() else path.absolute()
        root_abs = root if root.is_absolute() else root.absolute()
    except OSError:
        return False
    try:
        rel = path_abs.relative_to(root_abs)
    except ValueError:
        return False
    cur = root_abs
    try:
        st = os.lstat(cur)
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return False
    for part in rel.parts:
        cur = cur / part
        try:
            st = os.lstat(cur)
        except OSError:
            return False
        if stat.S_ISLNK(st.st_mode):
            return False
    return True


def _read_regular_nofollow(
    path: Path, *, limit: int, label: str, dir_fd: int | None = None
) -> bytes:
    """Verify-boundary wrapper: held EOF read mapped to ``SafeReadError``.

    One shared primitive with the config loader — the open/fstat/read loop is
    not duplicated here, so a bound fix lands on both CLIs at once.
    """
    try:
        return held_read_regular_nofollow(
            path, limit=limit, label=label, dir_fd=dir_fd
        ).data
    except FileNotFoundError:
        raise
    except HeldIOError as exc:
        msg = str(exc)
        if "regular file" in msg:
            raise SafeReadError(
                f"{label} is not a regular file (symlink/special refused)"
            ) from exc
        raise SafeReadError(msg) from exc


def _open_dir_nofollow(
    name: str | Path, *, dir_fd: int | None = None, label: str
) -> int:
    """Open a directory with O_DIRECTORY|O_NOFOLLOW (held ancestor chain)."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        if dir_fd is None:
            return os.open(name, flags)
        return os.open(str(name), flags, dir_fd=dir_fd)
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise LookupIOError(f"cannot open {label}: {exc}") from exc


def _held_read_under_messages(
    messages_fd: int, message_id: str, *, limit: int
) -> bytes | None:
    """openat the final ``{id}.msg`` relative to a held messages dirfd."""
    name = f"{message_id}.msg"
    try:
        return _read_regular_nofollow(
            Path(name), limit=limit, label="message", dir_fd=messages_fd
        )
    except FileNotFoundError:
        return None


# Test seam: invoked after messages dirfd is held, before openat of the file.
_AFTER_MESSAGES_HELD = None


def held_read_channel_message(
    mail_root: Path,
    channel: str,
    message_id: str,
    *,
    limit: int = _MAX_MSG_BYTES,
) -> bytes:
    """Held dirfd/openat read of ``channels/<channel>/messages/<id>.msg``.

    Opens mail_root → channels → channel → messages with
    ``O_DIRECTORY|O_NOFOLLOW``, then openat the file relative to the held
    messages fd. Ancestor pathname swaps after the hold cannot redirect the
    final open.
    """
    root_fd = _open_dir_nofollow(mail_root, label="mail_root")
    try:
        channels_fd = _open_dir_nofollow(
            "channels", dir_fd=root_fd, label="channels"
        )
        try:
            channel_fd = _open_dir_nofollow(
                channel, dir_fd=channels_fd, label=f"channel {channel!r}"
            )
            try:
                messages_fd = _open_dir_nofollow(
                    "messages", dir_fd=channel_fd, label="messages"
                )
                try:
                    if _AFTER_MESSAGES_HELD is not None:
                        _AFTER_MESSAGES_HELD(mail_root, channel, message_id)
                    data = _held_read_under_messages(
                        messages_fd, message_id, limit=limit
                    )
                finally:
                    os.close(messages_fd)
            finally:
                os.close(channel_fd)
        finally:
            os.close(channels_fd)
    finally:
        os.close(root_fd)
    if data is None:
        raise MessageNotFound(f"message id {message_id!r} not found")
    return data


def held_read_channel_record(
    mail_root: Path,
    channel: str,
    message_id: str,
    *,
    limit: int = _MAX_MSG_BYTES,
) -> HeldMessage:
    """Return held message bytes together with their actual storage channel."""
    raw = held_read_channel_message(
        mail_root, channel, message_id, limit=limit
    )
    return _held_message(channel, raw)


def held_read_unique_message_record(
    mail_root: Path,
    message_id: str,
    *,
    limit: int = _MAX_MSG_BYTES,
) -> HeldMessage:
    """Unique global lookup under ``channels/*/messages/<id>.msg`` via held fds.

    Only real (non-symlink) channel/messages directories participate. Zero hits
    → ``MessageNotFound``; multiple → ``DuplicateMessage``. Noncanonical
    ``mail_root/planted/<id>.msg`` paths are never consulted.
    """
    try:
        root_fd = _open_dir_nofollow(mail_root, label="mail_root")
    except FileNotFoundError as exc:
        raise MessageNotFound(f"message id {message_id!r} not found") from exc
    hits: list[HeldMessage] = []
    try:
        try:
            channels_fd = _open_dir_nofollow(
                "channels", dir_fd=root_fd, label="channels"
            )
        except FileNotFoundError:
            raise MessageNotFound(f"message id {message_id!r} not found") from None
        try:
            try:
                entries = os.listdir(channels_fd)
            except OSError as exc:
                raise LookupIOError(f"cannot list channels: {exc}") from exc
            for name in entries:
                if name in {".", ".."}:
                    continue
                # Refuse path-separator / reserved names without opening.
                if validate_channel_name(name) is not None:
                    continue
                try:
                    channel_fd = _open_dir_nofollow(
                        name, dir_fd=channels_fd, label=f"channel {name!r}"
                    )
                except FileNotFoundError:
                    continue
                except LookupIOError as exc:
                    if _is_expected_unsafe_dir_open(exc):
                        continue
                    raise
                try:
                    try:
                        messages_fd = _open_dir_nofollow(
                            "messages", dir_fd=channel_fd, label="messages"
                        )
                    except FileNotFoundError:
                        continue
                    except LookupIOError as exc:
                        if _is_expected_unsafe_dir_open(exc):
                            continue
                        raise
                    try:
                        if _AFTER_MESSAGES_HELD is not None:
                            _AFTER_MESSAGES_HELD(mail_root, name, message_id)
                        data = _held_read_under_messages(
                            messages_fd, message_id, limit=limit
                        )
                    finally:
                        os.close(messages_fd)
                finally:
                    os.close(channel_fd)
                if data is not None:
                    hits.append(_held_message(name, data))
                    if len(hits) > 1:
                        raise DuplicateMessage(
                            f"duplicate message id {message_id!r} ({len(hits)} hits)"
                        )
        finally:
            os.close(channels_fd)
    finally:
        os.close(root_fd)
    if not hits:
        raise MessageNotFound(f"message id {message_id!r} not found")
    return hits[0]


def held_read_unique_message(
    mail_root: Path,
    message_id: str,
    *,
    limit: int = _MAX_MSG_BYTES,
) -> bytes:
    """Compatibility bytes-only wrapper around the held record lookup."""
    return held_read_unique_message_record(
        mail_root, message_id, limit=limit
    ).raw


def _find_message_paths(mail_root: Path, message_id: str) -> list[Path]:
    """Path inventory for tests/legacy — not the authority open path.

    Authority consumers must use ``held_read_unique_message`` /
    ``held_read_channel_message`` so the final open is relative to held fds.
    """
    channels = mail_root / "channels"
    try:
        if not channels.exists():
            return []
    except OSError as exc:
        raise LookupIOError(f"cannot list channels root: {exc}") from exc
    if not _is_real_dir(channels):
        raise LookupIOError(
            f"channels root {channels} is not a real directory"
        )
    hits: list[Path] = []
    try:
        entries = list(channels.iterdir())
    except OSError as exc:
        raise LookupIOError(f"cannot list channels: {exc}") from exc
    for channel_dir in entries:
        if not _is_real_dir(channel_dir):
            continue
        if validate_channel_name(channel_dir.name) is not None:
            continue
        if not _symlink_free_under(channel_dir, channels):
            continue
        messages_dir = channel_dir / "messages"
        if not _is_real_dir(messages_dir):
            continue
        if not _symlink_free_under(messages_dir, channels):
            continue
        path = messages_dir / f"{message_id}.msg"
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise LookupIOError(f"cannot stat message {path}: {exc}") from exc
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise LookupIOError(
                f"message hit {path} is not a regular file (symlink/special refused)"
            )
        hits.append(path)
    return hits


# Back-compat alias.
_find_messages = _find_message_paths


def _age_string(ts: str) -> str:
    clean = ts.replace("-", "").replace(":", "")
    try:
        if len(clean) >= 16 and clean.endswith("Z"):
            then = datetime.strptime(clean[:15] + "Z", "%Y%m%dT%H%M%SZ").replace(
                tzinfo=timezone.utc
            )
        else:
            return "age unparseable; check freshness manually"
    except ValueError:
        return "age unparseable; check freshness manually"
    age = int(time.time() - then.timestamp())
    if age < 3600:
        return f"{age // 60}m ago"
    if age < 172800:
        return f"{age // 3600}h ago — CHECK: is this current?"
    return f"{age // 86400}d ago — STALE: possible replay, reconfirm in-session"


def _ssh_verify(
    *,
    payload_bytes: bytes,
    sig_bytes: bytes,
    signers_bytes: bytes,
    principal: str,
    namespace: str,
) -> tuple[int, str]:
    """Verify using held bytes only — never reopens operator-controlled paths.

    Signature and allowed_signers are written to private verified copies under
    an exclusive temp dir so ssh-keygen cannot race a pathname swap.
    """
    if shutil.which("ssh-keygen") is None:
        return EXIT_ENV, "ssh-keygen missing"
    try:
        with tempfile.TemporaryDirectory(prefix="porch-verify-") as tmp:
            tmp_path = Path(tmp)
            sig_path = tmp_path / "msg.sig"
            signers_path = tmp_path / "allowed_signers"
            sig_path.write_bytes(sig_bytes)
            signers_path.write_bytes(signers_bytes)
            os.chmod(sig_path, 0o600)
            os.chmod(signers_path, 0o600)
            result = subprocess.run(
                [
                    "ssh-keygen",
                    "-Y",
                    "verify",
                    "-f",
                    str(signers_path),
                    "-I",
                    principal,
                    "-n",
                    namespace,
                    "-s",
                    str(sig_path),
                ],
                input=payload_bytes,
                capture_output=True,
                timeout=_VERIFY_TIMEOUT_S,
            )
    except subprocess.TimeoutExpired:
        return EXIT_ENV, "ssh-keygen verify timed out"
    except OSError as exc:
        return EXIT_ENV, f"ssh-keygen IO error: {exc}"
    if result.returncode != 0:
        return EXIT_FAIL, "signature does not verify"
    return EXIT_OK, "ok"


def _parse_canonical_payload(
    payload_bytes: bytes,
) -> tuple[tuple[str, str] | None, str]:
    """Parse TAG\\nCHANNEL_TEXT[\\n] as raw bytes — no newline normalization."""
    if b"\r" in payload_bytes:
        return None, "signed payload has noncanonical newlines"
    if b"\n" not in payload_bytes:
        return None, "signed payload missing channel text line"
    first, rest = payload_bytes.split(b"\n", 1)
    # Allow exactly one optional trailing newline after the channel text.
    if rest.endswith(b"\n"):
        second = rest[:-1]
        if b"\n" in second:
            return None, "signed payload has extra/noncanonical structure"
    else:
        second = rest
        if b"\n" in second:
            return None, "signed payload has extra/noncanonical structure"
    if not first:
        return None, "empty signed payload"
    try:
        tag_line = first.decode("utf-8")
        signed_line = second.decode("utf-8")
    except UnicodeDecodeError:
        return None, "signed payload is not valid UTF-8"
    return (tag_line, signed_line), ""


def verify_body_bytes(
    body: bytes,
    *,
    config: PorchConfig,
    wire: WireFormat | None = None,
) -> tuple[int, str]:
    """Verify a message body (raw bytes) against its detached sidecar.

    Strict UTF-8 with NO error replacement and NO newline normalization.
    Invalid UTF-8 → exit 1 (failed-verification), not silent replace.
    """
    if config.signing_disabled:
        return EXIT_FAIL, f"verification disabled: {config.signing_disabled_reason}"

    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return EXIT_FAIL, "invalid UTF-8 body"

    wire = wire if wire is not None else config.wire
    tags = _TAG_RE.findall(text)
    if not tags:
        return EXIT_FAIL, "no signature reference found (missing [signed:TS] tag)"
    if len(tags) != 1:
        return (
            EXIT_FAIL,
            f"strict wire grammar requires exactly one [signed:] tag "
            f"(found {len(tags)})",
        )
    tag = tags[0]
    if not tag or not all(c.isalnum() or c == "-" for c in tag):
        return EXIT_FAIL, "malformed signature tag"

    channel_text = wire.channel_text_for_verify(text, tag)
    if channel_text is None:
        return EXIT_FAIL, "channel text not found in body (exact one-line wire required)"

    payload = config.sigs_dir / f"{tag}.txt"
    sig = config.sigs_dir / f"{tag}.txt.sig"

    # Open each detached input ONCE (O_NOFOLLOW); hold bytes through crypto.
    try:
        payload_bytes = _read_regular_nofollow(
            payload, limit=_MAX_PAYLOAD_BYTES, label="payload"
        )
    except FileNotFoundError:
        return EXIT_FAIL, f"missing detached payload at {payload}"
    except SafeReadError as exc:
        return EXIT_ENV, str(exc)

    try:
        sig_bytes = _read_regular_nofollow(sig, limit=_MAX_SIG_BYTES, label="signature")
    except FileNotFoundError:
        return EXIT_FAIL, f"missing detached signature at {sig}"
    except SafeReadError as exc:
        return EXIT_ENV, str(exc)

    parsed = _parse_canonical_payload(payload_bytes)
    if parsed[0] is None:
        return EXIT_FAIL, parsed[1]
    tag_line, signed_line = parsed[0]

    if tag_line != tag:
        return (
            EXIT_FAIL,
            f"tag [signed:{tag}] does not match the signed payload's own "
            "timestamp — possible rename-replay",
        )
    if channel_text != signed_line:
        return EXIT_FAIL, "channel text differs from signed payload — FORGED body"

    # Missing allowed_signers is runtime FAILED (exit 1); unreadable → env 4.
    signers = config.allowed_signers
    try:
        signers_bytes = _read_regular_nofollow(
            signers, limit=_MAX_SIGNERS_BYTES, label="allowed_signers"
        )
    except FileNotFoundError:
        return EXIT_FAIL, f"no allowed_signers at {signers}"
    except SafeReadError as exc:
        return EXIT_ENV, str(exc)

    code, detail = _ssh_verify(
        payload_bytes=payload_bytes,
        sig_bytes=sig_bytes,
        signers_bytes=signers_bytes,
        principal=config.principal,
        namespace=config.signing_namespace,
    )
    if code != EXIT_OK:
        stage = "ssh-keygen" if code == EXIT_ENV else "signature"
        return code, f"{stage}: {detail}"

    age = _age_string(tag)
    return (
        EXIT_OK,
        f"VERIFIED: {config.verified_render()} — signed {tag} ({age})",
    )


def _owner_v2_tag(
    held: HeldMessage, *, config: PorchConfig
) -> tuple[bool, str | None, str]:
    """Select and strictly parse an owner's present v2 locator.

    The first tuple item says whether v2 was selected. A locator on any other
    sender is inert and therefore leaves legacy v1 body verification intact.
    """
    envelope = held.envelope
    if (
        envelope is None
        or envelope.get("from") != config.owner_room
        or "signature_ref" not in envelope
    ):
        return False, None, ""
    locator = envelope["signature_ref"]
    if type(locator) is not dict or set(locator) != {"version", "tag"}:
        return True, None, "malformed signature_ref: want exactly version and tag"
    if type(locator["version"]) is not int or locator["version"] != 2:
        return True, None, "malformed signature_ref: version must be integer 2"
    tag = locator["tag"]
    try:
        validate_tag(tag)
    except (TypeError, ValueError) as exc:
        return True, None, f"malformed signature_ref: {exc}"
    return True, tag, ""


def _verify_v2_held(
    held: HeldMessage,
    *,
    tag: str,
    config: PorchConfig,
) -> tuple[int, str]:
    """Verify one selected v2 message from its held full-message record."""
    if config.signing_disabled:
        return EXIT_FAIL, f"verification disabled: {config.signing_disabled_reason}"

    # This check intentionally precedes UTF-8 decoding, hashing, manifest
    # construction, and every sidecar read.
    if len(held.body) > MAX_SIGNED_BODY_BYTES:
        return (
            EXIT_FAIL,
            f"signed v2 body exceeds {MAX_SIGNED_BODY_BYTES} bytes (1 MiB)",
        )

    envelope = held.envelope
    if envelope is None:  # selected v2 always has an envelope; defensive typing
        return EXIT_FAIL, "malformed signature_ref envelope"
    envelope_channel = envelope.get("channel")
    if not isinstance(envelope_channel, str):
        return EXIT_FAIL, "signed v2 envelope channel is missing or not a string"
    if envelope_channel != held.storage_channel:
        return (
            EXIT_FAIL,
            "signed v2 envelope channel differs from actual storage channel",
        )
    try:
        body_text = held.body.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return EXIT_FAIL, "invalid UTF-8 body"
    try:
        expected_manifest = manifest_bytes(tag, held.storage_channel, body_text)
    except (TypeError, ValueError) as exc:
        return EXIT_FAIL, f"cannot construct signed v2 manifest: {exc}"

    payload = config.sigs_dir / f"{tag}.txt"
    sig = config.sigs_dir / f"{tag}.txt.sig"
    try:
        payload_bytes = _read_regular_nofollow(
            payload, limit=_MAX_PAYLOAD_BYTES, label="payload"
        )
    except FileNotFoundError:
        return EXIT_FAIL, f"missing detached payload at {payload}"
    except SafeReadError as exc:
        return EXIT_ENV, str(exc)
    try:
        sig_bytes = _read_regular_nofollow(
            sig, limit=_MAX_SIG_BYTES, label="signature"
        )
    except FileNotFoundError:
        return EXIT_FAIL, f"missing detached signature at {sig}"
    except SafeReadError as exc:
        return EXIT_ENV, str(exc)

    if payload_bytes != expected_manifest:
        return EXIT_FAIL, "signed v2 manifest differs from held message"

    signers = config.allowed_signers
    try:
        signers_bytes = _read_regular_nofollow(
            signers, limit=_MAX_SIGNERS_BYTES, label="allowed_signers"
        )
    except FileNotFoundError:
        return EXIT_FAIL, f"no allowed_signers at {signers}"
    except SafeReadError as exc:
        return EXIT_ENV, str(exc)

    code, detail = _ssh_verify(
        payload_bytes=payload_bytes,
        sig_bytes=sig_bytes,
        signers_bytes=signers_bytes,
        principal=config.principal,
        namespace=config.signing_namespace,
    )
    if code != EXIT_OK:
        stage = "ssh-keygen" if code == EXIT_ENV else "signature"
        return code, f"{stage}: {detail}"
    age = _age_string(tag)
    return (
        EXIT_OK,
        f"VERIFIED: {config.verified_render()} — signed {tag} ({age})",
    )


def verify_held_message(
    held: HeldMessage,
    *,
    config: PorchConfig,
    wire: WireFormat | None = None,
) -> tuple[int, str]:
    """Verify a full held message, selecting v2 only from owner metadata."""
    envelope_sender = (
        held.envelope.get("from") if held.envelope is not None else None
    )
    if (
        isinstance(envelope_sender, str)
        and envelope_sender != config.owner_room
    ):
        return EXIT_FAIL, "message sender is not the configured owner"
    selected, tag, error = _owner_v2_tag(held, config=config)
    if selected:
        if error:
            return EXIT_FAIL, error
        assert tag is not None
        return _verify_v2_held(held, tag=tag, config=config)
    return verify_body_bytes(held.body, config=config, wire=wire)


def _resolve_channel_message_path(
    config: PorchConfig, channel: str, message_id: str
) -> tuple[list[Path], str | None]:
    """Path inventory for explicit --channel (tests/legacy only).

    Authority open uses ``held_read_channel_message``.
    """
    channels = config.channels_dir
    if not _is_real_dir(channels):
        return [], f"channels root {channels} is not a real directory"
    channel_dir = channels / channel
    if not _is_real_dir(channel_dir) or not _symlink_free_under(channel_dir, channels):
        try:
            st = os.lstat(channel_dir)
        except FileNotFoundError:
            return [], None
        except OSError as exc:
            return [], f"cannot stat channel: {exc}"
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            return [], (
                f"channel {channel!r} is not a real directory under channels "
                "(symlink/escape refused)"
            )
        return [], (
            f"channel {channel!r} escapes the mail channels root "
            "(symlink ancestors refused)"
        )
    messages_dir = channel_dir / "messages"
    if not _is_real_dir(messages_dir) or not _symlink_free_under(
        messages_dir, channels
    ):
        try:
            st = os.lstat(messages_dir)
        except FileNotFoundError:
            return [], None
        except OSError as exc:
            return [], f"cannot stat messages dir: {exc}"
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            return [], (
                f"messages dir for {channel!r} is not a real directory "
                "(symlink/escape refused)"
            )
        return [], (
            f"messages dir for {channel!r} escapes the mail channels root"
        )
    path = messages_dir / f"{message_id}.msg"
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return [], None
    except OSError as exc:
        return [], f"cannot stat message: {exc}"
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        return [], f"message {path} is not a regular file"
    return [path], None


def verify_message_id(
    message_id: str,
    *,
    config: PorchConfig,
    channel: str | None = None,
) -> tuple[int, str]:
    err = validate_message_id(message_id)
    if err:
        return EXIT_USAGE, err
    if channel is not None:
        ch_err = validate_channel_name(channel)
        if ch_err:
            return EXIT_USAGE, ch_err
        # Preflight symlink/escape on the explicit channel path for ENV mapping.
        _hits, env_err = _resolve_channel_message_path(config, channel, message_id)
        if env_err:
            return EXIT_ENV, env_err
        try:
            held = held_read_channel_record(
                config.mail_root, channel, message_id, limit=_MAX_MSG_BYTES
            )
        except MessageNotFound:
            return EXIT_LOOKUP, f"message id {message_id!r} not found"
        except LookupIOError as exc:
            return EXIT_ENV, str(exc)
        except SafeReadError as exc:
            return EXIT_ENV, str(exc)
        except FileNotFoundError:
            return EXIT_LOOKUP, f"message id {message_id!r} not found"
    else:
        try:
            held = held_read_unique_message_record(
                config.mail_root, message_id, limit=_MAX_MSG_BYTES
            )
        except MessageNotFound:
            return EXIT_LOOKUP, f"message id {message_id!r} not found"
        except DuplicateMessage as exc:
            return EXIT_LOOKUP, str(exc)
        except LookupIOError as exc:
            return EXIT_ENV, str(exc)
        except SafeReadError as exc:
            return EXIT_ENV, str(exc)
        except FileNotFoundError:
            return EXIT_LOOKUP, f"message id {message_id!r} not found"
    return verify_held_message(held, config=config)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="porch-verify",
        description="Verify a signed porch owner message",
    )
    p.add_argument(
        "message_id",
        nargs="?",
        help="exact message id under the resolved mail_root",
    )
    p.add_argument(
        "--stdin",
        action="store_true",
        help="verify a body supplied on stdin (raw bytes)",
    )
    p.add_argument("--channel", default=None, help="limit id lookup to one channel")
    p.add_argument(
        "--config",
        default=None,
        help=f"porch config.toml (default: {CONFIG_PATH})",
    )
    return p


def read_stdin_bounded(stream=None, *, limit: int = _MAX_MSG_BYTES) -> bytes:
    """Read at most ``limit + 1`` bytes; raise ``SafeReadError`` if oversize."""
    buf = sys.stdin.buffer if stream is None else stream
    raw = buf.read(limit + 1)
    if len(raw) > limit:
        raise SafeReadError(f"stdin exceeds {limit} bytes")
    return raw


def main(argv: list[str] | None = None) -> int:
    require_macos()
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return int(code) if isinstance(code, int) else EXIT_USAGE

    if args.stdin and args.message_id:
        _eprint("usage: pass either a message id or --stdin, not both")
        return EXIT_USAGE
    if args.stdin and args.channel is not None:
        _eprint("usage: --channel cannot be combined with --stdin")
        return EXIT_USAGE
    if not args.stdin and not args.message_id:
        _eprint("usage: porch-verify <message-id> | porch-verify --stdin")
        return EXIT_USAGE

    try:
        config = load_config(Path(args.config) if args.config else None)
    except ConfigError as exc:
        _eprint(f"config: {exc}")
        return EXIT_USAGE

    from porch3.roomcheck import RoomInvariantError, apply_owner_crosscheck

    try:
        config = apply_owner_crosscheck(config)
    except RoomInvariantError as exc:
        _eprint(f"room invariant: {exc}")
        return EXIT_USAGE

    if args.stdin:
        try:
            raw = read_stdin_bounded()
        except SafeReadError as exc:
            _eprint(f"FAIL: {exc}")
            return EXIT_FAIL
        body = _strip_msg_envelope(raw)
        code, msg = verify_body_bytes(body, config=config)
    else:
        code, msg = verify_message_id(
            args.message_id, config=config, channel=args.channel
        )

    if code == EXIT_OK:
        print(msg)
    else:
        _eprint(f"FAIL: {msg}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
