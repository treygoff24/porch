"""Live "own" determination for images (§5).

`own` is: the message id is in porchd's committed-attempt ledger, OR the
message passes positive **live** verification. Deliberately not the
persisted verify cache — that file is user-writable, so promoting it to an
authority source would let any local agent mint the privilege (the same
lesson drstore learned about DR authority). And never forgeable ``from``.
"""

from __future__ import annotations

import queue
import threading
from pathlib import Path

from porch3.verify import is_signed_msg
from porch3.verifycli import (
    EXIT_ENV,
    EXIT_FAIL,
    EXIT_LOOKUP,
    EXIT_OK,
    EXIT_USAGE,
    verify_message_id,
)
from porch3.wire import DEFAULT_WIRE, WireFormat


class LiveVerifier:
    """Background positive-verification of signed messages, process-local.

    Unknown answers are False for privilege (``is_verified``): a message
    pending or backed-off verification renders as a foreign chip, which the
    operator can still reveal explicitly. Terminal False is retained;
    environment/lookup outcomes stay out of ``_verdicts`` so they remain
    eligible for re-enqueue.
    """

    def __init__(
        self,
        *,
        channels_root: Path,
        timeout: float = 10.0,
        wire: WireFormat | None = None,
        config_path: Path | None = None,
        mail_root: Path | None = None,
        porch_config=None,
    ):
        self.channels_root = channels_root
        # Prefer explicit mail_root; channels_root is historically mail_root/channels.
        self.mail_root = (
            mail_root if mail_root is not None else channels_root.parent
        )
        self.timeout = timeout
        self.wire = wire if wire is not None else DEFAULT_WIRE
        self.porch_config = porch_config
        # Retained for callers that still refresh a path pin after crosscheck.
        self.config_path = (
            config_path
            if config_path is not None
            else getattr(porch_config, "source_path", None)
        )
        self._verdicts: dict[str, bool] = {}
        self._queued: set[str] = set()
        self._lock = threading.Lock()
        self._queue: queue.Queue[tuple[str, str]] = queue.Queue()
        self._worker: threading.Thread | None = None

    def is_verified(self, message_id: str) -> bool:
        with self._lock:
            return self._verdicts.get(message_id, False)

    def consider(self, channel: str, msgs: list[dict]) -> None:
        for msg in msgs:
            owner_room = getattr(self.porch_config, "owner_room", None)
            if not is_signed_msg(
                msg, wire=self.wire, owner_room=owner_room
            ):
                continue
            mid = msg["id"]
            with self._lock:
                if mid in self._verdicts or mid in self._queued:
                    continue
                self._queued.add(mid)
            self._ensure_worker()
            self._queue.put((channel, mid))

    def verify_now(self, channel: str, message_id: str) -> bool:
        """Synchronous single check — the test seam and the fallback path.

        Terminal True/False are retained; UNKNOWN (env/lookup) is not, so a
        later consider/verify_now can retry.
        """
        verdict = self._run(channel, message_id)
        with self._lock:
            if verdict is not None:
                self._verdicts[message_id] = verdict
            self._queued.discard(message_id)
        return bool(verdict)

    def _run(self, channel: str, message_id: str) -> bool | None:
        """Return True/False for terminal outcomes, None for UNKNOWN."""
        config = self.porch_config
        if config is None:
            return None
        try:
            code, _msg = verify_message_id(
                message_id, config=config, channel=channel
            )
        except Exception:
            return None
        if code == EXIT_OK:
            return True
        if code == EXIT_FAIL:
            return False
        if code in (EXIT_ENV, EXIT_LOOKUP, EXIT_USAGE):
            return None
        return None

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._worker is not None:
                return
            self._worker = threading.Thread(
                target=self._loop, name="porchd-own-verify", daemon=True
            )
        self._worker.start()

    def _loop(self) -> None:
        while True:
            channel, mid = self._queue.get()
            verdict = self._run(channel, mid)
            with self._lock:
                if verdict is not None:
                    self._verdicts[mid] = verdict
                self._queued.discard(mid)
