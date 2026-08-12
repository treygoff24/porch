"""The interprocess operation lock (§3): arm, lock, and send are one queue.

The service's own send lock only serializes threads inside the daemon, but
`porch-mobile arm` and `porch-mobile lock` run in a *separate* process at
the terminal. Without a lock the filesystem can see, a lock typed at the
Mac can land between a send's arm-check and its ssh-keygen — the signed
send then either fails oddly or signs under a lease the operator believed
they had just revoked.

Lock order, outermost first, and nothing may take these in another order:

    Service._send_lock  (in-process, threads)
      → operation_lock  (interprocess, this file)
        → ledger / uploads flocks  (per-file, short)

Re-entrant within a thread, because flock is associated with the open file
description: a second open() of the same file from the same process would
block against itself forever. `Service.signing_lock` holds this lock and
then calls `lease.lock`, which takes it again.
"""

from __future__ import annotations

import errno
import fcntl
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from porchd.state import DIR_MODE, FILE_MODE

# Long enough to outlast a send (a post subprocess), short enough that a
# passphrase prompt left open at the terminal cannot freeze the phone.
DEFAULT_TIMEOUT_S = 30.0
_POLL_S = 0.02

_local = threading.local()


class OperationBusy(RuntimeError):
    """The operation queue was held past the caller's patience."""


def lock_path(root: Path) -> Path:
    return root / "operation.lock"


@contextmanager
def operation_lock(root: Path, *, timeout: float | None = None):
    """Hold the operation queue. `timeout=None` waits indefinitely.

    Callers that can report back to a human (the CLI) wait; callers serving
    a request pass a timeout so a stalled terminal prompt degrades into one
    honest refusal instead of a hung phone.
    """
    depth = getattr(_local, "depth", 0)
    if depth:
        _local.depth = depth + 1
        try:
            yield
        finally:
            _local.depth -= 1
        return

    path = lock_path(root)
    path.parent.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, FILE_MODE)
    deadline = None if timeout is None else time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if exc.errno not in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                    raise
                if deadline is not None and time.monotonic() >= deadline:
                    raise OperationBusy(
                        "another signing operation is in progress at the Mac"
                    ) from exc
                time.sleep(_POLL_S)
        _local.depth = 1
        try:
            yield
        finally:
            _local.depth = 0
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
