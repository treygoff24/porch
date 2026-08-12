"""PorchConfig — frozen identity config loaded once before app/service construction.

Location: ``~/.config/porch/config.toml`` (TOML). Optional derivables are
omitted on emit, not null. Identity is passed through seams — this module
holds no process-global active config.

``PORCH_CONFIG`` (env) is the supported override for the config path. The
TUI and ``porch-verify`` honor it on load; porchd's LaunchAgent pins the
resolved absolute source path into the daemon environment so a setup-shell
override cannot split TUI identity from the service. Prefer writing the
path into the plist via provisioning rather than relying on ambient shell
state.
"""

from __future__ import annotations

import os
import re
import stat
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping

import regex as _regex

from porch3.wire import DEFAULT_MARKER, compile_wire

CONFIG_DIR = Path.home() / ".config" / "porch"
CONFIG_PATH = CONFIG_DIR / "config.toml"

DEFAULT_OWNER_ACCENT = "#FFD700"
DEFAULT_INITIAL_CHANNEL = "commons"
DEFAULT_MAIL_ROOT = Path.home() / ".claude-mail"

# A0a bounds: principal 1-128 / namespace 1-64, ASCII-safe for ssh-keygen.
_PRINCIPAL_RE = re.compile(r"^[A-Za-z0-9._@-]{1,128}$")
_NAMESPACE_RE = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

# Control / bidi / line+paragraph separators — shared reject set matching
# Post's refused_profile_char (Cc + bidi/direction Cf + Zl/Zp). ZWJ (U+200D)
# and VS16 (U+FE0F) stay legal inside a marker grapheme cluster.
_BIDI_AND_CONTROLS = (
    set(range(0x00, 0x20))
    | {0x7F}
    | set(range(0x80, 0xA0))
    | {
        0x061C,
        0x202A,
        0x202B,
        0x202C,
        0x202D,
        0x202E,
        0x2066,
        0x2067,
        0x2068,
        0x2069,
        0x200E,
        0x200F,
        0x2028,
        0x2029,
    }
)
_ZWJ = "\u200d"
# Full UAX #29 extended grapheme clusters (same predicate as Post
# ``UnicodeSegmentation::graphemes(true)`` / Rust unicode-segmentation).
_GRAPHEME_RE = _regex.compile(r"\X")


def _refused_profile_char(ch: str) -> bool:
    """Post refused_profile_char — control / bidi / line separators."""
    return ord(ch) in _BIDI_AND_CONTROLS or ch.isascii() and not ch.isprintable()


def _grapheme_clusters(text: str) -> list[str]:
    """Extended grapheme clusters via the ``regex`` module's UAX #29 ``\\X``."""
    return _GRAPHEME_RE.findall(text)

_KNOWN_FIELDS = frozenset(
    {
        "owner_room",
        "owner_room_dir",
        "mail_root",
        "sidecar_dir",
        "allowed_signers",
        "key_file",
        "signing_namespace",
        "principal",
        "marker",
        "label",
        "initial_channel",
        "owner_accent",
    }
)

# Duplicated owner fields cross-checked vs `post owner show`.
# Room mismatch hard-stops the app; any other mismatch disables sign+verify.
_OWNER_CROSSCHECK_FIELDS = (
    "room",
    "sidecar_dir",
    "allowed_signers",
    "principal",
    "signing_namespace",
    "marker",
    "label",
)


class ConfigError(Exception):
    """Hard startup / init error naming the offending field or rule."""

    def __init__(self, message: str, *, field: str | None = None):
        super().__init__(message)
        self.field = field


def _reject_controls(value: str, *, field: str) -> None:
    for ch in value:
        if ord(ch) in _BIDI_AND_CONTROLS or ch in "\n\r\t":
            raise ConfigError(
                f"config field {field!r} rejects control/bidi/newline characters",
                field=field,
            )


def validate_marker(marker: str) -> str:
    """A0a/Post marker: exactly one extended grapheme cluster.

    Same predicate as Post ``validate_marker``: refuse edge-ZWJ, control/bidi/
    line separators, and ASCII; accept multi-scalar glyphs such as 👩‍🚀 / ⚖️.
    """
    if not isinstance(marker, str):
        raise ConfigError("marker must be a string", field="marker")
    if not marker:
        raise ConfigError(
            "marker must be exactly one glyph (one grapheme cluster)",
            field="marker",
        )
    if marker.startswith(_ZWJ) or marker.endswith(_ZWJ):
        raise ConfigError(
            "marker must not start or end with a zero-width joiner "
            "(ZWJ-abuse refused)",
            field="marker",
        )
    clusters = _grapheme_clusters(marker)
    if len(clusters) != 1:
        raise ConfigError(
            "marker must be exactly one glyph (one grapheme cluster)",
            field="marker",
        )
    if any(_refused_profile_char(ch) for ch in marker):
        raise ConfigError(
            "marker contains control, bidi, or line-separator characters",
            field="marker",
        )
    if marker.isascii():
        raise ConfigError(
            "marker must be a non-ASCII glyph, not ASCII",
            field="marker",
        )
    return marker


def validate_label(label: str) -> str:
    if not isinstance(label, str):
        raise ConfigError("label must be a string", field="label")
    if label.strip() == "":
        raise ConfigError(
            "label must not be empty or whitespace-only",
            field="label",
        )
    n = len(label)
    if n < 1 or n > 32:
        raise ConfigError(
            "label must be 1-32 Unicode scalar values",
            field="label",
        )
    _reject_controls(label, field="label")
    return label


def validate_principal(principal: str) -> str:
    if not _PRINCIPAL_RE.fullmatch(principal):
        raise ConfigError(
            "principal must match [A-Za-z0-9._@-]{1,128}",
            field="principal",
        )
    return principal


def validate_namespace(namespace: str) -> str:
    if not _NAMESPACE_RE.fullmatch(namespace):
        raise ConfigError(
            "signing_namespace must match [A-Za-z0-9._@-]{1,64}",
            field="signing_namespace",
        )
    return namespace


def default_label_for(room: str) -> str:
    if not room:
        return room
    return room[0].upper() + room[1:]


def default_principal(room: str) -> str:
    return f"{room}@porch"


def default_namespace(room: str) -> str:
    return f"{room}-porch"


def validate_abs_path(value: Path | str, *, field: str) -> Path:
    """Normalize Path|str through one absolute + control-rejecting validator.

    CLI argparse converts every path flag to ``Path``; Path inputs previously
    skipped ``_reject_controls``, so absolute newline/control-bearing paths
    reached preflight/mutation. Every path field goes through here.
    """
    if isinstance(value, Path):
        raw = str(value)
    elif isinstance(value, str):
        raw = value
    else:
        raise ConfigError(f"{field} must be a string or Path", field=field)
    _reject_controls(raw, field=field)
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ConfigError(f"{field} must be an absolute path", field=field)
    return path


def resolve_mail_root(
    explicit: Path | str | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> Path:
    """Precedence: explicit config field > POST_MAIL_ROOT env > ~/.claude-mail.

    A *present* ``POST_MAIL_ROOT`` (including the empty string) is always
    validated as an absolute path — matching Post's config_invalid refusal.
    Only a truly absent variable falls through to the default.
    """
    if explicit is not None:
        return validate_abs_path(explicit, field="mail_root")
    environ = env if env is not None else os.environ
    if "POST_MAIL_ROOT" in environ:
        return validate_abs_path(environ["POST_MAIL_ROOT"], field="mail_root")
    return DEFAULT_MAIL_ROOT


def _abs_path(value: Any, *, field: str) -> Path:
    """TOML/dict string path → absolute (controls rejected)."""
    if not isinstance(value, str):
        raise ConfigError(f"{field} must be a string path", field=field)
    return validate_abs_path(value, field=field)


def _require_str(data: Mapping[str, Any], key: str) -> str:
    if key not in data:
        raise ConfigError(f"missing required field {key!r}", field=key)
    value = data[key]
    if not isinstance(value, str):
        raise ConfigError(f"{key} must be a string", field=key)
    _reject_controls(value, field=key)
    if not value:
        raise ConfigError(f"{key} must be non-empty", field=key)
    return value


@dataclass(frozen=True)
class PorchConfig:
    """Resolved identity. All path fields are absolute; optionals are filled."""

    owner_room: str
    owner_room_dir: Path
    mail_root: Path
    sidecar_dir: Path
    allowed_signers: Path
    key_file: Path
    signing_namespace: str
    principal: str
    marker: str
    label: str
    initial_channel: str = DEFAULT_INITIAL_CHANNEL
    owner_accent: str = DEFAULT_OWNER_ACCENT
    # Which optional keys were present in the source document (for emit).
    explicit_fields: frozenset[str] = field(default_factory=frozenset)
    # Set by doctor/startup when duplicated owner fields disagree with post.
    signing_disabled: bool = False
    signing_disabled_reason: str | None = None
    # Absolute path of the TOML this config was loaded from (daemon pin).
    source_path: Path | None = None

    @property
    def channels_dir(self) -> Path:
        return self.mail_root / "channels"

    @property
    def sigs_dir(self) -> Path:
        return self.sidecar_dir / "sigs"

    @property
    def dr_log_path(self) -> Path:
        return self.owner_room_dir / "decision-records.jsonl"

    @property
    def wire(self):
        return compile_wire(self.marker)

    def post_env(self, base: Mapping[str, str] | None = None) -> dict[str, str]:
        """Env for every post subprocess: pin POST_MAIL_ROOT to resolved root."""
        env = dict(base if base is not None else os.environ)
        env["POST_MAIL_ROOT"] = str(self.mail_root)
        return env

    def verified_render(self) -> str:
        """Immutable-id rule: ``<label> (<owner_room>)``."""
        return f"{self.label} ({self.owner_room})"

    def with_signing_disabled(self, reason: str) -> PorchConfig:
        return replace(self, signing_disabled=True, signing_disabled_reason=reason)

    def as_emit_dict(self) -> dict[str, str]:
        """Flat string map for TOML emit; omits derived optionals."""
        out: dict[str, str] = {
            "owner_room": self.owner_room,
            "owner_room_dir": str(self.owner_room_dir),
            "marker": self.marker,
            "label": self.label,
        }
        # mail_root: always persist when explicit OR when init resolved it
        # (init always marks mail_root explicit after resolution).
        if "mail_root" in self.explicit_fields:
            out["mail_root"] = str(self.mail_root)
        if "sidecar_dir" in self.explicit_fields:
            out["sidecar_dir"] = str(self.sidecar_dir)
        if "allowed_signers" in self.explicit_fields:
            out["allowed_signers"] = str(self.allowed_signers)
        if "key_file" in self.explicit_fields:
            out["key_file"] = str(self.key_file)
        if "signing_namespace" in self.explicit_fields:
            out["signing_namespace"] = self.signing_namespace
        if "principal" in self.explicit_fields:
            out["principal"] = self.principal
        if (
            "initial_channel" in self.explicit_fields
            or self.initial_channel != DEFAULT_INITIAL_CHANNEL
        ):
            out["initial_channel"] = self.initial_channel
        if (
            "owner_accent" in self.explicit_fields
            or self.owner_accent != DEFAULT_OWNER_ACCENT
        ):
            out["owner_accent"] = self.owner_accent
        return out


def build_config(
    *,
    owner_room: str,
    owner_room_dir: Path | str,
    mail_root: Path | str | None = None,
    sidecar_dir: Path | str | None = None,
    allowed_signers: Path | str | None = None,
    key_file: Path | str | None = None,
    signing_namespace: str | None = None,
    principal: str | None = None,
    marker: str | None = None,
    label: str | None = None,
    initial_channel: str | None = None,
    owner_accent: str | None = None,
    env: Mapping[str, str] | None = None,
    explicit_fields: frozenset[str] | None = None,
) -> PorchConfig:
    """Validate + resolve a PorchConfig from keyword fields (tests / init)."""
    if not isinstance(owner_room, str) or not owner_room:
        raise ConfigError("owner_room must be a non-empty string", field="owner_room")
    _reject_controls(owner_room, field="owner_room")

    room_dir = validate_abs_path(owner_room_dir, field="owner_room_dir")

    explicit = set(explicit_fields or ())
    resolved_mail = resolve_mail_root(mail_root, env=env)
    if mail_root is not None:
        explicit.add("mail_root")

    sc_dir = room_dir
    if sidecar_dir is not None:
        sc_dir = validate_abs_path(sidecar_dir, field="sidecar_dir")
        explicit.add("sidecar_dir")

    signers = sc_dir / "allowed_signers"
    if allowed_signers is not None:
        signers = validate_abs_path(allowed_signers, field="allowed_signers")
        explicit.add("allowed_signers")

    key = room_dir / f"{owner_room}_porch_key"
    if key_file is not None:
        key = validate_abs_path(key_file, field="key_file")
        explicit.add("key_file")

    ns = default_namespace(owner_room)
    if signing_namespace is not None:
        ns = validate_namespace(signing_namespace)
        explicit.add("signing_namespace")
    else:
        ns = validate_namespace(ns)

    prin = default_principal(owner_room)
    if principal is not None:
        prin = validate_principal(principal)
        explicit.add("principal")
    else:
        prin = validate_principal(prin)

    mk = validate_marker(marker if marker is not None else DEFAULT_MARKER)
    if marker is not None:
        explicit.add("marker")

    lab = validate_label(label if label is not None else default_label_for(owner_room))
    if label is not None:
        explicit.add("label")

    chan = initial_channel if initial_channel is not None else DEFAULT_INITIAL_CHANNEL
    if not isinstance(chan, str) or not chan:
        raise ConfigError(
            "initial_channel must be a non-empty string",
            field="initial_channel",
        )
    _reject_controls(chan, field="initial_channel")
    if initial_channel is not None:
        explicit.add("initial_channel")

    accent = owner_accent if owner_accent is not None else DEFAULT_OWNER_ACCENT
    if not isinstance(accent, str) or not _HEX_COLOR_RE.fullmatch(accent):
        raise ConfigError(
            "owner_accent must be a #RRGGBB hex color",
            field="owner_accent",
        )
    if owner_accent is not None:
        explicit.add("owner_accent")

    return PorchConfig(
        owner_room=owner_room,
        owner_room_dir=room_dir,
        mail_root=resolved_mail,
        sidecar_dir=sc_dir,
        allowed_signers=signers,
        key_file=key,
        signing_namespace=ns,
        principal=prin,
        marker=mk,
        label=lab,
        initial_channel=chan,
        owner_accent=accent,
        explicit_fields=frozenset(explicit),
    )


def parse_config_dict(
    data: Mapping[str, Any],
    *,
    env: Mapping[str, str] | None = None,
) -> PorchConfig:
    """Parse a flat TOML/dict document (deny-unknown-fields)."""
    if not isinstance(data, Mapping):
        raise ConfigError("config root must be a table")
    unknown = set(data.keys()) - _KNOWN_FIELDS
    if unknown:
        name = sorted(unknown)[0]
        raise ConfigError(f"unknown config field {name!r}", field=name)

    owner_room = _require_str(data, "owner_room")
    owner_room_dir = _abs_path(data["owner_room_dir"], field="owner_room_dir")

    kwargs: dict[str, Any] = {
        "owner_room": owner_room,
        "owner_room_dir": owner_room_dir,
        "env": env,
    }
    explicit: set[str] = {"owner_room", "owner_room_dir"}

    for key in (
        "mail_root",
        "sidecar_dir",
        "allowed_signers",
        "key_file",
        "signing_namespace",
        "principal",
        "marker",
        "label",
        "initial_channel",
        "owner_accent",
    ):
        if key in data:
            kwargs[key] = data[key]
            explicit.add(key)

    kwargs["explicit_fields"] = frozenset(explicit)
    return build_config(**kwargs)


def _lexical_abs_path(path: Path) -> Path:
    """Absolute path without following the final pathname component."""
    return Path(os.path.abspath(path))


class HeldIOError(Exception):
    """Low-level held-fd IO failure. Domain wrappers remap to ConfigError /
    InitError / SafeReadError so CLI exit contracts never see raw OSError."""


@dataclass(frozen=True)
class HeldRegular:
    """Bytes + the fstat snapshot from the same held fd (no pathname re-stat)."""

    data: bytes
    st: os.stat_result


def held_read_regular_nofollow(
    path: Path | str,
    *,
    limit: int,
    label: str = "file",
    dir_fd: int | None = None,
) -> HeldRegular:
    """Open once O_NOFOLLOW|O_NONBLOCK, require regular, read to EOF ≤ limit.

    Returns bytes together with the fstat metadata from that same fd so callers
    never re-validate mode/type via a later pathname. Never uses a pre-read
    ``st_size`` as the read length — growth after fstat is included or refused
    as over-limit. All open/fstat/read/close failures become ``HeldIOError``
    (``FileNotFoundError`` is re-raised). When ``dir_fd`` is set, ``path`` is
    opened relative to that held directory.
    """
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    if hasattr(os, "O_NONBLOCK"):
        flags |= os.O_NONBLOCK
    name: Path | str
    if dir_fd is None:
        name = path
    elif isinstance(path, Path):
        name = path.name
    else:
        name = path
    fd = -1
    pending: BaseException | None = None
    result: HeldRegular | None = None
    try:
        try:
            if dir_fd is None:
                fd = os.open(path, flags)
            else:
                fd = os.open(name, flags, dir_fd=dir_fd)
        except FileNotFoundError:
            raise
        except OSError as exc:
            raise HeldIOError(f"cannot open {label}: {exc}") from exc
        try:
            st = os.fstat(fd)
        except OSError as exc:
            raise HeldIOError(f"cannot fstat {label}: {exc}") from exc
        if not stat.S_ISREG(st.st_mode):
            raise HeldIOError(
                f"{label} must be a regular file "
                "(symlink/FIFO/directory refused)"
            )
        # Advisory only — never the read length.
        if st.st_size > limit:
            raise HeldIOError(f"{label} exceeds {limit} bytes")
        chunks: list[bytes] = []
        total = 0
        while True:
            to_read = min(65536, (limit + 1) - total)
            if to_read <= 0:
                break
            try:
                chunk = os.read(fd, to_read)
            except OSError as exc:
                raise HeldIOError(f"cannot read {label}: {exc}") from exc
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > limit:
                raise HeldIOError(f"{label} exceeds {limit} bytes")
        result = HeldRegular(data=b"".join(chunks), st=st)
    except BaseException as exc:
        pending = exc
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError as exc:
                if pending is None:
                    pending = HeldIOError(f"cannot close {label}: {exc}")
                    pending.__cause__ = exc
    if pending is not None:
        raise pending
    assert result is not None
    return result


def read_regular_nofollow(
    path: Path, *, limit: int, label: str = "file"
) -> bytes:
    """Config-boundary wrapper: held EOF read mapped to ``ConfigError``."""
    try:
        return held_read_regular_nofollow(path, limit=limit, label=label).data
    except FileNotFoundError:
        raise
    except HeldIOError as exc:
        msg = str(exc)
        if msg.startswith("cannot open"):
            raise ConfigError(
                f"{label} path {path} exists but is unreadable/non-followable: "
                f"{exc}",
                field=None,
            ) from exc
        if "regular file" in msg:
            raise ConfigError(
                f"{label} at {path} must be a regular file "
                "(symlink/FIFO/directory refused)",
                field=None,
            ) from exc
        if "exceeds" in msg:
            raise ConfigError(
                f"{label} at {path} exceeds {limit} bytes — refuse",
                field=None,
            ) from exc
        raise ConfigError(f"{label} at {path}: {exc}", field=None) from exc


def load_config_bytes(
    raw: bytes,
    *,
    env: Mapping[str, str] | None = None,
    source_path: Path | None = None,
) -> PorchConfig:
    """Parse already-held config bytes (no path reopen / follow)."""
    try:
        data = tomllib.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ConfigError("config bytes are not valid UTF-8") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"malformed TOML: {exc}") from exc
    cfg = parse_config_dict(data, env=env)
    if source_path is not None:
        # Absolute lexical path only — never path-following resolve() after
        # the held bytes are already loaded (post-read symlink swap must not
        # retarget LaunchAgent PORCH_CONFIG).
        return replace(cfg, source_path=_lexical_abs_path(source_path))
    return cfg


_MAX_CONFIG_LOAD_BYTES = 1 << 20


def load_config(
    path: Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> PorchConfig:
    """Load + validate config.toml. Missing file raises ConfigError."""
    environ = env if env is not None else os.environ
    if path is None:
        override = environ.get("PORCH_CONFIG")
        path = Path(override) if override else CONFIG_PATH
    try:
        raw = read_regular_nofollow(
            path, limit=_MAX_CONFIG_LOAD_BYTES, label="config"
        )
    except FileNotFoundError as exc:
        raise ConfigError(
            f"missing config at {path} — run `porch init`",
            field=None,
        ) from exc
    except ConfigError:
        raise

    try:
        return load_config_bytes(raw, env=environ, source_path=path)
    except ConfigError as exc:
        # Re-attach path context for file loads.
        msg = str(exc)
        if "config bytes" in msg:
            raise ConfigError(f"config at {path} is not valid UTF-8") from exc
        if msg.startswith("malformed TOML"):
            raise ConfigError(f"malformed TOML at {path}: {msg[len('malformed TOML: '):]}") from exc
        raise


def emit_toml(config: PorchConfig) -> str:
    """Standards-compliant flat-schema TOML emitter (tomllib round-trip)."""
    lines = []
    for key, value in config.as_emit_dict().items():
        lines.append(f"{key} = {_toml_string(value)}")
    return "\n".join(lines) + "\n"


def _toml_string(value: str) -> str:
    """Emit a TOML basic string with proper escapes.

    Rejects newline/control-bearing values (never emittable — validation
    already refuses them; this is a second belt).
    """
    for ch in value:
        if ord(ch) in _BIDI_AND_CONTROLS or ch in "\n\r":
            raise ConfigError(
                "cannot emit TOML string containing control/newline characters"
            )
    out = ['"']
    for ch in value:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def legacy_hardcoded_values(*, home: Path | None = None) -> dict[str, str]:
    """Compatibility values for ``porch init --from-legacy``."""
    home = home if home is not None else Path.home()
    room_dir = home / ".trey-room"
    return {
        "owner_room": "trey",  # legacy-migration
        "owner_room_dir": str(room_dir),
        "marker": "🧔",  # legacy-migration
        "label": "Trey",  # legacy-migration display label
        "initial_channel": DEFAULT_INITIAL_CHANNEL,
    }


def owner_field_mismatches(
    config: PorchConfig, post_owner: Mapping[str, Any]
) -> list[str]:
    """Compare resolved porch fields against ``post owner show`` payload.

    Every duplicated field must be *present* and equal. Missing post fields
    count as mismatches (B0 any-field rule; no skip-on-absent).
    """
    mapping = {
        "room": ("room", config.owner_room),
        "sidecar_dir": ("sidecar_dir", str(config.sidecar_dir)),
        "allowed_signers": ("allowed_signers", str(config.allowed_signers)),
        "principal": ("principal", config.principal),
        "signing_namespace": ("namespace", config.signing_namespace),
        "marker": ("marker", config.marker),
        "label": ("label", config.label),
    }
    bad: list[str] = []
    for porch_name, (post_key, expected) in mapping.items():
        if porch_name not in _OWNER_CROSSCHECK_FIELDS:
            continue
        if post_key not in post_owner or post_owner[post_key] is None:
            bad.append(f"{porch_name}: missing in post owner show")
            continue
        got = post_owner[post_key]
        if str(got) != expected:
            bad.append(f"{porch_name}: porch={expected!r} post={got!r}")
    return bad
