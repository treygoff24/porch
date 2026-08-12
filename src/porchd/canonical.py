"""Canonical length-delimited hashing (§7).

Textual concatenation is ambiguous under adversarial boundaries: with
`H(draft_text + ids)`, a draft ending in an id-shaped tail and a draft with
one fewer attachment can produce identical bytes, and two different
requests would then share an idempotency identity. Canonical JSON gives
each field unambiguous boundaries; the byte-length prefix makes the whole
serialization self-delimiting as well.
"""

from __future__ import annotations

import json
from hashlib import sha256


def serialize(value) -> bytes:
    """Canonical JSON: sorted keys, no insignificant whitespace, UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode()


def digest(value) -> str:
    payload = serialize(value)
    return sha256(f"{len(payload)}:".encode() + payload).hexdigest()
