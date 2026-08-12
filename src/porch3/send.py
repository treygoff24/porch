"""Send path through `post chat`, including crossed_send bounce handling."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field

from porch3.config import PorchConfig


# Errors that mean the channel mutation (or signed payload) committed and
# must not be retried. Matches post's delivered_output_failure law.
COMMITTED_ERROR_CODES = frozenset(
    {
        "delivered_output_failure",
        "delivered_unarchived",
    }
)


@dataclass
class SendResult:
    ok: bool
    error_code: str | None = None
    message: str = ""
    missed: list[dict] = field(default_factory=list)
    raw: dict | None = None

    @property
    def crossed(self) -> bool:
        return self.error_code == "crossed_send"

    @property
    def committed(self) -> bool:
        """True when the send side-effect already landed — do not retry."""
        return self.error_code in COMMITTED_ERROR_CODES


def _decode_post_json(stdout: str, stderr: str) -> dict | None:
    for blob in (stdout, stderr):
        text = (blob or "").strip()
        if not text:
            continue
        # post may print a text identity line before JSON
        start = text.find("{")
        if start < 0:
            continue
        try:
            return json.loads(text[start:])
        except ValueError:
            continue
    return None


def catch_up_as_owner(channel: str, *, config: PorchConfig) -> bool:
    """Move the owner's read cursor past all unread."""
    r = subprocess.run(
        ["post", "chat", channel, "--discard"],
        cwd=config.owner_room_dir,
        env=config.post_env(),
        capture_output=True,
    )
    return r.returncode == 0


def send_as_owner(
    channel: str,
    text: str,
    *,
    config: PorchConfig,
    raw: bool = False,
    anyway: bool = False,
) -> SendResult:
    body = text if raw else config.wire.prefix_casual(text)
    cmd = ["post", "chat", channel, "--send", "--json", "--body", body]
    if anyway:
        # --anyway must precede --body for post's argparse; insert after --send
        cmd = [
            "post",
            "chat",
            channel,
            "--send",
            "--anyway",
            "--json",
            "--body",
            body,
        ]
    r = subprocess.run(
        cmd,
        cwd=config.owner_room_dir,
        env=config.post_env(),
        capture_output=True,
        text=True,
    )
    data = _decode_post_json(r.stdout, r.stderr)
    if r.returncode == 0:
        return SendResult(ok=True, message="sent", raw=data)
    if isinstance(data, dict) and data.get("ok") is False:
        err = data.get("error") or {}
        code = err.get("code")
        details = err.get("details") or {}
        missed = details.get("missed") if isinstance(details, dict) else None
        if not isinstance(missed, list):
            missed = []
        # Normalize missed entries into msg-like dicts
        normalized = []
        for item in missed:
            if not isinstance(item, dict):
                continue
            normalized.append(
                {
                    "id": item.get("id", "?"),
                    "from": item.get("from", "?"),
                    "sent": item.get("sent", ""),
                    "body": (item.get("body") or "").rstrip("\n"),
                    "event": item.get("event"),
                    "display_name": item.get("display_name"),
                    "pfp": item.get("pfp"),
                    "re": item.get("re"),
                    "mentions": item.get("mentions") or [],
                }
            )
        return SendResult(
            ok=False,
            error_code=code,
            message=err.get("message") or code or "SEND FAILED",
            missed=normalized,
            raw=data,
        )
    return SendResult(ok=False, error_code="send_failed", message="SEND FAILED")
