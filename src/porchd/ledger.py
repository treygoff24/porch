"""Attempt ledger (§7): one append-only JSONL line per state transition.

The ledger is what makes a mobile send idempotent across a dropped
response. It is deliberately not a cache of results — it is the record of
what the server *did*, so an ambiguous outcome stays ambiguous forever
rather than being guessed at on a retry.
"""

from __future__ import annotations

import fcntl
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from porchd import canonical
from porchd.state import DIR_MODE, FILE_MODE, locked

PENDING = "pending"
SENT = "sent"
CROSSED = "crossed"
REFUSED = "refused"
COMMITTED_OUTPUT_FAILURE = "committed_output_failure"
UNKNOWN = "unknown"

TERMINAL_STATES = frozenset({SENT, CROSSED, REFUSED, COMMITTED_OUTPUT_FAILURE, UNKNOWN})
# `pending` (a crash mid-send) and `unknown` (its acknowledgement) are the
# ambiguous ones: never auto-cleaned, because delivery may have landed.
AMBIGUOUS_STATES = frozenset({PENDING, UNKNOWN})
RETENTION_S = 30 * 86400


def ledger_path(root: Path) -> Path:
    return root / "attempts.jsonl"


def request_hash(*, channel: str, draft_text: str, attachments: list[str], intent: str) -> str:
    """The idempotency identity of a request — canonical, never concatenated."""
    return canonical.digest(
        {
            "channel": channel,
            "draft_text": draft_text,
            "attachments": list(attachments),
            "intent": intent,
        }
    )


@dataclass
class Outcome:
    """What ``begin`` decided about an incoming attempt."""

    kind: str  # proceed | conflict | replay | unknown
    prior: dict | None = None


@dataclass
class Attempt:
    attempt_id: str
    device: str
    channel: str
    draft_hash: str
    wire_hash: str
    intent: str
    request_hash: str
    kind: str = "send"  # send | confirm
    extra: dict = field(default_factory=dict)


def _append_line(root: Path, record: dict) -> dict:
    record = dict(record)
    record.setdefault("ts", time.time())
    path = ledger_path(root)
    path.parent.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
    line = json.dumps(record, ensure_ascii=False) + "\n"
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, FILE_MODE)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            os.write(fd, line.encode())
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
    return record


def read_all(root: Path) -> list[dict]:
    try:
        text = ledger_path(root).read_text()
    except OSError:
        return []
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and isinstance(rec.get("attempt_id"), str):
            out.append(rec)
    return out


def latest(root: Path, attempt_id: str) -> dict | None:
    found = None
    for rec in read_all(root):
        if rec.get("attempt_id") == attempt_id:
            found = rec
    return found


def latest_by_id(root: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for rec in read_all(root):
        out[rec["attempt_id"]] = rec
    return out


def begin(root: Path, attempt: Attempt) -> Outcome:
    """Claim an attempt id, writing `pending` before post is ever invoked.

    Idempotency is attempt_id **plus** the exact request hash: the same id
    carrying a different payload is a conflict, never a replayed result.
    """
    with locked(ledger_path(root)):
        prior = latest(root, attempt.attempt_id)
        if prior is not None:
            if prior.get("request_hash") != attempt.request_hash:
                return Outcome("conflict", prior)
            state = prior.get("state")
            if state == PENDING:
                # A crash left this in flight. Record the ambiguity once and
                # never auto-resend: the message may well have landed.
                unknown = _append_line(
                    root,
                    {
                        **{k: prior.get(k) for k in ("attempt_id", "device", "channel",
                                                     "draft_hash", "wire_hash", "intent",
                                                     "request_hash", "kind")},
                        "state": UNKNOWN,
                        "detail": "outcome unknown — a prior attempt did not complete",
                    },
                )
                return Outcome("unknown", unknown)
            if state == UNKNOWN:
                return Outcome("unknown", prior)
            return Outcome("replay", prior)
        _append_line(
            root,
            {
                "attempt_id": attempt.attempt_id,
                "device": attempt.device,
                "channel": attempt.channel,
                "draft_hash": attempt.draft_hash,
                "wire_hash": attempt.wire_hash,
                "intent": attempt.intent,
                "request_hash": attempt.request_hash,
                "kind": attempt.kind,
                "state": PENDING,
                **attempt.extra,
            },
        )
    return Outcome("proceed", None)


def commit(root: Path, attempt: Attempt, state: str, **fields) -> dict:
    if state not in TERMINAL_STATES:
        raise ValueError(f"not a terminal state: {state!r}")
    return _append_line(
        root,
        {
            "attempt_id": attempt.attempt_id,
            "device": attempt.device,
            "channel": attempt.channel,
            "draft_hash": attempt.draft_hash,
            "wire_hash": attempt.wire_hash,
            "intent": attempt.intent,
            "request_hash": attempt.request_hash,
            "kind": attempt.kind,
            "state": state,
            **fields,
        },
    )


def committed_message_ids(root: Path) -> set[str]:
    """Message ids this server provably emitted — the `own` half of §5."""
    return {
        rec["message_id"]
        for rec in read_all(root)
        if isinstance(rec.get("message_id"), str) and rec.get("state") in
        (SENT, COMMITTED_OUTPUT_FAILURE)
    }


def bounce_consumed_by(root: Path, original_attempt_id: str) -> str | None:
    """The confirm attempt that already spent this bounce, if any."""
    for rec in read_all(root):
        if rec.get("kind") == "confirm" and rec.get("origin_attempt_id") == original_attempt_id:
            return rec.get("attempt_id")
    return None


def prune(root: Path, *, now: float | None = None, retention_s: float = RETENTION_S) -> int:
    """Age out terminal records. Ambiguous attempts are never cleaned."""
    now = time.time() if now is None else now
    cutoff = now - retention_s
    with locked(ledger_path(root)):
        records = read_all(root)
        if not records:
            return 0
        states = latest_by_id(root)
        kept, dropped = [], 0
        for rec in records:
            state = states.get(rec["attempt_id"], {}).get("state")
            if state in AMBIGUOUS_STATES or float(rec.get("ts", now)) >= cutoff:
                kept.append(rec)
            else:
                dropped += 1
        if dropped:
            text = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept)
            from porchd.state import write_private

            write_private(ledger_path(root), text)
    return dropped
