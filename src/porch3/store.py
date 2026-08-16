"""Cursorless channel-store reads and channel discovery."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from porch3.config import PorchConfig
from porch3.sanitize import sanitize_display
from porch3.wire import DEFAULT_WIRE, WireFormat


def parse_msg(path: Path) -> dict | None:
    """Parse a `.msg` file. Invalid envelopes are skipped (never crash).

    Requires a `\\n---\\n` separator, a JSON object head, typed required
    fields (`id`/`from`/`sent` as str), and `id == filename stem`.
    """
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    separator = b"\n---\n"
    if separator not in raw:
        return None
    head_bytes, _, body_bytes = raw.partition(separator)
    try:
        meta = json.loads(head_bytes.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    mid = meta.get("id")
    sender = meta.get("from")
    sent = meta.get("sent")
    if not isinstance(mid, str) or not isinstance(sender, str) or not isinstance(sent, str):
        return None
    if mid != path.stem:
        return None
    body = body_bytes.decode("utf-8", errors="replace")
    signature_ref_present = "signature_ref" in meta
    mentions = meta.get("mentions") or []
    if not isinstance(mentions, list):
        mentions = []
    mentions = [m for m in mentions if isinstance(m, str)]
    return {
        "id": mid,
        "from": sender,
        "sent": sent,
        "event": meta.get("event") if isinstance(meta.get("event"), str) else None,
        "display_name": meta.get("display_name")
        if isinstance(meta.get("display_name"), str)
        else None,
        "pfp": meta.get("pfp") if isinstance(meta.get("pfp"), str) else None,
        "re": meta.get("re") if isinstance(meta.get("re"), str) else None,
        "mentions": mentions,
        # A present locator is sender data, not authority, but it tells the UI
        # that decoration stripping would corrupt a possible v2 body. The full
        # verifier independently decides whether the locator has authority.
        "body": body if signature_ref_present else body.strip(),
        "signature_ref_present": signature_ref_present,
        "signature_ref": meta.get("signature_ref"),
        "storage_channel": path.parent.parent.name,
        "envelope_channel": meta.get("channel"),
        "stem": path.stem,
    }


def sender_label(m: dict) -> str:
    room = sanitize_display(m["from"])
    name = m.get("display_name")
    pfp = m.get("pfp")
    if name:
        label = sanitize_display(name) or room
        if label != room:
            label = f"{label} ({room})"
    else:
        label = room
    if pfp:
        pfp = sanitize_display(pfp)
        if pfp:
            label = f"{pfp} {label}"
    return label


def channel_store(channel: str, root: Path) -> Path:
    return root / channel / "messages"


def channel_meta_path(channel: str, root: Path) -> Path:
    return root / channel / "channel.json"


def channel_description(channel: str, root: Path) -> str:
    path = channel_meta_path(channel, root)
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError, TypeError):
        return ""
    if not isinstance(data, dict):
        return ""
    desc = data.get("description")
    if isinstance(desc, str):
        return sanitize_display(desc.strip())
    return ""


def discover_channels(root: Path) -> list[str]:
    if not root.is_dir():
        return []
    return sorted(
        path.name
        for path in root.iterdir()
        if path.is_dir() and (path / "messages").is_dir()
    )


def load_all(channel: str, root: Path) -> list[dict]:
    msgs = []
    store = channel_store(channel, root)
    if store.is_dir():
        for p in sorted(store.glob("*.msg")):
            m = parse_msg(p)
            if m:
                msgs.append(m)
    return msgs


def load_new(channel: str, seen: set[str], root: Path) -> list[dict]:
    """Parse only .msg files whose stem is not already in seen.

    `seen` must be keyed on filename stems (identical to envelope id after
    parse_msg validation).
    """
    msgs = []
    store = channel_store(channel, root)
    if store.is_dir():
        for p in sorted(store.glob("*.msg")):
            if p.stem in seen:
                continue
            m = parse_msg(p)
            if m:
                msgs.append(m)
    return msgs


def clean_body(body: str, *, wire: WireFormat = DEFAULT_WIRE) -> str:
    return wire.strip(body)


def clean_message_body(msg: dict, *, wire: WireFormat = DEFAULT_WIRE) -> str:
    """Return a display body without interpreting v2 content as decoration."""
    body = msg.get("body") or ""
    present = bool(
        msg.get("signature_ref_present", "signature_ref" in msg)
    )
    return body if present else clean_body(body, wire=wire)


def fmt_time(sent: str) -> str:
    # sent is store data — sanitize here so every header/preview consumer
    # inherits the terminal-control boundary.
    return sanitize_display(sent[11:16]) if len(sent) >= 16 else "??:??"


def fmt_day(sent: str) -> str:
    return sanitize_display(sent[:10]) if len(sent) >= 10 else "?"


def channel_preview(channel: str, root: Path) -> tuple[str, str, str]:
    store = channel_store(channel, root)
    msg = None
    for path in sorted(store.glob("*.msg"), reverse=True):
        candidate = parse_msg(path)
        if candidate and candidate["event"] != "join":
            msg = candidate
            break
    if not msg:
        return ("--:--", "—", "No messages yet")
    preview = " ".join(clean_message_body(msg).split()) or "(empty)"
    return (
        fmt_time(msg["sent"]),
        sanitize_display(msg["from"]),
        sanitize_display(preview),
    )


def channel_members(channel: str, root: Path) -> list[str]:
    """Member room ids for a channel (stable sorted)."""
    members_path = root / channel / "members.json"
    members: list[str] = []
    try:
        data = json.loads(members_path.read_text())
    except (OSError, ValueError, TypeError):
        return []
    if isinstance(data, list):
        members = [m for m in data if isinstance(m, str)]
    elif isinstance(data, dict):
        if "members" in data and isinstance(data["members"], list):
            members = [m for m in data["members"] if isinstance(m, str)]
        else:
            members = [k for k in data.keys() if isinstance(k, str)]
    return sorted(set(members))


def join_channel(channel: str, *, config: PorchConfig) -> bool:
    result = subprocess.run(
        ["post", "chat", channel, "--join"],
        cwd=config.owner_room_dir,
        env=config.post_env(),
        capture_output=True,
    )
    return result.returncode == 0


def sync_channels(
    known: set[str], root: Path, *, config: PorchConfig
) -> tuple[list[str], list[str]]:
    channels = discover_channels(root)
    failures = []
    for channel in channels:
        if channel in known:
            continue
        if join_channel(channel, config=config):
            known.add(channel)
        else:
            failures.append(channel)
    return channels, failures


def short_id(msg_id: str) -> str:
    parts = msg_id.split("-")
    if parts:
        return parts[-1][:6] or msg_id[:8]
    return msg_id[:8]


def reply_preview_line(msg: dict, by_id: dict[str, dict]) -> str | None:
    """Compact ↳ re line for threads-lite, or None when no re stamp."""
    re_id = msg.get("re")
    if not re_id:
        return None
    parent = by_id.get(re_id)
    if parent is None:
        for mid, candidate in by_id.items():
            if mid.startswith(re_id) or re_id.startswith(mid):
                parent = candidate
                break
    sid = sanitize_display(short_id(re_id))
    if parent is None:
        return f"↳ re {sid}"
    clean_parent = clean_message_body(parent)
    preview = " ".join(clean_parent.split())[:40]
    if len(" ".join(clean_parent.split())) > 40:
        preview = preview.rstrip() + "…"
    return sanitize_display(
        f"↳ re {sid} ({parent['from']}: {preview})"
    )


def index_by_id(msgs: list[dict]) -> dict[str, dict]:
    return {m["id"]: m for m in msgs}
