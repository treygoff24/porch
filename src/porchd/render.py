"""Message → JSON, with the sanitize invariant on the way out (P6).

Policy (verification, DR, mention and image classification) reads the raw
store bytes; `sanitize_display` runs last, immediately before
serialization, so raw store text never reaches the browser. Mention spans
are measured on the sanitized string because that is what the client
renders — offsets from the raw text would land in the wrong place once a
control character expanded to an escape.
"""

from __future__ import annotations

from pathlib import Path

from porch3 import drstore
from porch3.images import display_body
from porch3.mentions import body_mentions_owner, mention_pattern
from porch3.sanitize import sanitize_display
from porch3.store import (
    clean_message_body,
    fmt_day,
    fmt_time,
    reply_preview_line,
    sender_label,
)
from porch3.verify import verify_badge
from porch3.wire import DEFAULT_WIRE, WireFormat
from porchd import imagesvc


def mention_spans(
    sanitized: str,
    rooms: frozenset[str] | None,
    *,
    owner_room: str,
) -> list[dict]:
    pattern = mention_pattern(rooms)
    if pattern is None:
        return []
    return [
        {
            "start": match.start(),
            "end": match.end(),
            "room": match.group(1),
            "owner": match.group(1) == owner_room,
        }
        for match in pattern.finditer(sanitized)
    ]


def message_json(
    msg: dict,
    *,
    root: Path,
    device: str,
    theme,
    rooms: frozenset[str] | None,
    own_ids: set[str],
    dr_index: dict[str, str],
    by_id: dict[str, dict],
    owner_room: str,
    previous: dict | None = None,
    spool_dir: Path | None = None,
    wire: WireFormat | None = None,
    owner_accent: str | None = None,
) -> dict:
    from porch3.constants import DEFAULT_OWNER_ACCENT

    own = msg["id"] in own_ids
    raw_body = msg.get("body") or ""
    fmt = wire if wire is not None else DEFAULT_WIRE
    accent = owner_accent if owner_accent is not None else DEFAULT_OWNER_ACCENT
    sender = msg.get("from") or ""

    # Policy on raw bytes, in this order: strip only legacy decoration, then
    # substitute own spool paths for [image N] display tokens. V2 bodies are
    # authored content and stay intact.
    cleaned = clean_message_body(msg, wire=fmt)
    displayed = display_body(cleaned, own=own)
    body = sanitize_display(displayed)

    candidates = imagesvc.candidates_for(raw_body, own=own, spool_dir=spool_dir)
    paths = imagesvc.candidate_paths(raw_body)
    images = []
    for candidate in candidates:
        entry = {
            "index": candidate["index"],
            "name": sanitize_display(candidate["name"]),
            "kind": candidate["kind"],
        }
        if candidate["kind"] == "own":
            # Own/verified spool candidates get their thumbnail grant
            # automatically; foreign ones require the reveal POST.
            entry["grant"] = imagesvc.mint_grant(
                root,
                device=device,
                message_id=msg["id"],
                index=candidate["index"],
                path=paths[candidate["index"]],
            )
        images.append(entry)

    # Owner accent must win in the per-message payload: client colorFor()
    # prioritizes msg.color over bootstrap colors[owner].
    color = accent if sender == owner_room else theme.color(sender)

    day = fmt_day(msg.get("sent") or "")
    return {
        "id": msg["id"],
        "from": sanitize_display(sender),
        "sender_label": sender_label(msg),
        "color": color,
        "time": fmt_time(msg.get("sent") or ""),
        "day": day,
        "day_separator": previous is None or fmt_day(previous.get("sent") or "") != day,
        "event": sanitize_display(msg.get("event") or "") or None,
        "body": body,
        "mentions": mention_spans(body, rooms, owner_room=owner_room),
        "mentions_owner": body_mentions_owner(msg, owner_room, rooms),
        "verify": verify_badge(msg, wire=fmt),
        "dr": dr_index.get(msg["id"], ""),
        "reply": reply_preview_line(msg, by_id),
        "images": images,
        "own": own,
    }


def dr_index_for(
    records: dict[str, dict], channel: str, *, label: str = "owner"
) -> dict[str, str]:
    """Anchor message id → DR badge, scoped to one channel (TUI parity)."""
    return {
        record["anchor_message_id"]: drstore.badge_for(record["state"], label=label)
        for record in records.values()
        if record.get("anchor_message_id") and record.get("channel") == channel
    }


def transcript_text(channel: str, msgs: list[dict]) -> str:
    """The `/save` text format, byte-identical to commands.save_transcript."""
    lines = []
    for m in msgs:
        lines.append(f"--- {m['from']}   {m['sent']}   {m['id']}")
        lines.append(m["body"])
        lines.append("")
    return "\n".join(lines)
