"""Server state root: 0700 dir, 0600 files, flocked read-modify-write.

Every path porchd writes lives under one root so the socket-cleanup rule in
§3 ("unlink only paths proven beneath the state root") has something to
prove against.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import secrets
import stat
from contextlib import contextmanager
from pathlib import Path

DIR_MODE = 0o700
FILE_MODE = 0o600

STATE_ROOT_ENV = "PORCHD_STATE_ROOT"


def default_root() -> Path:
    override = os.environ.get(STATE_ROOT_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / ".local" / "state" / "porchd"


def ensure_root(root: Path | None = None) -> Path:
    root = Path(root) if root is not None else default_root()
    root.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    _harden_dir(root)
    return root


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    _harden_dir(path)
    return path


def _harden_dir(path: Path) -> None:
    try:
        current = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        return
    if current != DIR_MODE:
        try:
            path.chmod(DIR_MODE)
        except OSError:
            pass


def is_within(path: Path, root: Path) -> bool:
    """True only when ``path`` resolves beneath ``root``.

    Both sides are resolved, so a symlink pointing out of the state root
    fails the test — this is the gate on every unlink porchd performs.
    """
    try:
        resolved = path.resolve()
        base = root.resolve()
    except OSError:
        return False
    if resolved == base:
        return False
    try:
        return resolved.is_relative_to(base)
    except AttributeError:  # pragma: no cover - Python < 3.9
        return str(resolved).startswith(str(base) + os.sep)


def write_private(path: Path, data: str | bytes) -> None:
    """Atomically write a 0600 file (the temp file is 0600 from creation)."""
    payload = data.encode() if isinstance(data, str) else data
    path.parent.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, FILE_MODE)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    try:
        path.chmod(FILE_MODE)
    except OSError:
        pass


def read_json(path: Path, default):
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return default
    return data


def write_json(path: Path, obj) -> None:
    write_private(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


@contextmanager
def locked(path: Path):
    """Hold an exclusive interprocess lock for a read-modify-write cycle.

    The lock file is a sibling `.lock`, never the data file itself, so the
    atomic replace of the data file cannot drop the lock underneath us.
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    lock_path = path.with_name(path.name + ".lock")
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, FILE_MODE)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def server_key(root: Path) -> bytes:
    """Per-install HMAC key for opaque tokens. Created 0600 on first use."""
    path = root / "server-key"
    try:
        raw = path.read_bytes()
        if len(raw) >= 32:
            return raw
    except OSError as exc:
        if exc.errno not in (errno.ENOENT, errno.EACCES):
            raise
    with locked(path):
        try:
            raw = path.read_bytes()
            if len(raw) >= 32:
                return raw
        except OSError:
            pass
        raw = secrets.token_bytes(32)
        write_private(path, raw)
    return raw
