"""Images (§5): uploads, reveal grants, bounded thumbnails.

The trust split from the TUI survives verbatim. Own/verified spool images
get an automatic thumbnail grant; a foreign path is never touched on disk
until an explicit reveal POST, and even then only its bounded thumbnail
ever reaches the browser.
"""

from __future__ import annotations

import io
import os
import tempfile
import time
from pathlib import Path

from porch3.constants import IMAGE_EXTENSIONS, IMAGE_MAX_BYTES, IMAGE_SPOOL_DIR
from porch3.images import (
    ImageValidationError,
    find_candidate_paths,
    is_spool_path,
    prepare_thumbnail,
    spool_image,
)
from porchd import tokens
from porchd.state import default_root, locked, read_json, write_json

UPLOAD_TTL_S = 24 * 3600
GRANT_TTL_S = 300.0

# Upload lifecycle (§5). Consuming at wire assembly was the bug this
# replaces: assembly happens before post, and a crossed or refused send
# keeps the draft — so its attachment chip has to stay live.
AVAILABLE = "available"
RESERVED = "reserved"
RESERVED_FOR_CONFIRM = "reserved_for_confirm"
CONSUMED = "consumed"
UNKNOWN = "unknown"

CONTENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}
THUMBNAIL_CONTENT_TYPE = "image/png"


class ImageError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def uploads_path(root: Path) -> Path:
    return root / "uploads.json"


def reveal_roots() -> list[Path]:
    """Directories a foreign reveal may resolve into.

    The spec requires confinement on the resolved real path but does not
    name the boundary; the home directory is the smallest boundary that
    still covers every real correspondent's spool and working tree.
    """
    override = os.environ.get("PORCHD_REVEAL_ROOTS")
    if override:
        return [Path(p).expanduser() for p in override.split(os.pathsep) if p]
    return [Path.home()]


def reveal_denylist(
    *,
    owner_room_dir: Path,
    mail_root: Path,
    state_root: Path | None = None,
    key_file: Path | None = None,
) -> list[Path]:
    """Directories a reveal may never resolve into, whatever the roots say.

    Secrets first, then the owner room (signing key lives here), porchd's
    own state root, and the mail corpus: an image candidate has no business
    inside either, and the reveal path is reachable from a message body
    written by someone else. The denylist FOLLOWS the configured room.

    ``key_file`` is denied explicitly (with its ``.pub``) because B0 permits
    an absolute key override outside ``owner_room_dir``; without this, a
    hostile body could request that image-shaped private-key path directly.
    """
    home = Path.home()
    denied = [
        home / ".ssh",
        home / ".gnupg",
        owner_room_dir,
        home / "Library" / "Keychains",
        mail_root,
    ]
    if state_root is not None:
        denied.append(state_root)
    else:
        denied.append(default_root())
    if key_file is not None:
        denied.append(key_file)
        denied.append(Path(str(key_file) + ".pub"))
    return denied


def _confined(
    resolved: Path,
    *,
    owner_room_dir: Path,
    mail_root: Path,
    state_root: Path | None = None,
    key_file: Path | None = None,
) -> bool:
    for denied in reveal_denylist(
        owner_room_dir=owner_room_dir,
        mail_root=mail_root,
        state_root=state_root,
        key_file=key_file,
    ):
        try:
            denied = denied.resolve()
            if resolved == denied or resolved.is_relative_to(denied):
                return False
        except (AttributeError, OSError):
            continue
    for allowed in reveal_roots():
        try:
            if resolved.is_relative_to(allowed.resolve()):
                return True
        except (AttributeError, OSError):
            continue
    return False


def candidate_paths(body: str) -> list[Path]:
    """Lexical candidates from a raw body — no filesystem access."""
    return find_candidate_paths(body or "")


def candidates_for(body: str, *, own: bool, spool_dir: Path | None = None) -> list[dict]:
    """Sanitized candidate metadata for message JSON. Never paths."""
    out = []
    for index, path in enumerate(candidate_paths(body)):
        spool = is_spool_path(path, spool_dir)
        out.append(
            {
                "index": index,
                "name": path.name,
                "kind": "own" if (own and spool) else "foreign",
            }
        )
    return out


def thumbnail_png(path: Path) -> bytes:
    """Validate, bounded-decode, and encode a thumbnail. Never the original."""
    image = prepare_thumbnail(path)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def mint_grant(root: Path, *, device: str, message_id: str, index: int, path: Path,
               ttl_s: float = GRANT_TTL_S) -> str:
    return tokens.mint(
        root,
        "image-grant",
        {"d": device, "m": message_id, "i": index, "p": str(path)},
        ttl_s,
    )


def redeem_grant(root: Path, *, device: str, grant: str) -> Path:
    claims = tokens.verify(root, "image-grant", grant)
    if claims is None or claims.get("d") != device:
        raise ImageError("grant_invalid", "that image link has expired")
    return Path(str(claims.get("p")))


def reveal(
    root: Path,
    *,
    device: str,
    message: dict,
    index: int,
    owner_room_dir: Path,
    mail_root: Path,
    spool_dir: Path | None = None,
    key_file: Path | None = None,
) -> str:
    """The authority moment for a foreign image (§5): resolve, confine,
    validate, bounded-decode, then mint a grant bound to all four facts."""
    paths = candidate_paths(message.get("body") or "")
    if not 0 <= index < len(paths):
        raise ImageError("no_such_candidate", "no image candidate at that index")
    candidate = paths[index]
    try:
        resolved = candidate.expanduser().resolve()
    except OSError as exc:
        raise ImageError("unreadable", "that path cannot be read") from exc
    if not _confined(
        resolved,
        owner_room_dir=owner_room_dir,
        mail_root=mail_root,
        state_root=root,
        key_file=key_file,
    ):
        raise ImageError("path_refused", "that path is outside the reveal boundary")
    try:
        # validate_image inside prepare_thumbnail re-checks extension, magic
        # bytes, size and pixel budget on the resolved path before decoding.
        thumbnail_png(resolved)
    except ImageValidationError as exc:
        raise ImageError("invalid_image", str(exc)) from exc
    return mint_grant(root, device=device, message_id=message["id"], index=index,
                      path=resolved)


def _load_uploads(root: Path) -> dict:
    data = read_json(uploads_path(root), {})
    return data if isinstance(data, dict) else {}


def store_upload(root: Path, *, device: str, raw: bytes, content_type: str,
                 spool_dir: Path | None = None) -> str:
    """Validate an uploaded body per images.py and spool it → upload_id."""
    suffix = CONTENT_TYPES.get((content_type or "").split(";")[0].strip().lower())
    if suffix is None:
        raise ImageError("unsupported_type", f"unsupported image type: {content_type or '(none)'}")
    if not raw:
        raise ImageError("empty_upload", "empty image upload")
    if len(raw) > IMAGE_MAX_BYTES:
        raise ImageError("too_large", f"image too large ({len(raw)} bytes)")
    with tempfile.TemporaryDirectory(prefix="porchd-upload-") as td:
        staged = Path(td) / f"upload{suffix}"
        staged.write_bytes(raw)
        try:
            spooled = spool_image(staged, spool_dir=spool_dir or IMAGE_SPOOL_DIR)
        except ImageValidationError as exc:
            raise ImageError("invalid_image", str(exc)) from exc
    upload_id = tokens.mint(root, "upload", {"d": device, "p": str(spooled)}, UPLOAD_TTL_S)
    with locked(uploads_path(root)):
        data = _load_uploads(root)
        data[upload_id] = {
            "device": device,
            "path": str(spooled),
            "created": time.time(),
            "state": AVAILABLE,
        }
        write_json(uploads_path(root), data)
    return upload_id


def _record_for(root: Path, data: dict, device: str, upload_id: str) -> dict:
    claims = tokens.verify(root, "upload", upload_id)
    record = data.get(upload_id)
    if claims is None or claims.get("d") != device or not isinstance(record, dict):
        raise ImageError("upload_expired", "an attachment expired — re-attach it")
    return record


def _confirm_window_closed(record: dict, *, now: float) -> bool:
    """True once no confirm could still spend this reservation.

    A `reserved_for_confirm` hold is released by the client tapping "keep
    editing". If that call never arrives (the tab closed), the hold would
    otherwise strand the chip forever — but past the bounce token's own
    expiry the confirm path is provably closed, so the release is a
    deduction, not a guess.
    """
    deadline = record.get("confirm_deadline")
    return isinstance(deadline, (int, float)) and now >= deadline


def reserve(root: Path, *, device: str, upload_ids: list[str], attempt_id: str,
            now: float | None = None) -> list[str]:
    """Claim uploads for one attempt → their spool paths.

    All-or-nothing: every id is validated before any is written, so a
    refusal never leaves half a draft's attachments reserved.
    """
    now = time.time() if now is None else now
    if not upload_ids:
        return []
    with locked(uploads_path(root)):
        data = _load_uploads(root)
        paths = []
        for upload_id in upload_ids:
            record = _record_for(root, data, device, upload_id)
            state = record.get("state", AVAILABLE)
            owner = record.get("attempt_id")
            if state == CONSUMED:
                raise ImageError("upload_consumed", "an attachment was already sent — re-attach it")
            if state == UNKNOWN:
                raise ImageError(
                    "upload_unknown",
                    "an attachment's last send had an unknown outcome — "
                    "check the channel, then re-attach it",
                )
            if state == RESERVED_FOR_CONFIRM and not _confirm_window_closed(record, now=now):
                if owner != attempt_id:
                    raise ImageError("upload_reserved",
                                     "an attachment is held by a crossed send awaiting confirmation")
            elif state == RESERVED and owner != attempt_id:
                raise ImageError("upload_reserved", "an attachment is held by another send")
            path = str(record.get("path") or "")
            if not Path(path).is_file():
                raise ImageError("upload_missing", "an attachment is no longer in the spool")
            paths.append(path)
        for upload_id in upload_ids:
            record = data[upload_id]
            record["state"] = RESERVED
            record["attempt_id"] = attempt_id
            record.pop("confirm_deadline", None)
        write_json(uploads_path(root), data)
    return paths


def _transition(root: Path, upload_ids: list[str], **fields) -> None:
    if not upload_ids:
        return
    with locked(uploads_path(root)):
        data = _load_uploads(root)
        for upload_id in upload_ids:
            record = data.get(upload_id)
            if isinstance(record, dict):
                record.update(fields)
        write_json(uploads_path(root), data)


def transfer(root: Path, *, upload_ids: list[str], attempt_id: str) -> None:
    """Move a confirm-held reservation onto the confirm's own attempt id."""
    _transition(root, upload_ids, state=RESERVED, attempt_id=attempt_id,
                confirm_deadline=None)


def consume(root: Path, *, upload_ids: list[str], message_id: str | None) -> None:
    """Terminal: post is known committed (sent or committed_output_failure)."""
    _transition(root, upload_ids, state=CONSUMED, message_id=message_id)


def release(root: Path, *, upload_ids: list[str]) -> None:
    """Back to available — an uncommitted outcome, or "keep editing"."""
    _transition(root, upload_ids, state=AVAILABLE, attempt_id=None, confirm_deadline=None)


def hold_for_confirm(root: Path, *, upload_ids: list[str], origin_attempt_id: str,
                     ttl_s: float, now: float | None = None) -> None:
    """A crossed bounce: the chip stays live, bound to the original attempt."""
    now = time.time() if now is None else now
    _transition(root, upload_ids, state=RESERVED_FOR_CONFIRM,
                attempt_id=origin_attempt_id, confirm_deadline=now + ttl_s)


def mark_unknown(root: Path, *, upload_ids: list[str], attempt_id: str) -> None:
    """Ambiguous outcome: not reusable, and never auto-cleaned."""
    _transition(root, upload_ids, state=UNKNOWN, attempt_id=attempt_id)


def held_for(root: Path, attempt_id: str, *, states: tuple[str, ...] = ()) -> list[str]:
    """Upload ids currently bound to an attempt, oldest first."""
    data = _load_uploads(root)
    matches = [
        (record.get("created", 0.0), upload_id)
        for upload_id, record in data.items()
        if isinstance(record, dict)
        and record.get("attempt_id") == attempt_id
        and (not states or record.get("state") in states)
    ]
    return [upload_id for _, upload_id in sorted(matches)]


def state_of(root: Path, upload_id: str) -> str | None:
    record = _load_uploads(root).get(upload_id)
    return record.get("state") if isinstance(record, dict) else None


def prune_uploads(root: Path, *, spool_dir: Path | None = None, now: float | None = None,
                  ttl_s: float = UPLOAD_TTL_S) -> int:
    """Expire available uploads only — never a reserved or unknown file."""
    now = time.time() if now is None else now
    spool = (spool_dir or IMAGE_SPOOL_DIR).resolve()
    dropped = 0
    with locked(uploads_path(root)):
        data = _load_uploads(root)
        for upload_id in list(data):
            record = data.get(upload_id)
            if not isinstance(record, dict):
                del data[upload_id]
                dropped += 1
                continue
            if record.get("state", AVAILABLE) != AVAILABLE:
                continue
            if now - float(record.get("created", now)) < ttl_s:
                continue
            path = Path(str(record.get("path") or ""))
            try:
                if path.resolve().is_relative_to(spool):
                    path.unlink(missing_ok=True)
            except (OSError, AttributeError, ValueError):
                pass
            del data[upload_id]
            dropped += 1
        if dropped:
            write_json(uploads_path(root), data)
    return dropped


def extension_ok(name: str) -> bool:
    return Path(name).suffix.lower() in IMAGE_EXTENSIONS
