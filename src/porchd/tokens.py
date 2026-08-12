"""Opaque, expiring, HMAC-bound capability tokens.

Delivery tokens (§8), bounce tokens (§7), image grants and upload ids (§5)
are all the same shape: a server-authored claim set the client cannot read
or forge, carrying its own kind and expiry. The kind is mixed into the MAC,
so a delivery token can never be redeemed as an image grant.
"""

from __future__ import annotations

import base64
import hmac
import json
import time
from hashlib import sha256
from pathlib import Path

from porchd.state import server_key


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _mac(key: bytes, kind: str, payload: bytes) -> bytes:
    return hmac.new(key, kind.encode() + b"\x00" + payload, sha256).digest()


def mint(root: Path, kind: str, claims: dict, ttl_s: float, *, now: float | None = None) -> str:
    now = time.time() if now is None else now
    body = dict(claims)
    body["k"] = kind
    body["x"] = now + ttl_s
    payload = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    key = server_key(root)
    return f"{_b64(payload)}.{_b64(_mac(key, kind, payload))}"


def verify(root: Path, kind: str, token: str, *, now: float | None = None) -> dict | None:
    """Return the claims of a live token of exactly ``kind``, else None."""
    now = time.time() if now is None else now
    if not isinstance(token, str) or token.count(".") != 1:
        return None
    encoded, sig = token.split(".", 1)
    try:
        payload = _unb64(encoded)
        given = _unb64(sig)
    except (ValueError, TypeError):
        return None
    if not hmac.compare_digest(_mac(server_key(root), kind, payload), given):
        return None
    try:
        claims = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(claims, dict) or claims.get("k") != kind:
        return None
    expiry = claims.get("x")
    if not isinstance(expiry, (int, float)) or now >= expiry:
        return None
    return claims
