"""Local image-path detection with validation and attachment spool."""

from __future__ import annotations

import re
import shutil
import time
import uuid
from pathlib import Path

from porch3.constants import (
    IMAGE_EXTENSIONS,
    IMAGE_MAX_BYTES,
    IMAGE_MAX_PIXELS,
    IMAGE_SPOOL_DIR,
)

# Absolute or ~/ paths, optionally quoted; word-ish boundaries.
_PATH_RE = re.compile(
    r"(?P<path>(?:~|/)"
    r"(?:[^\s'\"<>|;]+))"
)

_MAGIC: list[tuple[bytes, str]] = [
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
]


class ImageValidationError(ValueError):
    """Raised when a candidate path fails image safety checks."""


def _webp_magic(head: bytes) -> bool:
    return len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP"


def _match_magic(head: bytes, suffix: str) -> bool:
    suffix = suffix.lower()
    if suffix == ".webp":
        return _webp_magic(head)
    if suffix in (".jpg", ".jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    for magic, ext in _MAGIC:
        if ext == suffix and head.startswith(magic):
            return True
    return False


def is_spool_path(path: Path, spool: Path | None = None) -> bool:
    spool = (spool or IMAGE_SPOOL_DIR).resolve()
    try:
        resolved = path.resolve()
    except OSError:
        return False
    try:
        return resolved.is_relative_to(spool)
    except AttributeError:
        # Python < 3.9 fallback (we require 3.9+, but keep safe)
        return str(resolved).startswith(str(spool) + "/")


def validate_image(
    path: Path,
    *,
    max_bytes: int = IMAGE_MAX_BYTES,
    max_pixels: int = IMAGE_MAX_PIXELS,
) -> Path:
    """Validate extension, magic bytes, size, and pixel budget.

    Returns the resolved path on success; raises ImageValidationError otherwise.
    """
    try:
        resolved = path.expanduser().resolve()
    except OSError as exc:
        raise ImageValidationError(f"unreadable path: {path}") from exc
    if not resolved.is_file():
        raise ImageValidationError(f"no file at {resolved}")
    suffix = resolved.suffix.lower()
    if suffix not in IMAGE_EXTENSIONS:
        raise ImageValidationError(f"unsupported image type: {suffix or '(none)'}")
    try:
        size = resolved.stat().st_size
    except OSError as exc:
        raise ImageValidationError(f"stat failed: {resolved}") from exc
    if size <= 0:
        raise ImageValidationError("empty image file")
    if size > max_bytes:
        raise ImageValidationError(
            f"image too large ({size} bytes > {max_bytes})"
        )
    try:
        head = resolved.read_bytes()[:32]
    except OSError as exc:
        raise ImageValidationError(f"read failed: {resolved}") from exc
    if not _match_magic(head, suffix):
        raise ImageValidationError("magic-bytes mismatch for extension")

    # Contained decode: pixel budget via Pillow (optional dependency of
    # textual-image). Fall back to magic+size only if Pillow missing.
    try:
        from PIL import Image

        Image.MAX_IMAGE_PIXELS = max_pixels
        with Image.open(resolved) as im:
            im.verify()
        with Image.open(resolved) as im:
            w, h = im.size
            if w * h > max_pixels:
                raise ImageValidationError(
                    f"image too many pixels ({w * h} > {max_pixels})"
                )
    except ImageValidationError:
        raise
    except ImportError:
        pass
    except Exception as exc:
        raise ImageValidationError(f"image decode failed: {exc}") from exc
    return resolved


# Prepared-thumbnail budget: what the UI thread is allowed to copy. Small
# enough that textual-image's synchronous PixelData copy/convert is trivial.
THUMBNAIL_MAX_SIZE = (640, 480)


def prepare_thumbnail(path: Path):
    """Fully decode + downsample OFF the UI thread; return a bounded PIL image.

    This is the only function allowed to decode original image bytes. The UI
    thread must only ever receive the returned thumbnail (never the original
    path), so textual-image's synchronous PixelData copy is bounded by
    THUMBNAIL_MAX_SIZE regardless of source dimensions.
    """
    validated = validate_image(path)
    try:
        from PIL import Image
    except ImportError as exc:
        raise ImageValidationError("Pillow unavailable for bounded decode") from exc

    with Image.open(validated) as im:
        im = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im.copy()
    im.thumbnail(THUMBNAIL_MAX_SIZE)
    return im


def spool_image(
    src: Path,
    *,
    spool_dir: Path | None = None,
) -> Path:
    """Copy a validated image into the attachment spool; return spool path."""
    validated = validate_image(src)
    spool = spool_dir or IMAGE_SPOOL_DIR
    spool.mkdir(parents=True, exist_ok=True)
    dest = spool / f"{uuid.uuid4().hex}{validated.suffix.lower()}"
    shutil.copy2(validated, dest)
    return dest.resolve()


def prune_spool(*, spool_dir: Path | None = None, max_age_days: int = 7) -> int:
    """Delete spool files older than ``max_age_days``; return count removed.

    Abandoned pastes accumulate forever otherwise (cs-9nv). Best-effort:
    unreadable or already-gone entries are skipped, never raised.
    """
    spool = spool_dir or IMAGE_SPOOL_DIR
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    try:
        entries = list(spool.iterdir())
    except OSError:
        return 0
    for entry in entries:
        try:
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink()
                removed += 1
        except OSError:
            continue
    return removed


def _needs_resample(png: Path) -> bool:
    """True when the grab exceeds either the byte OR the pixel budget."""
    if png.stat().st_size > IMAGE_MAX_BYTES:
        return True
    try:
        from PIL import Image

        with Image.open(png) as im:
            w, h = im.size
        return w * h > IMAGE_MAX_PIXELS
    except Exception:
        # Can't count pixels — keep the byte gate only; validate_image still
        # enforces the pixel budget when Pillow is available.
        return False


def clipboard_image_to_spool() -> tuple[Path | None, str | None]:
    """macOS: write the clipboard image (if any) into the spool.

    Tries the PNG clipboard flavor first, then TIFF (what most apps put on
    the pasteboard) converted via stock `sips`. Oversized grabs (Retina
    screenshots) are resampled down rather than rejected.

    Returns ``(spool_path, None)`` on success, ``(None, None)`` when the
    clipboard holds no image flavor at all, and ``(None, reason)`` when a
    real image was rejected (grab/convert failure, oversize, invalid
    content). Runs subprocesses — call from a worker thread, never the UI
    thread.
    """
    import subprocess
    import tempfile

    def _grab(flavor: str, dest: Path) -> bool:
        script = (
            "on run argv\n"
            "    set f to (open for access POSIX file (item 1 of argv) "
            "with write permission)\n"
            "    try\n"
            f"        write (the clipboard as {flavor}) to f\n"
            "        close access f\n"
            "    on error\n"
            "        close access f\n"
            '        error "no image"\n'
            "    end try\n"
            "end run"
        )
        r = subprocess.run(
            ["osascript", "-e", script, str(dest)], capture_output=True, timeout=10
        )
        return r.returncode == 0 and dest.is_file() and dest.stat().st_size > 0

    with tempfile.TemporaryDirectory(prefix="porch-clip-") as td:
        tmp = Path(td)
        png = tmp / "clip.png"
        if not _grab("«class PNGf»", png):
            tiff = tmp / "clip.tiff"
            if not _grab("«class TIFF»", tiff):
                return None, None
            r = subprocess.run(
                ["sips", "-s", "format", "png", str(tiff), "--out", str(png)],
                capture_output=True,
                timeout=30,
            )
            if r.returncode != 0 or not png.is_file():
                return None, "clipboard image could not be converted"
        if _needs_resample(png):
            # ponytail: one fixed resample step; iterate if 4k monitors outgrow it
            r = subprocess.run(
                ["sips", "--resampleHeightWidthMax", "2000", str(png)],
                capture_output=True,
                timeout=30,
            )
            if r.returncode != 0 or png.stat().st_size > IMAGE_MAX_BYTES:
                return None, "clipboard image too large"
        try:
            return spool_image(png), None
        except ImageValidationError as exc:
            return None, str(exc)


def display_body(text: str, *, own: bool = False) -> str:
    """Replace spool image paths with compact ``[image N]`` display tokens.

    Only substitutes for our OWN sends (``own=True``): a foreign body naming
    a local spool path keeps the raw path visible — hiding it behind
    ``[image N]`` would erase the operator's only signal that an untrusted
    sender referenced a file in the local spool.

    Display-only: callers keep using the original body for candidate
    extraction and rendering. Foreign (non-spool) paths pass through
    untouched so their reveal affordance stays legible.

    Candidates are deduped ONCE up front (each unique path resolves at most
    a single time); the substitution is a plain string lookup, so the same
    path always gets the same token number and per-token filesystem work is
    eliminated.
    """
    text = text or ""
    if not own:
        return text
    tokens: dict[str, int] = {}
    for path in find_candidate_paths(text):
        if is_spool_path(path):
            tokens.setdefault(str(path), len(tokens) + 1)
    if not tokens:
        return text

    def _sub(m: "re.Match[str]") -> str:
        raw = m.group("path").rstrip(".,);:]")
        trail = m.group("path")[len(raw):]
        index = tokens.get(str(Path(raw).expanduser()))
        if index is not None:
            return f"[image {index}]{trail}"
        return m.group("path")

    return _PATH_RE.sub(_sub, text)


def find_candidate_paths(text: str) -> list[Path]:
    """Lexically extract image-suffixed local paths — NO filesystem access.

    This is the compose-time entry point: candidates are split into spool
    (auto-validate + render) vs foreign (deferred, zero file access until an
    explicit reveal) by the caller via is_spool_path, which only resolves the
    path and never opens it.
    """
    found: list[Path] = []
    seen: set[str] = set()
    for match in _PATH_RE.finditer(text or ""):
        raw = match.group("path").rstrip(".,);:]")
        if Path(raw).suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        path = Path(raw).expanduser()
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        found.append(path)
    return found


def find_image_paths(
    text: str,
    *,
    auto_only_spool: bool = True,
    spool_dir: Path | None = None,
) -> list[Path]:
    """Return validated local image paths mentioned in text.

    By default only spool-resolved paths auto-render (foreign raw paths are
    omitted — callers may offer a per-message reveal). Pass
    `auto_only_spool=False` to include any validated path.
    """
    found: list[Path] = []
    seen: set[str] = set()
    for match in _PATH_RE.finditer(text or ""):
        raw = match.group("path").rstrip(".,);:]")
        path = Path(raw).expanduser()
        try:
            validated = validate_image(path)
        except ImageValidationError:
            continue
        if auto_only_spool and not is_spool_path(validated, spool_dir):
            continue
        key = str(validated)
        if key in seen:
            continue
        seen.add(key)
        found.append(validated)
    return found


def find_foreign_image_paths(text: str, *, spool_dir: Path | None = None) -> list[Path]:
    """Validated image paths that are NOT under the spool (need explicit reveal)."""
    found: list[Path] = []
    seen: set[str] = set()
    for match in _PATH_RE.finditer(text or ""):
        raw = match.group("path").rstrip(".,);:]")
        path = Path(raw).expanduser()
        try:
            validated = validate_image(path)
        except ImageValidationError:
            continue
        if is_spool_path(validated, spool_dir):
            continue
        key = str(validated)
        if key in seen:
            continue
        seen.add(key)
        found.append(validated)
    return found
