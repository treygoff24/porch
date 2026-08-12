"""Thin wrappers over the `post` CLI for the calls porch3 does not expose.

Every call runs with cwd=owner_room_dir and POST_MAIL_ROOT pinned from
PorchConfig — identity stays cwd-carried (post's rule).
"""

from __future__ import annotations

import json
import subprocess

from porch3.config import PorchConfig


class PostUnavailable(RuntimeError):
    """post is missing, or missing a flag porchd requires."""


def decode_json(stdout: str, stderr: str) -> dict | None:
    for blob in (stdout, stderr):
        text = (blob or "").strip()
        if not text:
            continue
        start = text.find("{")
        if start < 0:
            continue
        try:
            data = json.loads(text[start:])
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return None


def _run(
    args: list[str],
    *,
    config: PorchConfig,
    timeout: float = 15.0,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["post", *args],
        cwd=config.owner_room_dir,
        env=config.post_env(),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def _flag_unsupported(result: subprocess.CompletedProcess, flag: str) -> bool:
    blob = f"{result.stdout or ''}\n{result.stderr or ''}"
    markers = ("unrecognized argument", "unexpected argument", "unknown flag",
               "unknown option", "invalid option", "unrecognized option")
    return flag in blob and any(marker in blob.lower() for marker in markers)


def discard_through(channel: str, message_id: str, *, config: PorchConfig) -> dict:
    """Move the owner's cursor to exactly ``message_id`` (§6.1, §8).

    Never falls back to plain `--discard`: an unbounded move is precisely
    the thing the delivery token exists to prevent.
    """
    try:
        result = _run(
            ["chat", channel, "--discard-through", message_id, "--json"],
            config=config,
        )
    except FileNotFoundError as exc:
        raise PostUnavailable("the `post` CLI is not on PATH") from exc
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PostUnavailable(f"post chat --discard-through failed: {exc}") from exc
    if _flag_unsupported(result, "--discard-through"):
        raise PostUnavailable(
            "this build of post has no --discard-through; the cursor was NOT "
            "advanced (porchd never falls back to --discard)"
        )
    data = decode_json(result.stdout, result.stderr) or {}
    if result.returncode != 0 and not data:
        raise PostUnavailable(
            (result.stderr or result.stdout or "post chat --discard-through failed").strip()
        )
    if data.get("ok") is False:
        err = data.get("error") or {}
        raise PostUnavailable(str(err.get("message") or err.get("code") or "discard refused"))
    # Field names verified against the live binary: a replay (target at or
    # behind the cursor) is ok:true with advanced:false and an unchanged
    # cursor, which is what makes a retried ack safe.
    return {
        "advanced": bool(data.get("advanced", result.returncode == 0)),
        "prior": data.get("prior_cursor"),
        "cursor": data.get("cursor"),
        "discarded": data.get("discarded"),
    }


def seen_by(channel: str, message_id: str, *, config: PorchConfig) -> list[str]:
    try:
        result = _run(
            ["chat", channel, "--seen-by", message_id, "--json"],
            config=config,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PostUnavailable(f"post chat --seen-by failed: {exc}") from exc
    data = decode_json(result.stdout, result.stderr)
    if not data or not data.get("ok"):
        err = (data or {}).get("error") or {}
        raise PostUnavailable(str(err.get("message") or "seen-by failed"))
    who = data.get("seen_by") or []
    return [name for name in who if isinstance(name, str)]
