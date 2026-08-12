"""Display-boundary sanitization for store/error-derived text.

Rich Text does not neutralize ESC/CSI/OSC inside plain content — those bytes
reach the terminal. post v0.4 strips controls at its text boundary; porch
reads the store directly and must keep the same invariant at every Rich
Text/Label/Static construction.

Preserve newline and tab. Replace other C0/C1 controls, ESC, bidi/format
controls, and nonprintables with visible control pictures or escaped forms.
Composes with markup=False / Text spans (finding 6); does not replace them.
"""

from __future__ import annotations

import unicodedata

# C0 control pictures U+2400..U+241F; DEL picture U+2421.
_DEL_PICTURE = "\u2421"


def sanitize_display(text: str) -> str:
    """Make untrusted text safe to put in Rich Text / Label / Static content.

    Idempotent for already-sanitized strings (replacements are printable).
    """
    if not text:
        return text
    out: list[str] = []
    for ch in text:
        cp = ord(ch)
        if ch in ("\n", "\t"):
            out.append(ch)
        elif cp < 0x20:
            out.append(chr(0x2400 + cp))
        elif cp == 0x7F:
            out.append(_DEL_PICTURE)
        elif 0x80 <= cp <= 0x9F:
            out.append(f"\\x{cp:02x}")
        elif unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") or not ch.isprintable():
            out.append(f"\\u{cp:04x}" if cp <= 0xFFFF else f"\\U{cp:08x}")
        else:
            out.append(ch)
    return "".join(out)


def contains_raw_controls(text: str) -> bool:
    """True if any disallowed control/format codepoint remains."""
    for ch in text:
        if ch in ("\n", "\t"):
            continue
        cp = ord(ch)
        if cp < 0x20 or cp == 0x7F or 0x80 <= cp <= 0x9F:
            return True
        if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp"):
            return True
        if not ch.isprintable():
            return True
    return False
