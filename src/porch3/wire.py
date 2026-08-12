"""Owner wire-format helpers — single definition site for the marker glyph.

The casual prefix is ``<marker> ``; the signed prefix is ``<marker>🔏 ``.
Only the marker varies; the lock glyph and `` [signed:<ts>]`` tag grammar
are fixed protocol.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Default owner marker — the ONLY place this glyph may appear under src/.
DEFAULT_MARKER = "🦊"
_LOCK = "🔏"


@dataclass(frozen=True)
class WireFormat:
    """Compiled prefixes + parsers for one owner marker."""

    marker: str

    @property
    def casual_prefix(self) -> str:
        return f"{self.marker} "

    @property
    def signed_prefix(self) -> str:
        return f"{self.marker}{_LOCK} "

    @property
    def signed_startswith(self) -> str:
        return f"{self.marker}{_LOCK}"

    def prefix_casual(self, text: str) -> str:
        return f"{self.casual_prefix}{text}"

    def prefix_signed(self, text: str, tag: str) -> str:
        return f"{self.signed_prefix}{text} [signed:{tag}]"

    def is_signed(self, body: str) -> bool:
        return body.startswith(self.signed_startswith) and "[signed:" in body

    def strip(self, body: str) -> str:
        """Strip wire prefixes and optional signed-tag / legacy trailer."""
        signed = body.startswith(self.signed_startswith)
        for prefix in (self.signed_prefix, self.casual_prefix):
            if body.startswith(prefix):
                body = body[len(prefix) :]
                break
        if signed:
            if " [signed:" in body:
                body = body.split(" [signed:")[0]
            if "--- SIGNED " in body:
                body = body.split("--- SIGNED ")[0].rstrip("- \n")
        return body.strip()

    def channel_text_for_verify(self, body: str, tag: str) -> str | None:
        """Extract signed channel text from an exact one-line tagged body.

        Accepts an optional single trailing newline. Refuses mid-line prefixes,
        extra lines, and multi-tag salvage — a signed substring must not lend
        VERIFIED to surrounding unsigned content.
        """
        if body.endswith("\n"):
            body = body[:-1]
        if body.endswith("\r"):
            return None
        if "\n" in body or "\r" in body:
            return None
        suffix = f" [signed:{tag}]"
        if not body.startswith(self.signed_prefix) or not body.endswith(suffix):
            return None
        # Exactly one tag, trailing.
        if body.count("[signed:") != 1:
            return None
        return body[len(self.signed_prefix) : -len(suffix)]

    def dr_action_regex(self) -> re.Pattern[str]:
        """Authority regex for signed DR action bodies."""
        return re.compile(
            rf"^{re.escape(self.signed_prefix)}⚖️ DR (dr-\d{{1,9}}) "
        )


def compile_wire(marker: str) -> WireFormat:
    return WireFormat(marker=marker)


DEFAULT_WIRE = compile_wire(DEFAULT_MARKER)
