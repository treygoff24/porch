"""The HTTP boundary: Host, Origin, cookie, CSRF, size caps, headers."""

from __future__ import annotations

import http.client
import json
import socket
import threading
import time

import pytest

from porchd import devices, server


@pytest.fixture
def live(svc):
    httpd = server.serve(svc, address=("127.0.0.1", 0))
    svc.config.port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()


class Client:
    def __init__(self, port: int):
        self.port = port
        self.cookie: str | None = None
        self.csrf: str | None = None

    def request(self, method, path, *, body=None, headers=None, host=None, origin=...,
                content_type="application/json", raw_length=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        sent = headers.copy() if headers else {}
        sent.setdefault("Host", host if host is not None else f"127.0.0.1:{self.port}")
        sent.setdefault("Connection", "close")
        if method == "POST":
            if origin is ...:
                origin = f"http://127.0.0.1:{self.port}"
            if origin is not None:
                sent.setdefault("Origin", origin)
            sent.setdefault("Content-Type", content_type)
            if self.csrf:
                sent.setdefault("X-Porch-CSRF", self.csrf)
        if self.cookie:
            sent.setdefault("Cookie", self.cookie)
        payload = body
        if isinstance(payload, (dict, list)):
            payload = json.dumps(payload).encode()
        if raw_length is not None:
            sent["Content-Length"] = str(raw_length)
        conn.request(method, path, body=payload, headers=sent)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response, data

    def json(self, *args, **kwargs):
        response, data = self.request(*args, **kwargs)
        return response, (json.loads(data) if data else {})


@pytest.fixture
def client(live, svc):
    return Client(svc.config.port)


@pytest.fixture
def paired(client, svc):
    token = devices.create_pairing_token(svc.root)
    response, payload = client.json("POST", "/api/pair", body={"one_time_token": token})
    assert response.status == 200, payload
    cookie = response.getheader("Set-Cookie")
    client.cookie = cookie.split(";")[0]
    client.csrf = payload["csrf_secret"]
    return payload


# ------------------------------------------------------------------ pairing


def test_pairing_sets_a_host_prefixed_cookie_and_a_csrf_secret(client, svc):
    token = devices.create_pairing_token(svc.root)
    response, payload = client.json("POST", "/api/pair", body={"one_time_token": token})
    cookie = response.getheader("Set-Cookie")
    assert cookie.startswith("__Host-porchd=")
    for attribute in ("Secure", "HttpOnly", "SameSite=Strict", "Path=/"):
        assert attribute in cookie
    assert payload["csrf_secret"] and payload["device_id"]


def test_a_wrong_guess_does_not_invalidate_the_pairing_token(client, svc):
    token = devices.create_pairing_token(svc.root)
    response, _ = client.json("POST", "/api/pair", body={"one_time_token": "wrong"})
    assert response.status == 403

    response, payload = client.json("POST", "/api/pair", body={"one_time_token": token})
    assert response.status == 200 and payload["ok"] is True


def test_pairing_failures_are_rate_limited(client, svc):
    devices.create_pairing_token(svc.root)
    statuses = [
        client.json("POST", "/api/pair", body={"one_time_token": "wrong"})[0].status
        for _ in range(12)
    ]
    assert 429 in statuses


def test_a_used_pairing_token_cannot_be_replayed(client, svc):
    token = devices.create_pairing_token(svc.root)
    assert client.json("POST", "/api/pair", body={"one_time_token": token})[0].status == 200
    assert client.json("POST", "/api/pair", body={"one_time_token": token})[0].status == 403


# --------------------------------------------------------------- boundaries


def test_an_unpaired_device_gets_nothing(client):
    response, payload = client.json("GET", "/api/bootstrap")
    assert response.status == 401
    assert payload["error"]["code"] == "unpaired"


def test_a_foreign_host_header_is_refused(client, paired):
    response, payload = client.json("GET", "/api/bootstrap", host="evil.example.com")
    assert response.status == 403
    assert payload["error"]["code"] == "host_refused"


def test_base_url_override_host_and_origin_pass_http_boundary(client, svc):
    """Setup-persisted --base-url Host/Origin must be allowlisted after reload.

    Mirrors setup's save-before-install: config.json is written, then the
    daemon loads that file once at start (no live reload). Mutating only the
    in-memory QR path is insufficient — prove the HTTP boundary after load.
    """
    from porchd import config as config_mod

    override = "https://escape.example.ts.net"
    saved = config_mod.Config(
        port=svc.config.port,
        hostname=svc.config.hostname,
        extra_hosts=list(svc.config.extra_hosts),
        base_url=override,
    )
    config_mod.save(svc.root, saved)
    # Daemon start path: load config.json once into the running service.
    svc.config = config_mod.load(svc.root)
    assert svc.config.base_url == override
    assert override in svc.config.allowed_origins
    assert "escape.example.ts.net" in svc.config.allowed_hosts

    # Static pairing page (pre-auth) must not 403 on the override Host.
    response, _ = client.request("GET", "/", host="escape.example.ts.net")
    assert response.status == 200

    token = devices.create_pairing_token(svc.root)
    response, payload = client.json(
        "POST",
        "/api/pair",
        body={"one_time_token": token},
        host="escape.example.ts.net",
        origin=override,
    )
    assert response.status == 200, payload
    assert payload.get("ok") is True


def test_base_url_explicit_443_accepts_both_host_spellings(client, svc):
    """Browsers may drop :443; both Host spellings must pass after normalize."""
    svc.config.base_url = "https://escape.example.ts.net:443"
    assert "https://escape.example.ts.net" in svc.config.allowed_origins
    assert "escape.example.ts.net" in svc.config.allowed_hosts
    assert "escape.example.ts.net:443" in svc.config.allowed_hosts

    for host in ("escape.example.ts.net", "escape.example.ts.net:443"):
        response, _ = client.request("GET", "/", host=host)
        assert response.status == 200, host

    token = devices.create_pairing_token(svc.root)
    response, payload = client.json(
        "POST",
        "/api/pair",
        body={"one_time_token": token},
        host="escape.example.ts.net",
        origin="https://escape.example.ts.net",
    )
    assert response.status == 200, payload
    assert payload.get("ok") is True


def test_a_mutation_without_a_matching_origin_is_refused(client, paired):
    response, payload = client.json(
        "POST", "/api/signing/lock", body={}, origin="https://evil.example.com"
    )
    assert response.status == 403 and payload["error"]["code"] == "origin_refused"

    response, payload = client.json("POST", "/api/signing/lock", body={}, origin=None)
    assert response.status == 403 and payload["error"]["code"] == "origin_refused"


def test_a_mutation_without_the_csrf_header_is_refused(client, paired):
    csrf, client.csrf = client.csrf, None
    response, payload = client.json("POST", "/api/signing/lock", body={})
    assert response.status == 403 and payload["error"]["code"] == "csrf_refused"

    client.csrf = "not-the-secret"
    response, payload = client.json("POST", "/api/signing/lock", body={})
    assert response.status == 403 and payload["error"]["code"] == "csrf_refused"

    client.csrf = csrf
    assert client.json("POST", "/api/signing/lock", body={})[0].status == 200


def test_a_revoked_device_is_refused_at_the_next_request(client, paired, svc):
    assert client.json("GET", "/api/bootstrap")[0].status == 200
    devices.revoke(svc.root, "phone")
    assert client.json("GET", "/api/bootstrap")[0].status == 401


# ------------------------------------------------------------- size limits


def test_a_non_send_body_over_the_json_cap_is_refused_before_it_is_read(
    client, paired
):
    oversize = b"x" * (server.MAX_JSON_BODY + 1)
    response, payload = client.request(
        "POST", "/api/channels/commons/ack", body=oversize
    )
    assert response.status == 413
    assert json.loads(payload)["error"]["code"] == "too_large"


def test_send_accepts_worst_case_json_for_a_valid_one_mib_body(client, paired):
    draft = "\x00" * 1_048_576
    body = json.dumps(
        {"attempt_id": "big", "draft_text": draft, "intent": "signed"}
    ).encode()
    assert server.MAX_JSON_BODY < len(body) <= server.MAX_SEND_JSON_BODY
    response, _ = client.request("POST", "/api/channels/commons/send", body=body)
    assert response.status in (200, 409)  # accepted by the boundary, not refused


def test_send_over_its_json_cap_is_refused_before_read(client, paired):
    status, payload = _headers_only(
        client,
        "/api/channels/commons/send",
        [
            "Content-Type: application/json",
            f"Content-Length: {server.MAX_SEND_JSON_BODY + 1}",
        ],
    )
    assert status == 413 and payload["error"]["code"] == "too_large"


def _headers_only(client, path, extra_headers):
    """Send only the request head — never the body — and read the reply.

    The refusal has to arrive without the body ever being sent, which is
    exactly the property §2 asks for ("refused before the body is read").
    """
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    head = [
        f"POST {path} HTTP/1.1",
        f"Host: 127.0.0.1:{client.port}",
        f"Origin: http://127.0.0.1:{client.port}",
        f"Cookie: {client.cookie}",
        f"X-Porch-CSRF: {client.csrf}",
        "Connection: close",
        *extra_headers,
        "",
        "",
    ]
    sock.sendall("\r\n".join(head).encode())
    chunks = []
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
    sock.close()
    raw = b"".join(chunks)
    status = int(raw.split(b" ")[1])
    body = raw.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in raw else b"{}"
    return status, json.loads(body or b"{}")


def test_a_chunked_body_is_refused(client, paired):
    status, payload = _headers_only(
        client, "/api/signing/lock",
        ["Content-Type: application/json", "Transfer-Encoding: chunked"],
    )
    assert status == 411 and payload["error"]["code"] == "length_required"


def test_a_missing_content_length_is_refused(client, paired):
    status, payload = _headers_only(
        client, "/api/channels/commons/ack", ["Content-Type: application/json"]
    )
    assert status == 411 and payload["error"]["code"] == "length_required"


def test_an_oversize_upload_is_refused_before_the_body_is_read(client, paired):
    status, payload = _headers_only(
        client, "/api/images",
        ["Content-Type: image/png",
         f"Content-Length: {server.MAX_UPLOAD_BODY + 1}"],
    )
    assert status == 413 and payload["error"]["code"] == "too_large"


def test_an_upload_at_the_cap_passes_the_boundary(client, paired):
    response, payload = client.request(
        "POST", "/api/images", body=b"\x00" * 4096, content_type="image/png"
    )
    # Refused by image validation, not by the size boundary.
    assert response.status == 400
    assert json.loads(payload)["error"]["code"] == "invalid_image"


# -------------------------------------------------------------- keep-alive


def _read_http_response(sock, leftover=b""):
    """Read one HTTP/1.1 response from a raw socket, preserving pipelined bytes."""
    data = leftover
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(65536)
        if not chunk:
            raise AssertionError(f"connection closed while reading headers: {data[:300]!r}")
        data += chunk
    head, rest = data.split(b"\r\n\r\n", 1)
    status_line, *header_lines = head.split(b"\r\n")
    status = int(status_line.split()[1])
    headers = {}
    for line in header_lines:
        name, _, value = line.partition(b":")
        headers[name.strip().lower()] = value.strip()
    length = int(headers.get(b"content-length", b"0"))
    while len(rest) < length:
        chunk = sock.recv(65536)
        if not chunk:
            break
        rest += chunk
    return status, headers, rest[:length], rest[length:]


def _rejected_post(client, body, *, content_length=None):
    """POST to a send route that refuses before reading the body (no cookie)."""
    payload = body if isinstance(body, bytes) else body.encode()
    length = len(payload) if content_length is None else content_length
    return (
        f"POST /api/channels/commons/send HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{client.port}\r\n"
        f"Origin: http://127.0.0.1:{client.port}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {length}\r\n"
        f"\r\n"
    ).encode() + payload


def _get_root(client, *, connection="close"):
    return (
        f"GET / HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{client.port}\r\n"
        f"Connection: {connection}\r\n"
        f"\r\n"
    ).encode()


def test_a_rejected_post_does_not_poison_the_next_request_on_the_connection(client):
    """A pre-read rejection must not leave the JSON body as the next request line."""
    body = b'{"through_id":"msg-1","delivery_token":"stale"}'
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(_rejected_post(client, body) + _get_root(client))
        status1, _, _, leftover = _read_http_response(sock)
        assert status1 in (401, 403)
        status2, _, body2, _ = _read_http_response(sock, leftover)
        assert status2 == 200
        assert status2 != 501
        assert b"Unsupported method" not in body2
    finally:
        sock.close()


def test_an_unread_body_over_the_drain_cap_closes_the_connection(client):
    """Leftover bytes over the drain cap must close, not be parsed as a method."""
    body = b"x" * (server.BODY_DRAIN_CAP + 1)
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(_rejected_post(client, body))
        status, headers, _, leftover = _read_http_response(sock)
        assert status in (401, 403, 413)
        assert headers.get(b"connection", b"").lower() == b"close"
        rest = leftover
        if not rest:
            rest = sock.recv(16)
        assert rest == b""
    finally:
        sock.close()


def test_keep_alive_survives_a_small_rejected_post(client):
    """A drained rejection leaves the connection reusable for the next request."""
    body = b'{"through_id":"msg-1","delivery_token":"stale"}'
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(_rejected_post(client, body))
        status1, headers1, _, leftover = _read_http_response(sock)
        assert status1 in (401, 403)
        assert headers1.get(b"connection", b"").lower() != b"close"
        sock.sendall(leftover + _get_root(client))
        status2, _, body2, _ = _read_http_response(sock)
        assert status2 == 200
        assert b"Unsupported method" not in body2
    finally:
        sock.close()


def _raw_rejected_post(client, body, headers):
    lines = [
        f"POST /api/channels/commons/send HTTP/1.1",
        f"Host: 127.0.0.1:{client.port}",
        f"Origin: http://127.0.0.1:{client.port}",
        "Content-Type: application/json",
        *headers,
        "",
        "",
    ]
    return "\r\n".join(lines).encode() + body


def _assert_closed_not_poisoned(sock, client, *, statuses=(400, 401, 403)):
    """The response must carry Connection: close and the socket must die clean."""
    sock.sendall(_get_root(client))  # would be misparsed if leftovers poisoned
    status, headers, _, leftover = _read_http_response(sock)
    assert status in statuses
    assert headers.get(b"connection", b"").lower() == b"close"
    rest = leftover
    if not rest:
        rest = sock.recv(16)
    assert rest == b""


def test_conflicting_content_length_headers_close_the_connection(client):
    """Two disagreeing Content-Length values make any drain length a lie."""
    body = b'{"a":1}'
    request = _raw_rejected_post(
        client, body, ["Content-Length: 1", f"Content-Length: {len(body)}"]
    )
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(request)
        _assert_closed_not_poisoned(sock, client)
    finally:
        sock.close()


def test_a_lexically_loose_content_length_closes_the_connection(client):
    """int() accepts "-0" as zero; a strict parser must refuse and close."""
    body = b'{"a":1}'
    request = _raw_rejected_post(client, body, ["Content-Length: -0"])
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(request)
        _assert_closed_not_poisoned(sock, client)
    finally:
        sock.close()


def test_a_client_that_asked_to_close_is_not_drained(client):
    """Connection: close on the request skips the drain and hangs up clean."""
    body = b'{"through_id":"msg-1"}'
    request = _raw_rejected_post(
        client, body, [f"Content-Length: {len(body)}", "Connection: close"]
    )
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(request)
        _assert_closed_not_poisoned(sock, client, statuses=(401, 403))
    finally:
        sock.close()


def test_a_huge_digit_content_length_is_refused_not_crashed(client):
    """4301+ digits pass isdigit() but blow int()'s conversion limit → must close."""
    request = _raw_rejected_post(client, b"", ["Content-Length: " + "9" * 5000])
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(request)
        _assert_closed_not_poisoned(sock, client, statuses=(400, 401, 403))
    finally:
        sock.close()


def test_a_drip_fed_body_cannot_outlive_the_drain_deadline(client, monkeypatch):
    """One byte per interval must not extend the drain past its total budget."""
    monkeypatch.setattr(server, "DRAIN_TOTAL_DEADLINE_S", 0.5)
    request = _raw_rejected_post(client, b"", ["Content-Length: 4096"])
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(request)
        sock.settimeout(0.05)
        start = time.monotonic()
        data = b""
        while b"\r\n\r\n" not in data and time.monotonic() - start < 4:
            try:
                sock.sendall(b"x")  # keep dripping: each byte resets a naive per-read timeout
            except OSError:
                pass
            try:
                chunk = sock.recv(65536)
                if chunk:
                    data += chunk
            except TimeoutError:
                pass
            time.sleep(0.1)
        elapsed = time.monotonic() - start
        assert b"\r\n\r\n" in data, "server never responded while being drip-fed"
        assert elapsed < 3, f"drain outlived its deadline: {elapsed:.1f}s"
        assert int(data.split()[1]) in (401, 403)
        assert b"connection: close" in data.lower()
    finally:
        sock.close()


def test_a_truncated_body_never_reaches_route_logic(client, svc):
    """A short body must 400 before the route can act on a partial payload."""
    token = devices.create_pairing_token(svc.root)
    payload = json.dumps({"one_time_token": token}).encode()
    request = (
        f"POST /api/pair HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{client.port}\r\n"
        f"Origin: http://127.0.0.1:{client.port}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(payload) + 5}\r\n"
        f"\r\n"
    ).encode() + payload
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    try:
        sock.sendall(request)
        sock.shutdown(socket.SHUT_WR)  # the missing 5 bytes never arrive
        status, headers, body, _ = _read_http_response(sock)
        assert status == 400
        assert json.loads(body)["error"]["message"] == "request body was truncated"
        assert headers.get(b"connection", b"").lower() == b"close"
    finally:
        sock.close()
    # The complete-but-truncated-payload pairing must not have consumed the token.
    replay = http.client.HTTPConnection("127.0.0.1", client.port, timeout=10)
    try:
        replay.request(
            "POST",
            "/api/pair",
            body=json.dumps({"one_time_token": token}),
            headers={
                "Origin": f"http://127.0.0.1:{client.port}",
                "Content-Type": "application/json",
            },
        )
        response = replay.getresponse()
        response.read()  # drain before close so the server sees a clean FIN
        assert response.status == 200
    finally:
        replay.close()


# ------------------------------------------------------------------ headers


def test_every_response_carries_the_tripwire_headers(client, paired):
    response, _ = client.request("GET", "/api/bootstrap")
    assert response.getheader("Content-Security-Policy") == server.CSP
    assert "frame-ancestors 'none'" in response.getheader("Content-Security-Policy")
    assert response.getheader("X-Content-Type-Options") == "nosniff"
    assert response.getheader("Referrer-Policy") == "no-referrer"
    assert response.getheader("Cache-Control") == "no-store"


def test_error_responses_carry_them_too(client):
    response, _ = client.request("GET", "/api/bootstrap")
    assert response.status == 401
    assert response.getheader("Content-Security-Policy") == server.CSP
    assert response.getheader("X-Content-Type-Options") == "nosniff"


# ------------------------------------------------------------------ routing


def test_bootstrap_lists_channels_with_liveness(client, paired):
    response, payload = client.json("GET", "/api/bootstrap")
    assert response.status == 200
    names = [c["name"] for c in payload["channels"]]
    assert names == ["backporch", "commons"]
    assert payload["channels"][0]["live"] is True  # finch has a live watch
    assert payload["signing"]["armed"] is False


def test_bootstrap_reflects_a_custom_owner_accent(client, paired, svc):
    """Item 20: the mobile bootstrap payload must carry a configured
    owner_accent end-to-end (JS sets --owner-accent from this field, and
    colorFor() falls back to it for the owner's own sender)."""
    from dataclasses import replace

    svc.porch_config = replace(svc.porch_config, owner_accent="#112233")
    response, payload = client.json("GET", "/api/bootstrap")
    assert response.status == 200
    assert payload["owner_accent"] == "#112233"
    assert payload["colors"][svc.porch_config.owner_room] == "#112233"


def test_messages_carry_a_delivery_token(client, paired, add_msg):
    add_msg("commons", 1, "finch", "hello")
    response, payload = client.json("GET", "/api/channels/commons/messages")
    assert response.status == 200
    assert payload["messages"][0]["body"] == "hello"
    assert payload["delivery_token"]


def test_an_unknown_channel_is_a_404(client, paired):
    response, payload = client.json("GET", "/api/channels/nope/messages")
    assert response.status == 404 and payload["error"]["code"] == "no_such_channel"


def test_an_unknown_endpoint_is_a_404(client, paired):
    response, payload = client.json("GET", "/api/nope")
    assert response.status == 404


def test_static_assets_are_served_and_traversal_is_refused(client):
    response, body = client.request("GET", "/")
    assert response.status == 200
    assert response.getheader("Content-Type").startswith("text/html")

    response, _ = client.request("GET", "/../../pyproject.toml")
    assert response.status in (400, 404)


def test_the_transcript_downloads_rather_than_rendering(client, paired, add_msg):
    add_msg("commons", 1, "finch", "hello there")
    response, body = client.request("GET", "/api/channels/commons/transcript")
    assert response.status == 200
    disposition = response.getheader("Content-Disposition")
    assert disposition.startswith('attachment; filename="porch-commons-')
    assert disposition.endswith('.txt"')
    assert b"hello there" in body


# ------------------------------------------------------------- concurrency


def _open_blocked_get(client, path="/api/bootstrap"):
    """Start a request and leave it in flight, holding its slot."""
    sock = socket.create_connection(("127.0.0.1", client.port), timeout=10)
    sock.sendall((
        f"GET {path} HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{client.port}\r\n"
        f"Cookie: {client.cookie}\r\n"
        "Connection: close\r\n\r\n"
    ).encode())
    return sock


def _drain(sock):
    chunks = []
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
    sock.close()
    raw = b"".join(chunks)
    status = int(raw.split(b" ")[1])
    body = raw.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in raw else b"{}"
    return status, json.loads(body or b"{}")


def test_simultaneous_connections_are_capped_and_the_cap_releases(svc, monkeypatch):
    """A thread per connection is unbounded, and it exists before auth runs."""
    entered = threading.Semaphore(0)
    finish = threading.Event()
    real_bootstrap = svc.bootstrap

    def _slow(device):
        entered.release()
        finish.wait(10)
        return real_bootstrap(device)

    monkeypatch.setattr(svc, "bootstrap", _slow)

    httpd = server.serve(svc, address=("127.0.0.1", 0), max_active=2)
    svc.config.port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        client = Client(svc.config.port)
        token = devices.create_pairing_token(svc.root)
        response, payload = client.json("POST", "/api/pair", body={"one_time_token": token})
        client.cookie = response.getheader("Set-Cookie").split(";")[0]
        client.csrf = payload["csrf_secret"]

        held = [_open_blocked_get(client), _open_blocked_get(client)]
        assert entered.acquire(timeout=5) and entered.acquire(timeout=5)

        # Both slots are occupied: the next connection is refused outright,
        # without a third thread ever being created.
        status, refused = _drain(_open_blocked_get(client))
        assert status == 503
        assert refused["error"]["code"] == "server_busy"
        assert httpd.refused_overload == 1

        finish.set()
        for sock in held:
            assert _drain(sock)[0] == 200

        # …and the slots come back, so the cap is a ceiling, not a ratchet.
        for _ in range(20):
            if client.request("GET", "/api/bootstrap")[0].status == 200:
                break
            time.sleep(0.05)
        else:
            raise AssertionError("slots were never released")
    finally:
        finish.set()
        httpd.shutdown()
        httpd.server_close()


def test_owner_message_payload_color_is_owner_accent(client, paired, svc, add_msg):
    """Item 5: msg.color must be owner_accent — client colorFor prioritizes it."""
    from dataclasses import replace

    accent = "#112233"
    svc.porch_config = replace(svc.porch_config, owner_accent=accent)
    add_msg("commons", 1, svc.porch_config.owner_room, "owner says hi")
    add_msg("commons", 2, "finch", "other says hi")
    response, payload = client.json("GET", "/api/channels/commons/messages")
    assert response.status == 200
    by_from = {m["from"]: m for m in payload["messages"]}
    assert by_from[svc.porch_config.owner_room]["color"] == accent
    assert by_from["finch"]["color"] != accent
