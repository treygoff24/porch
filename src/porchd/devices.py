"""Paired-device credentials, pairing tokens, and CSRF secrets (§2).

Only hashes are persisted: the device secret and the per-device CSRF secret
are shown once, at pair time, and compared thereafter in constant time. A
stolen `devices.json` therefore cannot be replayed as a device.
"""

from __future__ import annotations

import hmac
import secrets
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from porchd.state import locked, read_json, write_json

PAIR_TOKEN_TTL_S = 120.0
SECRET_BYTES = 32


def devices_path(root: Path) -> Path:
    return root / "devices.json"


def pairing_path(root: Path) -> Path:
    return root / "pairing.json"


def _hash(secret: str) -> str:
    return sha256(secret.encode()).hexdigest()


@dataclass
class Device:
    device_id: str
    label: str
    created: float
    last_seen: float

    def public(self) -> dict:
        return {
            "device_id": self.device_id,
            "label": self.label,
            "created": self.created,
            "last_seen": self.last_seen,
        }


def _load(root: Path) -> dict:
    data = read_json(devices_path(root), {})
    return data if isinstance(data, dict) else {}


def list_devices(root: Path) -> list[Device]:
    out = []
    for device_id, rec in sorted(_load(root).items()):
        if not isinstance(rec, dict):
            continue
        out.append(
            Device(
                device_id=device_id,
                label=str(rec.get("label", "")),
                created=float(rec.get("created", 0.0)),
                last_seen=float(rec.get("last_seen", 0.0)),
            )
        )
    return out


def create_pairing_token(root: Path, *, ttl_s: float = PAIR_TOKEN_TTL_S) -> str:
    """Mint the one-time pairing token; only its hash is stored."""
    token = secrets.token_urlsafe(SECRET_BYTES)
    with locked(pairing_path(root)):
        write_json(
            pairing_path(root),
            {"token_sha256": _hash(token), "expires": time.time() + ttl_s},
        )
    return token


def pairing_state(root: Path) -> dict:
    data = read_json(pairing_path(root), {})
    return data if isinstance(data, dict) else {}


def consume_pairing_token(root: Path, token: str, *, label: str = "phone") -> tuple[str, str, str] | None:
    """Redeem a pairing token → (device_id, device_secret, csrf_secret).

    Invalidated on success or expiry ONLY (§2): a wrong guess leaves the
    token alive, so a tailnet peer cannot DoS pairing with garbage POSTs.
    """
    if not isinstance(token, str) or not token:
        return None
    with locked(pairing_path(root)):
        state = pairing_state(root)
        stored = state.get("token_sha256")
        expires = state.get("expires")
        if not isinstance(stored, str) or not isinstance(expires, (int, float)):
            return None
        if time.time() >= expires:
            write_json(pairing_path(root), {})
            return None
        if not hmac.compare_digest(stored, _hash(token)):
            return None
        write_json(pairing_path(root), {})

    device_id = secrets.token_hex(8)
    device_secret = secrets.token_urlsafe(SECRET_BYTES)
    csrf_secret = secrets.token_urlsafe(SECRET_BYTES)
    now = time.time()
    with locked(devices_path(root)):
        data = _load(root)
        data[device_id] = {
            "label": label,
            "secret_sha256": _hash(device_secret),
            "csrf_sha256": _hash(csrf_secret),
            "created": now,
            "last_seen": now,
        }
        write_json(devices_path(root), data)
    return device_id, device_secret, csrf_secret


def authenticate(root: Path, presented_secret: str | None) -> str | None:
    """Cookie value → device id, comparing every candidate in constant time."""
    if not presented_secret:
        return None
    digest = _hash(presented_secret)
    match: str | None = None
    for device_id, rec in _load(root).items():
        if not isinstance(rec, dict):
            continue
        stored = rec.get("secret_sha256")
        if isinstance(stored, str) and hmac.compare_digest(stored, digest):
            match = device_id
    return match


def check_csrf(root: Path, device_id: str, presented: str | None) -> bool:
    if not presented:
        return False
    rec = _load(root).get(device_id)
    if not isinstance(rec, dict):
        return False
    stored = rec.get("csrf_sha256")
    return isinstance(stored, str) and hmac.compare_digest(stored, _hash(presented))


def touch(root: Path, device_id: str) -> None:
    with locked(devices_path(root)):
        data = _load(root)
        rec = data.get(device_id)
        if isinstance(rec, dict):
            rec["last_seen"] = time.time()
            write_json(devices_path(root), data)


def revoke(root: Path, label_or_id: str) -> int:
    """Delete every device matching a label or id. Effective immediately."""
    removed = 0
    with locked(devices_path(root)):
        data = _load(root)
        for device_id in list(data):
            rec = data.get(device_id)
            if device_id == label_or_id or (
                isinstance(rec, dict) and rec.get("label") == label_or_id
            ):
                del data[device_id]
                removed += 1
        if removed:
            write_json(devices_path(root), data)
    return removed
