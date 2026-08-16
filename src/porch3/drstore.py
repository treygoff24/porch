"""Decision Records: append-only JSONL event log + projection.

Spec: docs/decision-records.md. Shared by the porch TUI and the bin/dr CLI
(agents propose without running the TUI), so this module must not import
Textual.

Authority model: anyone may append `proposed` events; `ratified`/`rejected`/
`superseded` events COUNT only when their actor_message_id names an owner
message whose SIGNED BODY authorizes that exact (dr, verb) — checked live at
projection time via porch-verify (`authorize_action`). Signature alone is not
authority: the log is untrusted shared state, so a real signed action for one
record must not authorize a forged event on another. A forged line changes
nothing.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from porch3.platform import require_macos
from porch3.wire import DEFAULT_WIRE, WireFormat

# No hardcoded owner defaults (B1): callers pass path=/mail_root= explicitly
# (Service uses self.porch_config.dr_log_path / .mail_root, never these).
# Kept as module attrs, default None, ONLY so existing tests may still
# monkeypatch them for direct drstore.* calls — never read by Service/app.
DR_LOG_PATH: Path | None = None
MAIL_ROOT: Path | None = None

EVENT_TYPES = {"proposed", "ratified", "rejected", "superseded"}
# Bound on verifier calls per projection: a hostile log stuffed with decide
# events must not force unbounded live verification work.
_MAX_VERIFY_CALLS = 8


def trust_context_key(
    *,
    mail_root: Path | None,
    wire: WireFormat,
    config_path: Path | None = None,
    principal: str = "",
    namespace: str = "",
    allowed_signers: Path | None = None,
    owner_room: str = "",
    sigs_dir: Path | None = None,
) -> str:
    """Namespace authority memos by the full structured trust context."""
    from porch3.verify import encode_trust_context

    return encode_trust_context(
        mail_root=str(mail_root) if mail_root is not None else "",
        owner_room=owner_room,
        sigs_dir=str(sigs_dir) if sigs_dir is not None else "",
        allowed_signers=str(allowed_signers) if allowed_signers is not None else "",
        principal=principal,
        namespace=namespace,
        marker=wire.marker,
        source_path=str(config_path) if config_path is not None else "",
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _event_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{os.urandom(3).hex()}"


_DR_ID_RE = re.compile(r"^dr-\d{1,9}$")
# Event-log actor ids: charset gate against glob/path smuggling. Exact Post
# channel-message grammar is enforced later in authentic_action before any
# corpus walk / porch-verify spawn.
_MSG_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_CANON_MSG_ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9]{6}-[0-9a-fA-F]{6}$")

_MAX_LINE_BYTES = 65536


def _valid_event(ev) -> bool:
    """Structural validation for UNTRUSTED log lines: a hostile line must be
    droppable, never able to crash projection or poison id allocation."""
    if not isinstance(ev, dict) or ev.get("type") not in EVENT_TYPES:
        return False
    dr = ev.get("dr")
    if not isinstance(dr, str) or not _DR_ID_RE.match(dr):
        return False
    sup = ev.get("supersedes")
    if ev["type"] == "superseded" and (
        not isinstance(sup, str) or not _DR_ID_RE.match(sup)
    ):
        return False
    for key in ("title", "project", "channel", "anchor_message_id",
                "actor_message_id"):
        value = ev.get(key)
        if value is not None and not isinstance(value, str):
            return False
    actor = ev.get("actor_message_id")
    return actor is None or _MSG_ID_RE.match(actor) is not None


def _parse_events(text: str) -> list[dict]:
    events: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or len(line) > _MAX_LINE_BYTES:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if _valid_event(ev):
            events.append(ev)
    return events


def replay(path: Path | None = None) -> list[dict]:
    """Parse the log; corrupt or hostile lines are skipped, never fatal."""
    path = path if path is not None else DR_LOG_PATH
    if path is None:
        return []
    try:
        text = path.read_text()
    except OSError:
        return []
    return _parse_events(text)


def append_event(ev: dict, path: Path | None = None) -> dict:
    """Validate, stamp, and atomically append one event line."""
    path = path if path is not None else DR_LOG_PATH
    if path is None:
        raise ValueError("no DR log path configured — pass path= explicitly")
    etype = ev.get("type")
    if etype not in EVENT_TYPES:
        raise ValueError(f"unknown event type: {etype!r}")
    required = {
        "proposed": ("dr", "title", "project", "channel", "anchor_message_id"),
        "ratified": ("dr", "actor_message_id"),
        "rejected": ("dr", "actor_message_id"),
        # superseded carries actor_message_id: state transitions are the owner's
        # alone, supersede included (review blocker: unsigned supersede let
        # one forged line permanently block a pending DR).
        "superseded": ("dr", "supersedes", "actor_message_id"),
    }[etype]
    for key in required:
        if not ev.get(key):
            raise ValueError(f"{etype} event missing {key}")
    ev = dict(ev)
    ev.setdefault("event_id", _event_id())
    ev.setdefault("created", _utc_now())
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(ev, ensure_ascii=False) + "\n"
    # flock + O_APPEND: multiple writers (porch, agent CLIs) share this file.
    with open(path, "a", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.write(line)
            fh.flush()
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
    return ev


def next_dr_id(events: list[dict]) -> str:
    """Smallest unused positive id — NOT highest+1.

    highest+1 let one structurally valid but enormous id (dr-999999999)
    push allocation to a 10-digit id that _DR_ID_RE then rejects, so every
    proposal wrote an id replay dropped as invalid — an invisible record,
    forever (review MAJOR). Smallest-unused keeps a lone high id from
    jumping the namespace: it just sits there, and allocation continues at
    the next real gap.
    """
    used = set()
    for ev in events:
        dr = ev.get("dr") or ""
        if dr.startswith("dr-"):
            try:
                used.add(int(dr[3:]))
            except ValueError:
                continue
    n = 1
    while n in used:
        n += 1
    return f"dr-{n}"


# The persisted display cache (~/.cache/porch/verify-cache.json) is
# deliberately NOT consulted for authority: it is user-writable store data,
# and promoting it to an authority source let any local agent mint
# verifications (review blocker). Authority runs porch-verify live.

# Maps a signed action verb to the event type it authorizes.
_VERB_FOR_TYPE = {"ratified": "accepted", "rejected": "rejected",
                  "superseded": "superseded"}
# Memo of the authentic parsed action for a message id (None = no authentic
# action body). Keyed by (trust_context, id): the signed body for an id is
# immutable within one trust context, never across configs.
_ACTION_MEMO: dict[tuple[str, str], tuple[str, str, str | None] | None] = {}
# Actor ids the projection budget has already been charged for, per trust ctx.
_BUDGET_CHARGED: set[tuple[str, str]] = set()

# Per-(ctx,id) timeout backoff (cs-96j).
_TIMEOUT_BACKOFF: dict[tuple[str, str], tuple[int, float]] = {}
# The base MUST exceed the worst-case wall time of one capped pass
# (_MAX_VERIFY_CALLS x 10s = 80s): windows open as each timeout lands, so a
# shorter base lets an id charged early in a pass lapse before the pass
# ends, and the very next projection re-pays the whole prefix (Soul's HEAD
# re-execution of 8304919: 240s of repeat compute before stabilizing).
_BACKOFF_BASE_S = 120.0
_BACKOFF_CAP_S = 3600.0
_now = time.monotonic  # indirection so tests can drive the clock

# Duplicate exact-basename matches are an ATTACK SIGNATURE, not a search
# problem. Message ids are globally unique in the real corpus (Soul r4:
# zero duplicate basenames across all of ~/.claude-mail), so N copies of
# {mid}.msg in N directories only exist when someone planted them — and the
# r3/r4 floods showed that authenticating THROUGH duplicate trees costs
# unbounded live verification however cleverly the walk is batched (a
# per-call cursor still re-batched once per repeated event within one
# projection). So: more than one exact match fails closed at zero verifier
# cost, unmemoized — remove the planted copy and the genuine file resolves
# on the next projection. Fail-closed adds no attacker power: a corpus
# writer could censor the genuine file more simply by deleting it. With
# uniqueness enforced, one mid is at most ONE candidate. Only cryptographic
# EXIT_FAIL is a terminal negative memo; corpus absence (MessageNotFound)
# and env/lookup outcomes stay unmemoized under the bounded backoff so a
# later appearance can still ratify.


def _memo_for(mid: str):
    """Return the memoized verdict for ``mid`` under any trust context (tests)."""
    for (ctx, m), value in _ACTION_MEMO.items():
        if m == mid:
            return value
    raise KeyError(mid)


def _backoff_for(mid: str):
    for (ctx, m), value in _TIMEOUT_BACKOFF.items():
        if m == mid:
            return value
    raise KeyError(mid)


def _charged(mid: str) -> bool:
    return any(m == mid for _, m in _BUDGET_CHARGED)


def _open_backoff(key: tuple[str, str], prior: tuple[int, float] | None) -> None:
    """Open (or grow) a (ctx,mid) retry-not-before window."""
    strikes = (prior[0] if prior else 0) + 1
    delay = min(_BACKOFF_BASE_S * 2.0 ** min(strikes - 1, 30), _BACKOFF_CAP_S)
    _TIMEOUT_BACKOFF[key] = (strikes, _now() + delay)


def _config_snapshot_for_verify(
    *,
    config,
    wire: WireFormat,
    mail_root: Path | None,
    principal: str,
    namespace: str,
    allowed_signers: Path | None,
    owner_room: str,
    sigs_dir: Path | None,
    config_path: Path | None,
):
    """Frozen identity for in-process verify — never re-reads ``config_path``."""
    if config is not None:
        return config
    from porch3.config import PorchConfig

    root = Path(mail_root) if mail_root is not None else Path("/")
    room = owner_room or "_"
    room_dir = root / ".porch-room"
    sidecar = room_dir
    signers = allowed_signers if allowed_signers is not None else (
        sidecar / "allowed_signers"
    )
    sigs = sigs_dir if sigs_dir is not None else (sidecar / "sigs")
    # Derive sidecar from sigs when only sigs_dir was supplied.
    if sigs_dir is not None:
        sidecar = Path(sigs_dir).parent
    return PorchConfig(
        owner_room=room,
        owner_room_dir=room_dir,
        mail_root=root,
        sidecar_dir=sidecar,
        allowed_signers=Path(signers),
        key_file=room_dir / f"{room}_porch_key",
        signing_namespace=namespace or "porch",
        principal=principal or "owner@porch",
        marker=wire.marker,
        label=room,
        source_path=config_path,
    )


def authentic_action(
    mid: str,
    mail_root: Path | None = None,
    *,
    wire: WireFormat = DEFAULT_WIRE,
    config=None,
    config_path: Path | None = None,
    principal: str = "",
    namespace: str = "",
    allowed_signers: Path | None = None,
    owner_room: str = "",
    sigs_dir: Path | None = None,
) -> tuple[str, str, str | None] | None:
    """Return the parsed action of the message `mid` ONLY if its body carries
    a genuine owner signature over that exact body — else None.

    Authority bytes come from the shared held-dirfd unique channel lookup
    (same containment/duplicate guarantees as porch-verify). Verification
    runs in-process against the frozen PorchConfig snapshot — never by
    re-reading a config pathname that may have changed since load.
    """
    from porch3.verifycli import (
        EXIT_ENV,
        EXIT_FAIL,
        EXIT_LOOKUP,
        EXIT_OK,
        EXIT_USAGE,
        DuplicateMessage,
        LookupIOError,
        MessageNotFound,
        SafeReadError,
        held_read_unique_message_record,
        verify_held_message,
    )

    snap = _config_snapshot_for_verify(
        config=config,
        wire=wire,
        mail_root=mail_root,
        principal=principal,
        namespace=namespace,
        allowed_signers=allowed_signers,
        owner_room=owner_room,
        sigs_dir=sigs_dir,
        config_path=config_path,
    )
    # Prefer the snapshot's own trust fields for memo namespacing.
    ctx = trust_context_key(
        mail_root=getattr(snap, "mail_root", None)
        if mail_root is None
        else mail_root,
        wire=wire,
        config_path=getattr(snap, "source_path", None)
        if config_path is None
        else config_path,
        principal=getattr(snap, "principal", "") or principal,
        namespace=getattr(snap, "signing_namespace", "") or namespace,
        allowed_signers=getattr(snap, "allowed_signers", None)
        if allowed_signers is None
        else allowed_signers,
        owner_room=getattr(snap, "owner_room", "") or owner_room,
        sigs_dir=getattr(snap, "sigs_dir", None)
        if sigs_dir is None
        else sigs_dir,
    )
    memo_key = (ctx, mid)
    if memo_key in _ACTION_MEMO:
        return _ACTION_MEMO[memo_key]
    if not _CANON_MSG_ID_RE.match(mid):
        _ACTION_MEMO[memo_key] = None
        return None
    backoff = _TIMEOUT_BACKOFF.get(memo_key)
    if backoff is not None and _now() < backoff[1]:
        return None
    root = mail_root if mail_root is not None else MAIL_ROOT
    if root is None:
        return None
    result: tuple[str, str, str | None] | None = None
    unknown = False
    held = None
    try:
        held = held_read_unique_message_record(root, mid)
    except DuplicateMessage:
        _open_backoff(memo_key, backoff)
        return None
    except MessageNotFound:
        # Corpus absence is EXIT_LOOKUP/UNKNOWN — never a terminal negative.
        # Do not memoize; open bounded backoff so a later appearance can ratify.
        unknown = True
        held = None
    except (LookupIOError, SafeReadError, OSError):
        unknown = True
        held = None
    if held is not None:
        try:
            code, _detail = verify_held_message(held, config=snap, wire=wire)
        except Exception:
            unknown = True
            code = EXIT_ENV
        if code == EXIT_OK:
            try:
                body_text = held.body.decode("utf-8")
            except UnicodeDecodeError:
                body_text = None
            if body_text is not None:
                envelope = held.envelope
                is_v2 = (
                    held.signature_ref_present
                    and envelope is not None
                    and envelope.get("from") == snap.owner_room
                )
                if is_v2:
                    result = parse_v2_action_body(body_text)
                else:
                    if body_text.endswith("\n"):
                        body_text = body_text[:-1]
                    if "\r" not in body_text and "\n" not in body_text:
                        result = parse_action_body(body_text, wire=wire)
        elif code == EXIT_FAIL:
            result = None
        elif code in (EXIT_ENV, EXIT_LOOKUP, EXIT_USAGE):
            unknown = True
        else:
            unknown = True
    if result is None and unknown:
        _open_backoff(memo_key, backoff)
        return None
    _TIMEOUT_BACKOFF.pop(memo_key, None)
    _ACTION_MEMO[memo_key] = result
    return result


def authorize_action(
    ev: dict,
    mail_root: Path | None = None,
    *,
    wire: WireFormat = DEFAULT_WIRE,
    config=None,
    config_path: Path | None = None,
    principal: str = "",
    namespace: str = "",
    allowed_signers: Path | None = None,
    owner_room: str = "",
    sigs_dir: Path | None = None,
) -> bool:
    """True iff event `ev` is authorized by a signed owner action bound to
    its EXACT (dr, verb) — signature alone is never enough (untrusted log)."""
    mid = ev.get("actor_message_id")
    etype = ev.get("type")
    if not mid or etype not in _VERB_FOR_TYPE:
        return False
    parsed = authentic_action(
        mid,
        mail_root,
        wire=wire,
        config=config,
        config_path=config_path,
        principal=principal,
        namespace=namespace,
        allowed_signers=allowed_signers,
        owner_room=owner_room,
        sigs_dir=sigs_dir,
    )
    if parsed is None:
        return False
    pdr, pverb, pnew = parsed
    if pverb != _VERB_FOR_TYPE[etype]:
        return False
    if etype == "superseded":
        return pdr == ev.get("supersedes") and pnew == ev.get("dr")
    return pdr == ev.get("dr")


def project(
    events: list[dict],
    verifier=None,
    *,
    mail_root: Path | None = None,
    wire: WireFormat = DEFAULT_WIRE,
    config=None,
    config_path: Path | None = None,
    principal: str = "",
    namespace: str = "",
    allowed_signers: Path | None = None,
    owner_room: str = "",
    sigs_dir: Path | None = None,
) -> dict[str, dict]:
    """Fold events into current records, keyed by dr id.

    Ratify/reject events from the (untrusted, shared) log are counted only
    when the verifier vouches for their actor message. Verifier results are
    memoized per call so replays cost at most one check per actor message.
    """
    ctx = trust_context_key(
        mail_root=mail_root if mail_root is not None else MAIL_ROOT,
        wire=wire,
        config_path=config_path,
        principal=principal,
        namespace=namespace,
        allowed_signers=allowed_signers,
        owner_room=owner_room,
        sigs_dir=sigs_dir,
    )
    if verifier is None:
        def verifier(ev: dict) -> bool:
            return authorize_action(
                ev,
                mail_root,
                wire=wire,
                config=config,
                config_path=config_path,
                principal=principal,
                namespace=namespace,
                allowed_signers=allowed_signers,
                owner_room=owner_room,
                sigs_dir=sigs_dir,
            )

    records: dict[str, dict] = {}
    budget = [_MAX_VERIFY_CALLS]

    def _ok(ev: dict) -> bool:
        mid = ev.get("actor_message_id")
        if not mid:
            return False
        charge_key = (ctx, mid)
        if charge_key not in _BUDGET_CHARGED:
            if budget[0] <= 0:
                return False
            budget[0] -= 1
            _BUDGET_CHARGED.add(charge_key)
        return bool(verifier(ev))

    for ev in events:
        dr = ev.get("dr", "")
        etype = ev["type"]
        if etype == "proposed":
            # First proposal wins; a re-proposal of a live id is ignored.
            if dr not in records:
                records[dr] = {
                    "dr": dr,
                    "title": ev.get("title", ""),
                    "project": ev.get("project", ""),
                    "channel": ev.get("channel", ""),
                    "anchor_message_id": ev.get("anchor_message_id", ""),
                    "detail": ev.get("detail", ""),
                    "state": "needs_operator_decision",
                    "created": ev.get("created", ""),
                    "history": [],
                }
            continue
        record = records.get(dr)
        if record is None:
            continue
        if etype in ("ratified", "rejected"):
            if record["state"] != "needs_operator_decision":
                continue
            if not _ok(ev):
                record["history"].append(
                    {"event": ev, "ignored": "actor message unverified"}
                )
                continue
            record["state"] = etype
            record["actor_message_id"] = ev.get("actor_message_id")
        elif etype == "superseded":
            old = records.get(ev.get("supersedes", ""))
            # V1 state machine (spec: superseded follows ratified): a
            # supersede is valid iff old != new AND both are currently
            # ratified. Only an in-force decision may be replaced, by an
            # in-force replacement. This precondition IS the acyclicity
            # guarantee — a superseded node is no longer ratified, so it can
            # never be the old or new of a later supersede — so no separate
            # cycle check is needed. (review MAJOR: projection accepted
            # pending-superseded, self-supersede, and A->B->A cycles.)
            #
            # The cheap structural/state gate runs BEFORE authority (Soul's
            # note): never spend verify budget on a supersede that can't be
            # valid regardless of signature.
            if (
                old is None
                or old is record
                or old["state"] != "ratified"
                or record["state"] != "ratified"
            ):
                record["history"].append(
                    {"event": ev, "ignored": "invalid supersede transition"}
                )
                continue
            # Same authority instrument as ratify/reject: an unsigned
            # supersede line must never rewrite state.
            if not _ok(ev):
                record["history"].append(
                    {"event": ev, "ignored": "actor message unverified"}
                )
                continue
            old["state"] = "superseded"
            old["superseded_by"] = dr
        record["history"].append({"event": ev})
    return records


# Security-critical parser: a hand-typed operator action message must be
# EXACTLY the action phrase — full-body anchored match on the signed wire
# format. `search` on arbitrary bodies let an attacker-quoted phrase inside
# any owner-signed message ratify records (review blocker, executed).
_ACTION_TAIL = (
    r"(accepted|rejected|superseded by dr-\d{1,9})\s*"
    r"\[signed:[^\]]{1,64}\]\s*$"
)


def parse_action_body(
    body: str, *, wire=None
) -> tuple[str, str, str | None] | None:
    """Parse a full signed action body → (dr, verb, superseded_new) or None.

    verb is 'accepted' | 'rejected' | 'superseded'; superseded_new is the
    replacement dr id for supersede actions.
    """
    from porch3.wire import DEFAULT_WIRE

    fmt = wire if wire is not None else DEFAULT_WIRE
    # Combine marker-specific prefix with the fixed action tail.
    prefix = fmt.dr_action_regex().pattern
    # dr_action_regex already anchors ^ and captures the dr id with a trailing space.
    pat = re.compile(prefix + _ACTION_TAIL)
    match = pat.match(body or "")
    if not match:
        return None
    dr, tail = match.group(1), match.group(2)
    if tail.startswith("superseded by "):
        return dr, "superseded", tail.removeprefix("superseded by ")
    return dr, tail, None


_V2_ACTION_RE = re.compile(
    r"^⚖️ DR (dr-\d{1,9}) "
    r"(accepted|rejected|superseded by (dr-\d{1,9}))$"
)


def parse_v2_action_body(body: str) -> tuple[str, str, str | None] | None:
    """Parse one exact undecorated v2 action body."""
    match = _V2_ACTION_RE.fullmatch(body or "")
    if match is None:
        return None
    dr, tail, replacement = match.groups()
    if replacement is not None:
        return dr, "superseded", replacement
    return dr, tail, None


def parse_observed_action(
    msg: dict,
    *,
    owner_room: str,
    wire: WireFormat = DEFAULT_WIRE,
) -> tuple[str, str, str | None] | None:
    """Recognize a live owner action without granting durable authority."""
    if msg.get("from") != owner_room:
        return None
    locator_present = bool(
        msg.get("signature_ref_present", "signature_ref" in msg)
    )
    body = msg.get("body") or ""
    if locator_present:
        return parse_v2_action_body(body)
    return parse_action_body(body, wire=wire)


def has_actor_event(events: list[dict], actor_message_id: str) -> bool:
    return any(ev.get("actor_message_id") == actor_message_id for ev in events)


def badge_for(state: str, *, label: str = "owner") -> str:
    return {
        "needs_operator_decision": f" ⚖️DR·needs {label}",
        "ratified": " ⚖️DR·ratified",
        "rejected": " ⚖️DR·rejected",
        "superseded": " ⚖️DR·superseded",
    }.get(state, "")


def offer_line(record: dict, *, label: str = "owner") -> str:
    return (
        f"⚖️ DR {record['dr']} needs {label} — \"{record['title']}\" "
        f"(project: {record['project']}) · /accept {record['dr']} · "
        f"/reject {record['dr']}"
    )


def propose(
    *,
    title: str,
    project: str,
    channel: str,
    anchor_message_id: str,
    detail: str = "",
    path: Path | None = None,
) -> dict:
    path = path if path is not None else DR_LOG_PATH
    if path is None:
        raise ValueError("no DR log path configured — pass path= explicitly")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Hold the flock across read → allocate → append: allocating outside the
    # lock let racing proposers collide on one dr id, silently binding
    # the owner's accept to whichever proposal replay saw first (review major,
    # reproduced 10/10).
    with open(path, "a+", encoding="utf-8") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.seek(0)
            events = _parse_events(fh.read())
            ev = {
                "type": "proposed",
                "dr": next_dr_id(events),
                "title": title,
                "project": project,
                "channel": channel,
                "anchor_message_id": anchor_message_id,
                "detail": detail,
                "event_id": _event_id(),
                "created": _utc_now(),
            }
            # Never write an id/event replay would drop as invalid — that is
            # exactly how the max-id poison produced permanent invisible ids.
            if not _valid_event(ev):
                raise ValueError(f"refusing to write invalid proposed event: {ev['dr']}")
            fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
            fh.flush()
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)
    return ev


def decide(
    dr: str, verdict: str, actor_message_id: str, path: Path | None = None
) -> dict:
    if verdict not in ("ratified", "rejected"):
        raise ValueError(verdict)
    return append_event(
        {"type": verdict, "dr": dr, "actor_message_id": actor_message_id},
        path,
    )


def supersede(
    old: str, new: str, actor_message_id: str, path: Path | None = None
) -> dict:
    return append_event(
        {
            "type": "superseded",
            "dr": new,
            "supersedes": old,
            "actor_message_id": actor_message_id,
        },
        path,
    )


def _cli() -> int:
    """Agent-facing CLI: propose and inspect without the TUI."""
    require_macos()
    import argparse

    from porch3.config import ConfigError, load_config

    parser = argparse.ArgumentParser(prog="dr", description=__doc__)
    parser.add_argument("--config", default=None, help="porch config.toml path")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("propose", help="append a proposed decision record")
    p.add_argument("--title", required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--channel", required=True)
    p.add_argument("--anchor", required=True, help="consensus message id")
    p.add_argument("--detail", default="")
    sub.add_parser("list", help="print current records as JSON")
    s = sub.add_parser("show", help="print one record as JSON")
    s.add_argument("dr")
    args = parser.parse_args()

    try:
        config = load_config(Path(args.config) if args.config else None)
    except ConfigError as exc:
        print(json.dumps({"error": f"config: {exc}"}))
        return 2

    from porch3.roomcheck import RoomInvariantError, apply_owner_crosscheck

    try:
        config = apply_owner_crosscheck(config)
    except RoomInvariantError as exc:
        print(json.dumps({"error": f"room invariant: {exc}"}))
        return 2

    if args.cmd == "propose":
        ev = propose(
            title=args.title,
            project=args.project,
            channel=args.channel,
            anchor_message_id=args.anchor,
            detail=args.detail,
            path=config.dr_log_path,
        )
        offer = offer_line(
            {"dr": ev["dr"], "title": ev["title"], "project": ev["project"]},
            label=config.label,
        )
        # Spec step 1 requires the offer IN the channel — a record the owner
        # is never offered is a record they can never ratify. Print the exact
        # send command so the proposing agent cannot half-deliver silently.
        print(
            json.dumps(
                {
                    "event": ev,
                    "offer": offer,
                    "post_with": [
                        "post", "chat", ev["channel"], "--send", "--anyway",
                        "--body", offer,
                    ],
                }
            )
        )
        return 0
    records = project(
        replay(config.dr_log_path),
        mail_root=config.mail_root,
        wire=config.wire,
        config=config,
        config_path=config.source_path,
        principal=config.principal,
        namespace=config.signing_namespace,
        allowed_signers=config.allowed_signers,
        owner_room=config.owner_room,
        sigs_dir=config.sigs_dir,
    )
    if args.cmd == "show":
        record = records.get(args.dr)
        if record is None:
            print(json.dumps({"error": f"no such record: {args.dr}"}))
            return 1
        print(json.dumps(record, ensure_ascii=False))
        return 0
    print(json.dumps(records, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
