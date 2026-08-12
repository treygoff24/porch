"""The dev-fixture gate: `?dev=1` must never reach fixtures in production.

Two independent controls, tested separately because either one alone would
be enough to lose:

1. The fixtures do not ship inside `static/`, so porchd has no route to them.
   This is the real control and it is asserted against the live daemon.
2. `resolveDevMode()` in the client refuses to activate when anything smells
   like production — a daemon answering `/api`, a paired session in this
   browser, or fixtures that will not load.

The client half runs the actual `static/app.js` under node's `vm` with a
stubbed DOM, so these assert behavior rather than the shape of the source.
The regression that matters most is `test_query_flag_alone_never_activates`:
activation off the query parameter alone is exactly the bug that was fixed,
and it would come back silently.
"""

from __future__ import annotations

import http.client
import json
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

from porchd import server

REPO = Path(__file__).resolve().parents[1]
STATIC_DIR = REPO / "src" / "porchd" / "static"
APP_JS = STATIC_DIR / "app.js"
FIXTURES = REPO / "src" / "porchd" / "devfixtures" / "dev-fixtures.json"

NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node is not installed")


# --------------------------------------------------------------- the daemon


@pytest.fixture
def live(svc):
    httpd = server.serve(svc, address=("127.0.0.1", 0))
    svc.config.port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield httpd
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def get(live, svc):
    """Unauthenticated GET — static assets are public by necessity."""

    def _get(path: str):
        conn = http.client.HTTPConnection("127.0.0.1", svc.config.port, timeout=10)
        conn.request("GET", path, headers={
            "Host": f"127.0.0.1:{svc.config.port}", "Connection": "close",
        })
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, body

    return _get


def test_fixtures_live_outside_the_shipped_static_tree():
    assert FIXTURES.is_file(), "the dev harness needs its fixtures somewhere"
    strays = [p for p in STATIC_DIR.rglob("*") if "dev-fixtures" in p.name]
    assert strays == [], f"fixtures must not ship inside static/: {strays}"


@pytest.mark.parametrize("path", [
    "/dev-fixtures.json",
    "/devfixtures/dev-fixtures.json",
    "/../devfixtures/dev-fixtures.json",
    "/static/../devfixtures/dev-fixtures.json",
    "/..%2fdevfixtures%2fdev-fixtures.json",
])
def test_daemon_serves_no_fixture_file(get, path):
    status, _ = get(path)
    assert status == 404, f"{path} must not be reachable from the daemon"


def test_daemon_does_serve_the_app_itself(get):
    """Positive control: the 404s above are not a broken static handler."""
    status, body = get("/app.js")
    assert status == 200 and b"resolveDevMode" in body


# --------------------------------------------------------------- the client

HARNESS = r"""
/* Runs the real static/app.js under node's vm with a stubbed DOM, so the
   client-side gates can be asserted without a browser. */
import fs from 'node:fs';
import vm from 'node:vm';

const [appPath, scenarioJson] = process.argv.slice(2);
const scenario = JSON.parse(scenarioJson);

// A universal DOM stand-in: every unknown property yields a callable that
// returns another stub. Enough for wire() and the render paths to run.
const elements = new Map();
function makeElement(name) {
  const base = {
    tagName: name, className: '', textContent: '', value: '', hidden: false,
    disabled: false, style: {}, dataset: {}, files: [], firstChild: null,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => makeElement('anon');
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}
function byId(id) {
  if (!elements.has(id)) elements.set(id, makeElement(id));
  return elements.get(id);
}

const store = new Map(Object.entries(scenario.localStorage || {}));
const calls = [];

const sandbox = {
  console: { warn: (m) => calls.push({ warn: String(m) }), error() {}, log() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  URLSearchParams, Promise, JSON, Math, Date, Set, Map, Array, Object,
  String, Number, Error, RegExp, Boolean,
  location: { search: scenario.search || '', hash: '', pathname: '/index.html', href: '/' },
  history: { replaceState() {} },
  navigator: { clipboard: { writeText: async () => {} } },
  crypto: { randomUUID: () => 'uuid-' + Math.random(), getRandomValues: (a) => a },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  },
  document: {
    getElementById: byId,
    createElement: (t) => makeElement(t),
    createTextNode: () => makeElement('#text'),
    querySelectorAll: () => [],
    addEventListener() {},
    body: makeElement('body'),
    visibilityState: 'visible',
    title: '',
  },
  fetch: async (url) => {
    calls.push({ fetch: String(url) });
    const rule = (scenario.routes || []).find((r) => String(url).includes(r.match));
    const status = rule ? rule.status : 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => (rule && rule.body !== undefined ? rule.body : { ok: false }),
    };
  },
  addEventListener() {},
  innerHeight: 800,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(appPath, 'utf8'), ctx, { filename: 'app.js' });

const run = (src) => vm.runInContext(src, ctx);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function report(extra) {
  process.stdout.write(JSON.stringify(Object.assign({
    devMode: run('devMode'),
    devRequested: run('DEV_REQUESTED'),
    warnings: calls.filter((c) => c.warn).map((c) => c.warn),
  }, extra || {})));
  // The client's own poll timers would otherwise hold the loop open forever.
  process.exit(0);
}

/* A send from channel A must clear A's draft even when the reply lands after
   Mara has navigated to B. */
async function draftScope() {
  await sleep(220);
  if (!run('devMode')) return report({ error: 'fixtures did not activate' });

  run("var __api = api; api = function (p, o) { return __api(p, o).then(function (x) {"
      + " if (String(p).indexOf('/send') === -1) { return x; }"
      + " return new Promise(function (f) { setTimeout(function () { f(x); }, 400); }); }); };");

  await run("openChannel('commons')");
  run("document.getElementById('draft').value = 'COMMONS DRAFT'; onDraftEdited();");
  run('doSend();');                          // deliberately not awaited
  await sleep(60);
  await run("openChannel('study')");
  run("document.getElementById('draft').value = 'STUDY DRAFT'; onDraftEdited();");
  await sleep(800);                          // commons' reply lands while study is up

  return report({
    onScreen: run('S.channel'),
    visibleComposer: run("document.getElementById('draft').value"),
    commonsStored: run("localStorage.getItem('porch.draft.commons')"),
    studyStored: run("localStorage.getItem('porch.draft.study')"),
  });
}

if (scenario.mode === 'draftscope') draftScope();
else setTimeout(() => report(), 150);
"""


def _message(index: int) -> dict:
    return {
        "id": f"2025011{index}-00000{index}-x", "from": "finch", "sender_label": "finch",
        "color": "#ffffff", "time": f"09:0{index}", "day": "2025-01-11",
        "day_separator": index == 1, "event": None, "body": "hi", "mentions": [],
        "mentions_owner": False, "verify": "", "dr": "", "reply": None,
        "images": [], "own": False,
    }


def _fixture_body() -> dict:
    """The smallest fixture corpus the client will boot against."""
    channel = {"description": "", "members": [], "last_time": "", "last_from": "",
               "preview": ""}
    return {
        "bootstrap": {
            "ok": True,
            "channels": [dict(channel, name="commons", live=True),
                         dict(channel, name="study", live=False)],
            "signing": {"armed": False, "deadline": None, "deadline_utc": None},
            "server_time": 0, "colors": {}, "rooms": [],
        },
        "messages": {"commons": [_message(1)], "study": [_message(2)]},
        "dr": {"ok": True, "records": []},
        "seen": {"ok": True, "seen_by": []},
        "send_script": [{"ok": True, "state": "sent", "message_id": "m1",
                         "clear_draft": True, "signed": False}],
    }


@pytest.fixture
def harness(tmp_path):
    path = tmp_path / "harness.mjs"
    path.write_text(HARNESS)

    def _run(*, serve_fixtures=True, **scenario):
        scenario.setdefault("search", "?dev=1")
        routes = scenario.setdefault("routes", [])
        if serve_fixtures:
            routes.append({"match": "devfixtures", "status": 200, "body": _fixture_body()})
        result = subprocess.run(
            [NODE, str(path), str(APP_JS), json.dumps(scenario)],
            capture_output=True, text=True, timeout=60, check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    return _run


DAEMON_200 = {"match": "/api/bootstrap", "status": 200, "body": {"ok": True, "channels": []}}
DAEMON_401 = {"match": "/api/bootstrap", "status": 401}


@needs_node
def test_fixture_mode_activates_only_in_the_dev_flow(harness):
    """Positive control — without this the refusals below prove nothing."""
    assert harness()["devMode"] is True


@needs_node
@pytest.mark.parametrize("label,scenario,expected_warning", [
    ("unpaired daemon", {"routes": [DAEMON_401]}, "daemon is answering"),
    ("paired daemon", {"routes": [DAEMON_200]}, "daemon is answering"),
    ("paired browser", {"localStorage": {"porch.csrf": "secret"}}, "paired session"),
])
def test_query_flag_alone_never_activates(harness, label, scenario, expected_warning):
    """The regression that must not come back: ?dev=1 is not sufficient."""
    result = harness(**scenario)
    assert result["devRequested"] is True, f"{label}: the flag was asked for"
    assert result["devMode"] is False, f"{label}: fixtures must not activate"
    assert any(expected_warning in w for w in result["warnings"]), result["warnings"]


@needs_node
def test_unreachable_fixtures_refuse_rather_than_half_activate(harness):
    result = harness(serve_fixtures=False)
    assert result["devMode"] is False
    assert any("fixtures unavailable" in w for w in result["warnings"])


@needs_node
def test_without_the_flag_nothing_is_even_probed(harness):
    result = harness(search="")
    assert result["devRequested"] is False and result["devMode"] is False
    assert result["warnings"] == []


# ------------------------------------------------- draft scope across sends


@needs_node
def test_a_slow_send_clears_its_own_channels_draft_not_the_visible_one(harness):
    """Sending from commons then switching to study must not wipe study.

    The reply lands 400ms after the switch; before the fix it cleared
    whichever channel was on screen and left commons' draft in storage.
    """
    result = harness(mode="draftscope")
    assert "error" not in result, result

    assert result["onScreen"] == "study"
    assert result["visibleComposer"] == "STUDY DRAFT"
    assert result["studyStored"] and "STUDY DRAFT" in result["studyStored"]
    assert result["commonsStored"] is None, "the sending channel's draft must be cleared"
