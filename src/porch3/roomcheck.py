"""Acting-room invariant + owner-field crosscheck against post.

Startup/doctor/verify share one strict read-only resolver:
``apply_owner_crosscheck``. Room/cwd mismatch hard-stops; any other
duplicated-field disagreement disables sign AND verify.
"""

from __future__ import annotations

import json
import shlex
import subprocess
from typing import Any

from porch3.config import (
    PorchConfig,
    default_label_for,
    default_namespace,
    default_principal,
    owner_field_mismatches,
)
from porch3.wire import DEFAULT_MARKER

# Exact keys required inside the nested ``owner`` object (A0b OwnerJson).
_OWNER_KEYS = (
    "room",
    "sidecar_dir",
    "allowed_signers",
    "principal",
    "namespace",
    "marker",
    "label",
)
_OWNER_SHOW_OUTER = frozenset({"ok", "state", "owner", "note"})
_PROFILE_SHOW_OUTER = frozenset({"ok", "room", "profile", "announced"})


class RoomInvariantError(Exception):
    """Fail closed — no join, no cursor move, no send."""


class OwnerShowError(Exception):
    """post owner show failed schema/exit/configured-state checks."""


def _parse_strict_json_object(stdout: str, *, label: str, returncode: int) -> dict[str, Any]:
    """Require exit 0 and a single JSON object (no ``{...}`` tail salvage)."""
    if returncode != 0:
        raise OwnerShowError(
            f"{label} exited {returncode} (refusing to parse stdout)"
        )
    text = (stdout or "").strip()
    if not text:
        raise OwnerShowError(f"{label} returned empty stdout")
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise OwnerShowError(f"{label} returned invalid JSON") from exc
    if not isinstance(data, dict):
        raise OwnerShowError(f"{label} returned a non-object")
    return data


def _require_exact_keys(
    data: dict[str, Any],
    *,
    required: frozenset[str],
    optional: frozenset[str],
    label: str,
) -> None:
    allowed = required | optional
    keys = frozenset(data.keys())
    missing = required - keys
    if missing:
        raise OwnerShowError(
            f"{label} missing required keys: " + ", ".join(sorted(missing))
        )
    extra = keys - allowed
    if extra:
        raise OwnerShowError(
            f"{label} has unexpected keys: " + ", ".join(sorted(extra))
        )


def _parse_owner_object(owner: Any) -> dict[str, str]:
    """Exact A0b OwnerJson: seven typed string fields, no extras."""
    if not isinstance(owner, dict):
        raise OwnerShowError("post owner show owner must be an object")
    keys = frozenset(owner.keys())
    required = frozenset(_OWNER_KEYS)
    if keys != required:
        missing = required - keys
        extra = keys - required
        parts = []
        if missing:
            parts.append("missing " + ", ".join(sorted(missing)))
        if extra:
            parts.append("extra " + ", ".join(sorted(extra)))
        raise OwnerShowError("post owner show owner schema: " + "; ".join(parts))
    out: dict[str, str] = {}
    for key in _OWNER_KEYS:
        value = owner[key]
        if not isinstance(value, str):
            raise OwnerShowError(
                f"post owner show owner.{key} must be a string"
            )
        out[key] = value
    return out


def assert_acting_room(config: PorchConfig) -> None:
    """Require post's acting-room resolver to equal config.owner_room exactly."""
    try:
        result = subprocess.run(
            ["post", "profile", "show", "--json"],
            cwd=config.owner_room_dir,
            env=config.post_env(),
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RoomInvariantError(
            f"cannot probe acting room via post profile show: {exc}"
        ) from exc
    try:
        data = _parse_strict_json_object(
            result.stdout or "",
            label="post profile show",
            returncode=result.returncode,
        )
        _require_exact_keys(
            data,
            required=frozenset({"ok", "room", "profile"}),
            optional=frozenset({"announced"}),
            label="post profile show",
        )
        if data.get("ok") is not True:
            raise OwnerShowError("post profile show did not report ok=true")
        room = data.get("room")
        if not isinstance(room, str):
            raise OwnerShowError("post profile show room must be a string")
        profile = data.get("profile")
        if not isinstance(profile, dict):
            raise OwnerShowError("post profile show profile must be an object")
        # Profile keys are optional name/pfp only; refuse unknown fields.
        profile_extra = frozenset(profile.keys()) - frozenset({"name", "pfp"})
        if profile_extra:
            raise OwnerShowError(
                "post profile show profile has unexpected keys: "
                + ", ".join(sorted(profile_extra))
            )
        for key in ("name", "pfp"):
            if key in profile and profile[key] is not None and not isinstance(
                profile[key], str
            ):
                raise OwnerShowError(
                    f"post profile show profile.{key} must be a string or null"
                )
        if "announced" in data:
            announced = data["announced"]
            if not isinstance(announced, list) or not all(
                isinstance(item, str) for item in announced
            ):
                raise OwnerShowError(
                    "post profile show announced must be a list of strings"
                )
    except OwnerShowError as exc:
        raise RoomInvariantError(str(exc)) from exc
    if room != config.owner_room:
        raise RoomInvariantError(
            f"acting-room mismatch: config owner_room={config.owner_room!r} "
            f"but post profile show (cwd={config.owner_room_dir}) reports "
            f"room={room!r} — refusing to join/read/send"
        )


def post_owner_init_command(config: PorchConfig) -> str:
    """Shell-safe exact ``post owner init …`` including the resolved mail root.

    Always prefixes ``env POST_MAIL_ROOT=<quoted-absolute>`` so a porch init
    that probed a non-default root cannot suggest a command that writes the
    ambient/default root (onboarding loop).
    """
    parts = ["post", "owner", "init", "--room", config.owner_room]
    if config.marker != DEFAULT_MARKER:
        parts.extend(["--marker", config.marker])
    if config.label != default_label_for(config.owner_room):
        parts.extend(["--label", config.label])
    if config.sidecar_dir != config.owner_room_dir:
        parts.extend(["--sidecar-dir", str(config.sidecar_dir)])
    if config.allowed_signers != config.sidecar_dir / "allowed_signers":
        parts.extend(["--allowed-signers", str(config.allowed_signers)])
    if config.principal != default_principal(config.owner_room):
        parts.extend(["--principal", config.principal])
    if config.signing_namespace != default_namespace(config.owner_room):
        parts.extend(["--namespace", config.signing_namespace])
    cmd = " ".join(shlex.quote(p) for p in parts)
    return (
        f"env POST_MAIL_ROOT={shlex.quote(str(config.mail_root))} {cmd}"
    )


def fetch_owner_show(config: PorchConfig) -> dict[str, str]:
    """Run ``post owner show --json`` under the resolved POST_MAIL_ROOT.

    Requires exit 0, ``ok is True``, ``state == "configured"``, and an exact
    nested ``owner`` object. Returns that owner mapping (seven string fields).
    Raises ``OwnerShowError`` otherwise (legacy/none/unknown/schema), naming
    the exact ``post owner init …`` command when unconfigured/legacy.
    """
    try:
        result = subprocess.run(
            ["post", "owner", "show", "--json"],
            cwd=config.owner_room_dir,
            env=config.post_env(),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError as exc:
        raise OwnerShowError("post CLI not on PATH") from exc
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise OwnerShowError(f"post owner show failed: {exc}") from exc

    data = _parse_strict_json_object(
        result.stdout or "",
        label="post owner show",
        returncode=result.returncode,
    )
    _require_exact_keys(
        data,
        required=frozenset({"ok", "state"}),
        optional=frozenset({"owner", "note"}),
        label="post owner show",
    )
    if data.get("ok") is not True:
        raise OwnerShowError("post owner show did not report ok=true")
    state = data.get("state")
    if state != "configured":
        cmd = post_owner_init_command(config)
        raise OwnerShowError(
            f"post owner state is {state!r} (need configured) — run `{cmd}` first"
        )
    if "owner" not in data:
        raise OwnerShowError("post owner show missing owner object")
    if "note" in data and data["note"] is not None and not isinstance(
        data["note"], str
    ):
        raise OwnerShowError("post owner show note must be a string")
    return _parse_owner_object(data["owner"])


def apply_owner_crosscheck(config: PorchConfig) -> PorchConfig:
    """Strict read-only owner crosscheck used by TUI, service, verify, doctor.

    - Room mismatch → ``RoomInvariantError`` (hard-stop).
    - Schema / nonzero exit / missing fields / any other duplicated-field
      mismatch → return config with signing AND verification disabled.
    - Full agreement → return config unchanged.
    """
    try:
        post_owner = fetch_owner_show(config)
    except OwnerShowError as exc:
        return config.with_signing_disabled(str(exc))

    post_room = post_owner["room"]
    if post_room != config.owner_room:
        raise RoomInvariantError(
            f"owner room mismatch: config owner_room={config.owner_room!r} "
            f"but post owner show reports room={post_room!r} — "
            "refusing to join/read/send"
        )

    mismatches = owner_field_mismatches(config, post_owner)
    # Room already checked; strip room entries if present.
    mismatches = [m for m in mismatches if not m.startswith("room:")]
    if mismatches:
        return config.with_signing_disabled(
            "post owner fields disagree: " + "; ".join(mismatches)
        )
    return config
