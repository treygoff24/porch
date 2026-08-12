"""HTTP layer: loopback-only stdlib server with the §2 boundary checks.

Nothing here decides policy. Its whole job is to establish *who* is asking
(paired device cookie + per-device CSRF header), to bound *how much* they
may say (Content-Length caps and a read timeout), and to make sure the
answer carries the tripwire headers.
"""

from __future__ import annotations

import json
import re
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from porch3.constants import IMAGE_MAX_BYTES
from porchd import devices, imagesvc
from porchd.service import ApiError, Service

COOKIE_NAME = "__Host-porchd"
CSRF_HEADER = "X-Porch-CSRF"
MAX_JSON_BODY = 64 * 1024
MAX_UPLOAD_BODY = IMAGE_MAX_BYTES + 4096
REQUEST_TIMEOUT_S = 20.0
# Simultaneous connections. One phone polling three endpoints needs a
# handful; the rest of the ceiling is headroom, not capacity planning.
MAX_ACTIVE_REQUESTS = 32

CSP = (
    "default-src 'self'; object-src 'none'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:; connect-src 'self'"
)

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

CHANNEL_RE = r"(?P<channel>[^/]+)"


def _download_name(channel: str) -> str:
    """A filename safe to put inside a quoted header value."""
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", channel)[:64] or "channel"
    return f"porch-{safe}-{time.strftime('%Y%m%d-%H%M%S')}.txt"


class RateLimiter:
    """Failure-only bucket: pairing guesses are limited, never the token."""

    def __init__(self, *, limit: int = 10, window_s: float = 60.0):
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, *, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if now - t < self.window_s]
            self._hits[key] = hits
            return len(hits) < self.limit

    def record_failure(self, key: str, *, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            self._hits.setdefault(key, []).append(now)


class PorchdServer(ThreadingHTTPServer):
    """Loopback HTTP with a hard ceiling on simultaneous connections.

    ThreadingHTTPServer spawns one thread per connection with no bound. The
    read timeout and Content-Length caps limit how long and how large any
    single request may be, but not how many may exist at once — and the
    thread is created *before* authentication runs, so an unauthenticated
    tailnet peer could otherwise multiply threads in a daemon that is meant
    to sit running unattended for weeks.
    """

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, service: Service, *, address: tuple[str, int] | None = None,
                 max_active: int | None = None):
        self.service = service
        self.limiter = RateLimiter()
        self.max_active = MAX_ACTIVE_REQUESTS if max_active is None else max_active
        self._slots = threading.BoundedSemaphore(self.max_active)
        self.refused_overload = 0
        host = "127.0.0.1"
        port = service.config.port
        super().__init__(address or (host, port), Handler)

    def process_request(self, request, client_address):
        # Acquire BEFORE the thread exists — that is the whole point.
        if not self._slots.acquire(blocking=False):
            self.refused_overload += 1
            self._refuse_overload(request)
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def _refuse_overload(self, request) -> None:
        body = json.dumps(
            {"ok": False, "error": {"code": "server_busy",
                                    "message": "the porch is busy — try again in a moment"}}
        ).encode()
        head = (
            "HTTP/1.1 503 Service Unavailable\r\n"
            "Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Cache-Control: no-store\r\n"
            "X-Content-Type-Options: nosniff\r\n"
            "Referrer-Policy: no-referrer\r\n"
            "Retry-After: 1\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
        try:
            request.sendall(head + body)
            # Closing a socket that still holds unread request bytes sends an
            # RST, and the peer loses the 503 it was just handed. A bounded
            # drain lets the close be a clean FIN instead.
            request.settimeout(0.5)
            for _ in range(4):
                if not request.recv(4096):
                    break
        except OSError:
            pass  # the peer hung up first; the close below is all that is left


class Handler(BaseHTTPRequestHandler):
    server_version = "porchd"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = REQUEST_TIMEOUT_S  # StreamRequestHandler applies this to the socket

    # ---- plumbing -------------------------------------------------------

    @property
    def service(self) -> Service:
        return self.server.service

    def log_message(self, fmt, *args):  # keep the daemon quiet
        pass

    def _send(self, status: int, body: bytes, content_type: str, *, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict, *, extra: dict | None = None):
        headers = {"Cache-Control": "no-store", **(extra or {})}
        self._send(status, json.dumps(payload).encode(), "application/json", extra=headers)

    def _error(self, status: int, code: str, message: str, **extra):
        self._json(status, {"ok": False, "error": {"code": code, "message": message, **extra}})

    # ---- boundary checks -------------------------------------------------

    def _host_ok(self) -> bool:
        host = self.headers.get("Host") or ""
        return host in self.service.config.allowed_hosts

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return False
        return origin in self.service.config.allowed_origins

    def _cookie_secret(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            jar = SimpleCookie()
            jar.load(raw)
        except Exception:
            return None
        morsel = jar.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def _device(self) -> str | None:
        return devices.authenticate(self.service.root, self._cookie_secret())

    def _read_body(self, cap: int) -> bytes | None:
        if self.headers.get("Transfer-Encoding"):
            self._error(411, "length_required", "chunked bodies are not accepted")
            return None
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._error(411, "length_required", "Content-Length is required")
            return None
        try:
            length = int(raw_length)
        except ValueError:
            self._error(400, "bad_request", "malformed Content-Length")
            return None
        if length < 0:
            self._error(400, "bad_request", "malformed Content-Length")
            return None
        if length > cap:
            # Refused before a single body byte is read (§2).
            self._error(413, "too_large", f"request body over the {cap} byte cap")
            return None
        return self.rfile.read(length)

    def _json_body(self, cap: int = MAX_JSON_BODY) -> dict | None:
        raw = self._read_body(cap)
        if raw is None:
            return None
        try:
            data = json.loads(raw or b"{}")
        except ValueError:
            self._error(400, "bad_request", "malformed JSON")
            return None
        if not isinstance(data, dict):
            self._error(400, "bad_request", "expected a JSON object")
            return None
        return data

    # ---- routing ---------------------------------------------------------

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method: str):
        if not self._host_ok():
            self._error(403, "host_refused", "unexpected Host header")
            return
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        if not path.startswith("/api/"):
            if method != "GET":
                self._error(405, "method_not_allowed", "method not allowed")
                return
            self._serve_static(path)
            return

        if method == "POST":
            if not self._origin_ok():
                self._error(403, "origin_refused", "cross-site request refused")
                return
            if self.headers.get("Transfer-Encoding"):
                # Every cap here is a Content-Length cap; chunked would let a
                # body arrive unbounded, so porchd never accepts one.
                self._error(411, "length_required", "chunked bodies are not accepted")
                return

        try:
            self._route(method, path, query)
        except ApiError as exc:
            self._json(exc.status, exc.payload())
        except Exception:
            self._error(500, "internal_error", "the server could not complete that")

    def _route(self, method: str, path: str, query: dict):
        if path == "/api/pair" and method == "POST":
            self._pair()
            return

        device = self._device()
        if device is None:
            self._error(401, "unpaired", "this device is not paired")
            return
        if method == "POST" and not devices.check_csrf(
            self.service.root, device, self.headers.get(CSRF_HEADER)
        ):
            self._error(403, "csrf_refused", "missing or wrong CSRF token")
            return
        devices.touch(self.service.root, device)
        self.service.note_activity()

        if path == "/api/bootstrap" and method == "GET":
            self._json(200, self.service.bootstrap(device))
            return
        if path == "/api/signing" and method == "GET":
            self._json(200, self.service.signing())
            return
        if path == "/api/signing/lock" and method == "POST":
            self._json(200, self.service.signing_lock())
            return
        if path == "/api/dr" and method == "GET":
            self._json(200, self.service.dr())
            return
        if path == "/api/images" and method == "POST":
            self._upload(device)
            return

        match = re.fullmatch(r"/api/images/(?P<grant>[^/]+)", path)
        if match and method == "GET":
            body = self.service.image_bytes(device, match.group("grant"))
            self._send(200, body, imagesvc.THUMBNAIL_CONTENT_TYPE,
                       extra={"Cache-Control": "no-store"})
            return

        match = re.fullmatch(
            r"/api/messages/(?P<mid>[^/]+)/images/(?P<index>\d+)/reveal", path
        )
        if match and method == "POST":
            if self._json_body() is None:
                return
            self._json(200, self.service.reveal_image(
                device, match.group("mid"), int(match.group("index"))))
            return

        match = re.fullmatch(rf"/api/channels/{CHANNEL_RE}/messages", path)
        if match and method == "GET":
            after = (query.get("after") or [None])[0]
            limit = (query.get("limit") or [None])[0]
            self._json(200, self.service.messages_page(
                device, match.group("channel"), after,
                int(limit) if limit and limit.isdigit() else None))
            return

        match = re.fullmatch(rf"/api/channels/{CHANNEL_RE}/transcript", path)
        if match and method == "GET":
            channel = match.group("channel")
            text = self.service.transcript(channel)
            # A plain navigation, so without this Safari renders the
            # transcript as a page instead of saving it.
            filename = _download_name(channel)
            self._send(200, text.encode(), "text/plain; charset=utf-8",
                       extra={"Cache-Control": "no-store",
                              "Content-Disposition": f'attachment; filename="{filename}"'})
            return

        match = re.fullmatch(rf"/api/channels/{CHANNEL_RE}/seen/(?P<mid>[^/]+)", path)
        if match and method == "GET":
            self._json(200, self.service.seen(match.group("channel"), match.group("mid")))
            return

        match = re.fullmatch(rf"/api/channels/{CHANNEL_RE}/ack", path)
        if match and method == "POST":
            body = self._json_body()
            if body is None:
                return
            self._json(200, self.service.ack(
                device, match.group("channel"), body.get("through_id"),
                body.get("delivery_token") or ""))
            return

        match = re.fullmatch(rf"/api/channels/{CHANNEL_RE}/send", path)
        if match and method == "POST":
            body = self._json_body()
            if body is None:
                return
            result = self.service.send(device, match.group("channel"), body)
            self._json(200 if result.get("ok") else 409, result)
            return

        match = re.fullmatch(rf"/api/channels/{CHANNEL_RE}/confirm", path)
        if match and method == "POST":
            body = self._json_body()
            if body is None:
                return
            result = self.service.confirm(device, match.group("channel"), body)
            self._json(200 if result.get("ok") else 409, result)
            return

        match = re.fullmatch(rf"/api/channels/{CHANNEL_RE}/dismiss", path)
        if match and method == "POST":
            body = self._json_body()
            if body is None:
                return
            self._json(200, self.service.dismiss(device, match.group("channel"), body))
            return

        self._error(404, "no_such_endpoint", "no such endpoint")

    # ---- individual handlers ---------------------------------------------

    def _pair(self):
        peer = self.client_address[0] if self.client_address else "?"
        if not self.server.limiter.allow(peer):
            self._error(429, "rate_limited", "too many pairing attempts — wait a minute")
            return
        body = self._json_body(4096)
        if body is None:
            return
        token = body.get("one_time_token")
        label = body.get("label")
        result = devices.consume_pairing_token(
            self.service.root, token if isinstance(token, str) else "",
            label=label if isinstance(label, str) and label else "phone",
        )
        if result is None:
            # A wrong guess never invalidates the token; it costs a bucket slot.
            self.server.limiter.record_failure(peer)
            self._error(403, "pairing_refused", "that pairing link is not valid")
            return
        device_id, secret, csrf = result
        cookie = (
            f"{COOKIE_NAME}={secret}; Secure; HttpOnly; SameSite=Strict; Path=/"
        )
        self._json(
            200,
            {"ok": True, "device_id": device_id, "csrf_secret": csrf},
            extra={"Set-Cookie": cookie},
        )

    def _upload(self, device: str):
        raw = self._read_body(MAX_UPLOAD_BODY)
        if raw is None:
            return
        content_type = self.headers.get("Content-Type") or ""
        self._json(200, self.service.upload_image(device, raw, content_type))

    def _serve_static(self, path: str):
        relative = path.lstrip("/") or "index.html"
        candidate = (STATIC_DIR / relative)
        try:
            resolved = candidate.resolve()
            base = STATIC_DIR.resolve()
        except OSError:
            self._error(404, "not_found", "not found")
            return
        try:
            inside = resolved == base or resolved.is_relative_to(base)
        except AttributeError:  # pragma: no cover
            inside = str(resolved).startswith(str(base))
        if not inside or not resolved.is_file():
            self._error(404, "not_found", "not found")
            return
        content_type = STATIC_TYPES.get(resolved.suffix.lower(), "application/octet-stream")
        try:
            body = resolved.read_bytes()
        except OSError:
            self._error(404, "not_found", "not found")
            return
        self._send(200, body, content_type, extra={"Cache-Control": "no-cache"})


def serve(service: Service, *, address: tuple[str, int] | None = None,
          max_active: int | None = None) -> PorchdServer:
    return PorchdServer(service, address=address, max_active=max_active)
