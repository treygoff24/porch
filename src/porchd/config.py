"""Server configuration: port, Host allow-list, derived Origin allow-list."""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from porchd.state import read_json, write_json

DEFAULT_PORT = 8765
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]")


class BaseUrlError(ValueError):
    """Operator-supplied or derived pairing base URL is not usable."""


def _is_loopback_host(host: str) -> bool:
    """True for localhost (incl. trailing-dot) and any IP that is loopback.

    Uses ``ipaddress`` so 127/8, ``::1``, and IPv4-mapped loopback forms
    (``::ffff:127.0.0.1`` / ``::ffff:7f00:1``) are refused — not just a
    string allowlist of common spellings.
    """
    name = host.rstrip(".").lower()
    if name == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped.is_loopback
    return False


def validate_https_base_url(value: str) -> str:
    """Require an absolute https:// URL with a non-loopback host, no query/fragment.

    Trailing slashes are stripped. Path must be empty or ``/``.
    Credentials, malformed ports, and whitespace/control in the authority
    are rejected. Explicit default HTTPS port ``:443`` is normalized away
    (browsers omit it from Origin/Host). Returns a normalized ``https://``
    URL (no trailing slash).
    """
    text = (value or "").strip()
    if not text:
        raise BaseUrlError("base URL is empty")
    if any(ch.isspace() or ord(ch) < 0x20 for ch in text):
        raise BaseUrlError(
            "base URL must not contain whitespace or control characters"
        )
    parsed = urlparse(text)
    if parsed.scheme != "https":
        raise BaseUrlError(
            f"base URL must be absolute https (got scheme={parsed.scheme!r})"
        )
    if not parsed.netloc:
        raise BaseUrlError("base URL must include a host")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise BaseUrlError("base URL must not include credentials")
    if any(ch.isspace() or ord(ch) < 0x20 for ch in parsed.netloc):
        raise BaseUrlError(
            "base URL authority must not contain whitespace or control characters"
        )
    try:
        port = parsed.port
    except ValueError as exc:
        raise BaseUrlError("base URL has an invalid port") from exc
    if parsed.query or parsed.fragment:
        raise BaseUrlError("base URL must not include query or fragment")
    if parsed.path not in ("", "/"):
        raise BaseUrlError("base URL must not include a path")
    host = (parsed.hostname or "").lower()
    if not host:
        raise BaseUrlError("base URL must include a host")
    if _is_loopback_host(host):
        raise BaseUrlError("base URL must not target loopback")
    # Browsers drop the default HTTPS port; keep allowlists aligned.
    if port == 443:
        port = None
    if ":" in host:
        authority = f"[{host}]" if port is None else f"[{host}]:{port}"
    else:
        authority = host if port is None else f"{host}:{port}"
    return f"https://{authority}"


def _hosts_and_origin_for_base(normalized: str) -> tuple[set[str], str]:
    """Derive Host allowlist entries and Origin from one validated base URL.

    Default HTTPS (no port after normalization) allows both ``host`` and
    ``host:443`` Host spellings; Origin is the portless form browsers send.
    """
    parsed = urlparse(normalized)
    hosts = {parsed.netloc}
    if parsed.port is None:
        hosts.add(f"{parsed.netloc}:443")
    return hosts, normalized


def config_path(root: Path) -> Path:
    return root / "config.json"


@dataclass
class Config:
    port: int = DEFAULT_PORT
    hostname: str = ""
    extra_hosts: list[str] = field(default_factory=list)
    # Operator-supplied escape hatch (persisted as "base_url" in config.json).
    base_url: str = ""

    def _validated_base(self) -> str | None:
        if not self.base_url:
            return None
        try:
            return validate_https_base_url(self.base_url)
        except BaseUrlError:
            return None

    @property
    def allowed_hosts(self) -> set[str]:
        """Exact Host header values accepted (§2). Never a suffix match."""
        hosts = {f"{h}:{self.port}" for h in LOOPBACK_HOSTS}
        hosts.update(LOOPBACK_HOSTS)
        if self.hostname:
            hosts.add(self.hostname)
            hosts.add(f"{self.hostname}:443")
        for host in self.extra_hosts:
            if host:
                hosts.add(host)
        normalized = self._validated_base()
        if normalized:
            hosts.update(_hosts_and_origin_for_base(normalized)[0])
        return hosts

    @property
    def allowed_origins(self) -> set[str]:
        origins = set()
        for host in self.allowed_hosts:
            bare = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
            if bare in LOOPBACK_HOSTS:
                origins.add(f"http://{host}")
            else:
                origins.add(
                    f"https://{host.rsplit(':', 1)[0] if host.endswith(':443') else host}"
                )
        normalized = self._validated_base()
        if normalized:
            origins.add(_hosts_and_origin_for_base(normalized)[1])
        return origins

    def derived_base_url(self) -> str:
        """Display/status URL — may be loopback when no public surface exists."""
        normalized = self._validated_base()
        if normalized:
            return normalized
        if self.hostname:
            return f"https://{self.hostname}"
        return f"http://127.0.0.1:{self.port}"

    def to_dict(self) -> dict:
        data = {
            "port": self.port,
            "hostname": self.hostname,
            "extra_hosts": self.extra_hosts,
        }
        if self.base_url:
            data["base_url"] = self.base_url
        return data


def load(root: Path) -> Config:
    data = read_json(config_path(root), {})
    if not isinstance(data, dict):
        data = {}
    port = data.get("port")
    hosts = data.get("extra_hosts")
    raw_base = data.get("base_url")
    return Config(
        port=int(port) if isinstance(port, int) else DEFAULT_PORT,
        hostname=str(data.get("hostname") or ""),
        extra_hosts=(
            [h for h in hosts if isinstance(h, str)] if isinstance(hosts, list) else []
        ),
        base_url=str(raw_base).strip() if isinstance(raw_base, str) else "",
    )


def save(root: Path, config: Config) -> None:
    write_json(config_path(root), config.to_dict())


def resolve_pairing_base_url(
    config: Config,
    *,
    serve_ok: bool | None = None,
) -> str:
    """Return a validated HTTPS base for QR pairing, or raise BaseUrlError.

    Prefer the operator ``base_url`` override. Otherwise require a Tailscale
    hostname and a confirmed Serve wiring (``serve_ok``). Never returns
    loopback http — that path minted unreachable phone QRs.
    """
    if config.base_url:
        return validate_https_base_url(config.base_url)
    if not config.hostname:
        raise BaseUrlError(
            "no pairing HTTPS base URL — Tailscale hostname unknown and "
            "no config base_url override (set via `porch-mobile setup --base-url`)"
        )
    if serve_ok is False:
        raise BaseUrlError(
            "Tailscale Serve is not wired; refusing loopback pairing QR. "
            "Fix Serve or rerun `porch-mobile setup --base-url https://<host>`"
        )
    if serve_ok is None:
        # Direct pair: probe Serve when no override is set.
        from porchd import provision

        if not provision.serve_configured(config.port):
            raise BaseUrlError(
                "Tailscale Serve is not wired; refusing loopback pairing QR. "
                "Rerun `porch-mobile setup --base-url https://<host>`"
            )
    return validate_https_base_url(f"https://{config.hostname}")
