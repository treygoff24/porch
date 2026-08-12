"""Off-thread signature verification + persisted cache."""

from __future__ import annotations

import fcntl
import json
import os
import queue
import stat
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

from porch3.constants import VERIFY_CACHE_PATH
from porch3.sanitize import sanitize_display

# Cache keys are structured trust+mid encodings so two configs in one
# process cannot share positive badges / own-image privilege (item 19).
VERIFY_CACHE: dict[str, str] = {}
VERIFY_CACHE_LOCK = threading.Lock()
# Work item: (trust, mid, frozen PorchConfig | None) — the config object is
# captured at enqueue so a later set_trust_context / file rewrite cannot
# redirect an in-flight verify to different trust bytes.
VERIFY_QUEUE: queue.Queue[tuple[str, str, object | None]] = queue.Queue()
_VERIFY_QUEUED: set[tuple[str, str]] = set()
_VERIFY_QUEUED_LOCK = threading.Lock()
_VERIFY_WORKER_STARTED = False
_VERIFY_DONE_CB: Callable[[str, str], None] | None = None
_VERIFY_DONE_CB_LOCK = threading.Lock()
_TRANSIENT_RETRIES = 2
_TRANSIENT_BACKOFF_S = 0.05

# Process-active trust context (set from the loaded PorchConfig).
_TRUST: str = ""
_SIGNING_DISABLED: bool = False
_CONFIG: object | None = None  # frozen PorchConfig


def encode_trust_context(
    *,
    mail_root: str = "",
    owner_room: str = "",
    sigs_dir: str = "",
    allowed_signers: str = "",
    principal: str = "",
    namespace: str = "",
    marker: str = "",
    source_path: str = "",
) -> str:
    """Unambiguous structured trust key over every verification input.

    Canonical JSON (sorted keys) — pipe-joined fields collide on embedded
    separators (``('a|b','c')`` vs ``('a','b|c')``).
    """
    payload = {
        "allowed_signers": allowed_signers,
        "mail_root": mail_root,
        "marker": marker,
        "namespace": namespace,
        "owner_room": owner_room,
        "principal": principal,
        "sigs_dir": sigs_dir,
        "source_path": source_path,
    }
    if not any(payload.values()):
        return ""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def trust_key_for_config(config) -> str:
    sigs = getattr(config, "sigs_dir", None)
    return encode_trust_context(
        mail_root=str(getattr(config, "mail_root", "") or ""),
        owner_room=str(getattr(config, "owner_room", "") or ""),
        sigs_dir=str(sigs) if sigs is not None else "",
        allowed_signers=str(getattr(config, "allowed_signers", "") or ""),
        principal=str(getattr(config, "principal", "") or ""),
        namespace=str(getattr(config, "signing_namespace", "") or ""),
        marker=str(getattr(config, "marker", "") or ""),
        source_path=str(getattr(config, "source_path", "") or ""),
    )


def set_trust_context(config) -> None:
    """Pin verify cache/queue namespace to the loaded frozen PorchConfig."""
    global _TRUST, _SIGNING_DISABLED, _CONFIG
    _TRUST = trust_key_for_config(config)
    _SIGNING_DISABLED = bool(getattr(config, "signing_disabled", False))
    _CONFIG = config


def clear_trust_context() -> None:
    """Test seam: reset process trust namespace to empty."""
    global _TRUST, _SIGNING_DISABLED, _CONFIG
    _TRUST = ""
    _SIGNING_DISABLED = False
    _CONFIG = None


def _ck(mid: str, trust: str | None = None) -> str:
    t = _TRUST if trust is None else trust
    if not t:
        return mid
    return json.dumps(
        {"m": mid, "t": t},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def set_verify_done_callback(cb: Callable[[str, str], None] | None) -> None:
    """Register/clear the completion notifier (Textual app wiring)."""
    global _VERIFY_DONE_CB
    with _VERIFY_DONE_CB_LOCK:
        _VERIFY_DONE_CB = cb


def is_signed_msg(msg: dict, *, wire=None) -> bool:
    from porch3.wire import DEFAULT_WIRE

    fmt = wire if wire is not None else DEFAULT_WIRE
    return fmt.is_signed(msg["body"])


def load_verify_cache(path=None) -> None:
    """Load permanent verify results. Corrupt/missing → empty, never crash.

    No-op when signing/verification is disabled so a stale positive badge
    cannot survive an owner-field mismatch (item 17).
    """
    if _SIGNING_DISABLED:
        return
    path = Path(path) if path is not None else VERIFY_CACHE_PATH
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return
    if not isinstance(data, dict):
        return
    for key, value in data.items():
        if isinstance(key, str) and isinstance(value, str):
            # Structured keys (JSON) and legacy pipe-joined keys are kept;
            # bare mid keys are namespaced under the active trust ctx.
            if key.startswith("{") or "|" in key:
                cache_key = key
            else:
                cache_key = _ck(key)
            VERIFY_CACHE[cache_key] = value
    _tighten_cache_perms(path)


def _tighten_cache_perms(path: Path) -> None:
    """Migrate a legacy 0644 cache to 0600 (live files predate the fix)."""
    try:
        if stat.S_ISREG(os.lstat(path).st_mode):
            os.chmod(path, 0o600)
    except OSError:
        pass


def _read_cache_file(path: Path) -> dict[str, str]:
    """Best-effort read of persisted entries. Corrupt/missing → empty."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: value
        for key, value in data.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def save_verify_cache(path=None, cache=None) -> None:
    """Merge our entries into the persisted cache under an interprocess lock.

    Read-current + merge + atomic replace all happen while the flock is
    held; merging outside the lock is the same lost-update race one line
    later. Transient ' 🔏?' stays in-memory only.
    """
    path = Path(path) if path is not None else VERIFY_CACHE_PATH
    cache = VERIFY_CACHE if cache is None else cache
    with VERIFY_CACHE_LOCK:
        mine = {
            key: value for key, value in cache.items() if value != " 🔏?"
        }
    lock_path = path.with_name(path.name + ".lock")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # The lock path is predictable, so refuse to follow a symlink
        # planted there and refuse anything that is not a regular file.
        lock_fd = os.open(
            lock_path,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        try:
            if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
                return
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            merged = _read_cache_file(path)
            merged.update(mine)
            merged = {
                key: value for key, value in merged.items() if value != " 🔏?"
            }
            _atomic_write(path, json.dumps(merged))
        finally:
            os.close(lock_fd)
    except OSError:
        pass


def _atomic_write(path: Path, text: str) -> None:
    """Write via a fresh 0600 temp in the destination dir, then rename."""
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f"{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.chmod(tmp_name, 0o600)
        os.replace(tmp_name, path)
    except OSError:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def verified_owner(msg: dict, *, wire=None) -> bool:
    """True only for a signed message the cache has positively verified.

    Cache-lookup only (never spawns porch-verify). An unverified, pending,
    or unsigned message returns False — so this is a positive proof-of-owner
    signal safe to grant privileges on, unlike the spoofable ``from`` field.
    """
    if _SIGNING_DISABLED:
        return False
    if not is_signed_msg(msg, wire=wire):
        return False
    return VERIFY_CACHE.get(_ck(msg["id"])) == " 🔏✓"


def verify_badge(msg: dict, *, wire=None) -> str:
    """Cache-lookup only — never spawns porch-verify on the render path."""
    if _SIGNING_DISABLED:
        return ""
    if not is_signed_msg(msg, wire=wire):
        return ""
    return sanitize_display(VERIFY_CACHE.get(_ck(msg["id"]), " 🔏…"))


def enqueue_verifications(msgs: list[dict], *, wire=None) -> None:
    if _SIGNING_DISABLED:
        return
    trust = _TRUST
    config = _CONFIG
    for msg in msgs:
        if not is_signed_msg(msg, wire=wire):
            continue
        mid = msg["id"]
        if _ck(mid, trust) in VERIFY_CACHE:
            continue
        with _VERIFY_QUEUED_LOCK:
            key = (trust, mid) if trust else mid
            if key in _VERIFY_QUEUED:
                continue
            _VERIFY_QUEUED.add(key)
        ensure_verify_worker()
        VERIFY_QUEUE.put((trust, mid, config))


def _notify_done(mid: str, badge: str) -> None:
    with _VERIFY_DONE_CB_LOCK:
        cb = _VERIFY_DONE_CB
    if cb is None:
        return
    try:
        cb(mid, badge)
    except Exception:
        pass


def _unpack_work_item(item) -> tuple[str, str, object | None]:
    """Normalize queue items; prefer the captured frozen config over globals."""
    if isinstance(item, tuple):
        if len(item) >= 3:
            trust, mid, config = item[0], item[1], item[2]
            # Legacy (trust, mid, Path) items — refuse ambient re-read.
            if isinstance(config, Path):
                return trust, mid, None
            return trust, mid, config
        if len(item) == 2:
            return item[0], item[1], None
    return _TRUST, item, None


def _terminal_badge(code: int) -> str | None:
    """Map porch-verify taxonomy to a retained badge, or None if unknown.

    rc0 → terminal positive; rc1 → terminal negative; config/lookup/env
    (and any other non-1 failure) stay UNKNOWN so the mid remains eligible.
    """
    from porch3.verifycli import EXIT_FAIL, EXIT_OK

    if code == EXIT_OK:
        return " 🔏✓"
    if code == EXIT_FAIL:
        return " 🔏✗UNVERIFIED"
    return None


def _verify_once(mid: str, config) -> str | None:
    """In-process verify against the frozen config; never re-reads its path."""
    from porch3.verifycli import verify_message_id

    if config is None:
        return None
    code, _msg = verify_message_id(mid, config=config)
    return _terminal_badge(code)


def _verify_worker() -> None:
    while True:
        item = VERIFY_QUEUE.get()
        trust, mid, config = _unpack_work_item(item)
        cache_key = _ck(mid, trust)
        queued_key = (trust, mid) if trust else mid
        try:
            if cache_key in VERIFY_CACHE:
                continue
            badge: str | None = None
            for attempt in range(_TRANSIENT_RETRIES + 1):
                try:
                    badge = _verify_once(mid, config)
                except Exception:
                    badge = None
                if badge is not None:
                    break
                if attempt < _TRANSIENT_RETRIES:
                    time.sleep(_TRANSIENT_BACKOFF_S * (attempt + 1))
                    continue
            if badge is None:
                # UNKNOWN — leave mid eligible for a later enqueue.
                continue
            VERIFY_CACHE[cache_key] = badge
            save_verify_cache(cache={cache_key: badge})
            _notify_done(mid, badge)
        finally:
            with _VERIFY_QUEUED_LOCK:
                _VERIFY_QUEUED.discard(queued_key)


def ensure_verify_worker() -> None:
    global _VERIFY_WORKER_STARTED
    if _VERIFY_WORKER_STARTED:
        return
    with _VERIFY_QUEUED_LOCK:
        if _VERIFY_WORKER_STARTED:
            return
        _VERIFY_WORKER_STARTED = True
    threading.Thread(
        target=_verify_worker, name="porch-verify", daemon=True
    ).start()


def apply_verify_result(mid: str, badge: str) -> None:
    """Test/helper seam: write cache and fire the done callback."""
    VERIFY_CACHE[_ck(mid)] = badge
    _notify_done(mid, badge)
