"""@mention highlighting helpers — boundaries match post's Unicode rules."""

from __future__ import annotations

import json
import os
import re
import subprocess
from functools import lru_cache

from rich.style import Style
from rich.text import Text

from porch3.config import PorchConfig
from porch3.config import DEFAULT_OWNER_ACCENT
from porch3.sanitize import sanitize_display

MENTION_STYLE = Style(color="#7DD3FC", bold=True)

# Match post's is_mention_boundary_char: alphanumeric | '_' | '-'.
# Python \w is Unicode alphanumeric + underscore; add hyphen.
_BOUNDARY = r"[\w\-]"


def owner_mention_style(accent: str = DEFAULT_OWNER_ACCENT) -> Style:
    return Style(color=accent, bold=True)


@lru_cache(maxsize=8)
def _rooms_for(cwd: str, mail_root: str) -> frozenset[str]:
    try:
        env = dict(os.environ)
        env["POST_MAIL_ROOT"] = mail_root
        r = subprocess.run(
            ["post", "rooms", "--json"],
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
        )
        data = json.loads(r.stdout)
        rooms = data.get("rooms") or []
        names = []
        for room in rooms:
            if isinstance(room, str):
                names.append(room)
            elif isinstance(room, dict) and "name" in room:
                names.append(room["name"])
        return frozenset(names)
    except (OSError, ValueError, TypeError, subprocess.TimeoutExpired):
        return frozenset()


def registered_rooms(config: PorchConfig | None = None) -> frozenset[str]:
    if config is None:
        return frozenset()
    return _rooms_for(str(config.owner_room_dir), str(config.mail_root))


def clear_rooms_cache() -> None:
    _rooms_for.cache_clear()


def mention_pattern(rooms: frozenset[str] | None = None) -> re.Pattern[str] | None:
    if not rooms:
        return None
    # Longest first so a longer room name beats its own prefix (@juniper vs @jun)
    ordered = sorted(rooms, key=len, reverse=True)
    escaped = "|".join(re.escape(r) for r in ordered)
    # (?<![\w-])@name(?![\w-]) — same continuation alphabet as post
    return re.compile(rf"(?<!{_BOUNDARY})@({escaped})(?!{_BOUNDARY})")


def highlight_mentions(
    text: str,
    *,
    owner_room: str,
    owner_accent: str = DEFAULT_OWNER_ACCENT,
    rooms: frozenset[str] | None = None,
    envelope_mentions: list[str] | None = None,
) -> Text:
    """Return Rich Text with @room mentions styled.

    Mentions of the owner room get a distinct accent. Envelope mentions are
    consulted only as a hint; body scan still drives spans.
    """
    del envelope_mentions  # reserved for future envelope-only hints
    text = sanitize_display(text)
    result = Text(text)
    pat = mention_pattern(rooms)
    if pat is None:
        return result
    owner_style = owner_mention_style(owner_accent)
    for match in pat.finditer(text):
        room = match.group(1)
        style = owner_style if room == owner_room else MENTION_STYLE
        result.stylize(style, match.start(), match.end())
    return result


def body_mentions_owner(
    msg: dict,
    owner_room: str,
    rooms: frozenset[str] | None = None,
) -> bool:
    mentions = msg.get("mentions") or []
    if owner_room in mentions:
        return True
    body = msg.get("body") or ""
    pat = mention_pattern(rooms)
    if pat is None:
        return False
    return any(m.group(1) == owner_room for m in pat.finditer(body))
