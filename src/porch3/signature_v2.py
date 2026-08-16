"""Canonical signed-message-v2 manifest construction."""

from __future__ import annotations

import hashlib
import re
import unicodedata

MAX_SIGNED_BODY_BYTES = 1_048_576
POST_DEFAULT_BODY_BYTES = 32 * 1024

_TAG_RE = re.compile(r"[0-9A-Za-z-]+")


def _validate_component(value: str, *, name: str) -> None:
    if not value:
        raise ValueError(f"{name} must not be empty")
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise ValueError(f"{name} must not contain control characters")
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise ValueError(f"{name} must be one path-safe component")


def validate_tag(tag: str) -> str:
    """Return a valid Post sidecar tag or raise ``ValueError``."""
    if not isinstance(tag, str) or _TAG_RE.fullmatch(tag) is None:
        raise ValueError("tag must contain only ASCII letters, digits, and '-'")
    return tag


def validate_channel(channel: str) -> str:
    """Return a newline-free Post channel storage component."""
    if not isinstance(channel, str):
        raise ValueError("channel must be a string")
    _validate_component(channel, name="channel")
    return channel


def body_bytes(body: str) -> bytes:
    """Encode the final body without normalization or replacement."""
    if not isinstance(body, str):
        raise TypeError("body must be a string")
    return body.encode("utf-8", errors="strict")


def manifest_bytes(tag: str, channel: str, body: str) -> bytes:
    """Construct the exact ASCII manifest signed by Porch and read by Post."""
    validate_tag(tag)
    validate_channel(channel)
    raw = body_bytes(body)
    digest = hashlib.sha256(raw).hexdigest()
    return (
        "porch-signed-v2\n"
        f"tag: {tag}\n"
        f"channel: {channel}\n"
        f"bytes: {len(raw)}\n"
        f"sha256: {digest}\n"
    ).encode("utf-8")
