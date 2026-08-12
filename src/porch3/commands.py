"""Slash-command helpers (/copy, /save, /vote, /img, /seen)."""

from __future__ import annotations

import json
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from porch3.config import PorchConfig
from porch3.store import fmt_time


def copy_out(msgs: list[dict], arg: str = "") -> str:
    """/copy [N]: put the Nth-from-last message body on the clipboard."""
    if not msgs:
        return "nothing to copy"
    try:
        n = int(arg) if arg else 1
    except ValueError:
        return f"/copy takes a number, not {arg!r}"
    if not 1 <= n <= len(msgs):
        return f"/copy {n}: only {len(msgs)} messages here"
    m = msgs[-n]
    try:
        subprocess.run(["pbcopy"], input=m["body"].encode(), check=True)
    except (OSError, subprocess.CalledProcessError):
        return "pbcopy failed"
    return f"copied {m['from']} {fmt_time(m['sent'])}"


def save_transcript(channel: str, msgs: list[dict]) -> str:
    """/save: write the channel transcript to a txt file and open it."""
    if not msgs:
        return "nothing to save"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = Path(tempfile.gettempdir()) / f"porch-{channel}-{stamp}.txt"
    lines = []
    for m in msgs:
        lines.append(f"--- {m['from']}   {m['sent']}   {m['id']}")
        lines.append(m["body"])
        lines.append("")
    path.write_text("\n".join(lines))
    subprocess.Popen(["open", str(path)])
    return f"saved {len(msgs)} msgs → {path.name}"


def vote_text(arg: str) -> tuple[str | None, str | None]:
    """/vote <poll-id> <choice> → the 🗳️ ballot format the tally engine counts."""
    parts = arg.split()
    if len(parts) != 2:
        return None, "usage: /vote <poll-id> <choice>"
    poll, choice = parts
    return f"🗳️ {poll}: {choice}", None


def img_body(arg: str, *, spool_dir: Path | None = None) -> tuple[str | None, str | None]:
    """/img <path> → validate, copy into spool, body is the spool path."""
    from porch3.images import ImageValidationError, spool_image

    path_str = arg.strip().strip("'\"")
    if not path_str:
        return None, "usage: /img <path>"
    path = Path(path_str).expanduser()
    if not path.is_file():
        return None, f"no file at {path}"
    try:
        spooled = spool_image(path, spool_dir=spool_dir)
    except ImageValidationError as exc:
        return None, f"/img refused: {exc}"
    return str(spooled), None


def seen_by(
    channel: str, msgs: list[dict], arg: str = "", *, config: PorchConfig
) -> str:
    """/seen [N]: who has read the Nth-from-last message."""
    if not msgs:
        return "nothing to query"
    try:
        n = int(arg) if arg else 1
    except ValueError:
        return f"/seen takes a number, not {arg!r}"
    if not 1 <= n <= len(msgs):
        return f"/seen {n}: only {len(msgs)} messages here"
    m = msgs[-n]
    mid = m["id"]
    try:
        r = subprocess.run(
            ["post", "chat", channel, "--seen-by", mid, "--json"],
            cwd=config.owner_room_dir,
            env=config.post_env(),
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "seen-by failed"
    text = (r.stdout or "").strip()
    start = text.find("{")
    if start < 0:
        return "seen-by failed"
    try:
        data = json.loads(text[start:])
    except ValueError:
        return "seen-by failed"
    if not data.get("ok"):
        err = (data.get("error") or {}).get("message") or "seen-by failed"
        return err
    who = data.get("seen_by") or []
    if not who:
        return f"seen-by {mid[-12:]}: nobody yet"
    return f"seen-by {mid[-12:]}: {', '.join(who)}"
