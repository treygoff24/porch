/* porch-mobile client.
 *
 * Contract: docs/mobile/SPEC.md. The rules this file exists to keep:
 *   - store text reaches the DOM only as text nodes (P6, §9)
 *   - the cursor advances only after paint, against a server delivery token (§8)
 *   - a send whose stated intent cannot be honored fails closed, draft kept (P1)
 *   - the client sends content, never policy; slash text goes out raw (§4)
 */
'use strict';

/* ── constants ───────────────────────────────────────────────────────── */

const MSG_POLL_MS = 1500;
const SLOW_POLL_MS = 5000;
const LONG_PRESS_MS = 480;
const UNREACHABLE_AFTER = 3;     // consecutive poll failures before the gate

/* ?dev=1 only ASKS for fixtures. Activation additionally requires that no
   porchd is answering /api/*, that this browser holds no paired session, and
   that the fixtures actually load — and the fixtures do not ship inside
   static/, so porchd cannot serve them at all. The query flag is the weakest
   of the four controls; not serving the file is the real one.

   The dev flow serves the package dir, one level above static/:
     cd src/porchd && python3 -m http.server 8477
   then open the loopback host on that port at /static/index.html?dev=1 */
const DEV_REQUESTED = new URLSearchParams(location.search).get('dev') === '1';
const DEV_FIXTURES_URL = '../devfixtures/dev-fixtures.json';
let devMode = false;

const LS = {
  csrf: 'porch.csrf',
  draft: (c) => 'porch.draft.' + c,
};

// Theme payload is the source of truth for FALLBACK_PALETTE (constants.py).
// Boot copy kept only until /bootstrap arrives.
let OWNER_ROOM = 'owner';
let OWNER_LABEL = 'owner';
let OWNER_ACCENT = '#FFD700';
let FALLBACK_PALETTE = [
  '#22c55e', '#eab308', '#3b82f6', '#d946ef', '#06b6d4', '#f8fafc',
];

/* ── state ───────────────────────────────────────────────────────────── */

const S = {
  paired: false,
  screen: 'loading',
  clockSkew: 0,          // serverTime - clientTime, ms
  colors: {},
  channels: [],
  lease: { armed: false, deadline: null },
  // Intent is DERIVED from the lease at send time (the 8/11 ruling:
  // armed means sign, dark means unsigned — no button). The header chip
  // is the indicator; the server still refuses a signed send that goes
  // dark mid-flight rather than downgrading it silently.

  channel: null,
  messages: [],
  seenIds: new Set(),
  tipId: null,
  deliveryToken: null,
  ackedThrough: null,
  pinned: true,

  drafts: {},            // channel -> text (mirrors localStorage)
  attachments: {},       // channel -> [{upload_id, name}]
  draftIds: {},          // channel -> draft_id

  bounce: null,          // {bounce_token, missed, draft_id, channel}
  sticky: null,
  stickyAction: null,
  sending: false,
  dr: [],
  failures: 0,
  sheetMsg: null,
  msgPollMs: MSG_POLL_MS,
  slowPollMs: SLOW_POLL_MS,
};

/* ── tiny DOM helpers ────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const app = $('app');

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function show(node, on) {
  node.hidden = !on;
}

function screen(name) {
  S.screen = name;
  app.dataset.screen = name;
}

function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ── transport ───────────────────────────────────────────────────────── */

class ApiError extends Error {
  constructor(status, payload) {
    const e = payload && payload.error;
    const msg = (e && e.message) || (payload && payload.message) || `HTTP ${status}`;
    super(msg);
    this.code = (e && e.code) || (payload && payload.reason) || '';
    this.status = status;
    this.payload = payload || {};
  }
}
class Unpaired extends Error {}
class Unreachable extends Error {}

function csrf() {
  return localStorage.getItem(LS.csrf) || '';
}

async function api(path, { method = 'GET', json, raw, contentType, headers } = {}) {
  if (devMode) return devApi(path, method, json);

  const init = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: Object.assign({ Accept: 'application/json' }, headers || {}),
  };
  if (method !== 'GET') {
    init.headers['X-Porch-CSRF'] = csrf();
    if (raw !== undefined) {
      init.body = raw;
      init.headers['Content-Type'] = contentType || 'application/octet-stream';
    } else {
      init.body = JSON.stringify(json || {});
      init.headers['Content-Type'] = 'application/json';
    }
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (_) {
    throw new Unreachable();
  }

  if (res.status === 401) throw new Unpaired();

  let payload = null;
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    try { payload = await res.json(); } catch (_) { payload = null; }
  }
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

/* ── dev fixtures ────────────────────────────────────────────────────── */

let devData = null;

async function devApi(path, method, json) {
  if (path === '/api/bootstrap') return devData.bootstrap;
  if (path === '/api/signing') return devData.bootstrap.signing;
  if (path === '/api/dr') return devData.dr;

  const msgs = path.match(/^\/api\/channels\/([^/]+)\/messages/);
  if (msgs) {
    const name = decodeURIComponent(msgs[1]);
    const list = (devData.messages && devData.messages[name]) || [];
    const tip = list.length ? list[list.length - 1].id : '';
    return { ok: true, messages: list, tip, delivery_token: tip ? 'dev-token' : undefined };
  }
  if (/\/seen\//.test(path)) return devData.seen || { ok: true, seen_by: [] };
  if (/\/ack$/.test(path)) return { ok: true, advanced: true };
  if (/\/dismiss$/.test(path)) return { ok: true, released: 1 };
  if (/\/reveal$/.test(path)) return { ok: true, grant: 'dev-grant-1' };
  if (/\/send$/.test(path) || /\/confirm$/.test(path)) {
    const scripted = (devData.send_script && devData.send_script.shift())
      || { ok: true, state: 'sent', message_id: 'dev-' + Date.now(), clear_draft: true };
    // Non-ok envelopes ride a 409 for real, so the dev path exercises the
    // same branch the server will take.
    if (!scripted.ok) throw new ApiError(409, scripted);
    return scripted;
  }
  if (path === '/api/images') return { ok: true, upload_id: 'dev-upload' };
  return { ok: true };
}

/* Every reason to refuse is a reason a real deployment must not fall into the
   fixture path. Refusals are logged for the developer, never surfaced to the operator. */
async function resolveDevMode() {
  if (!DEV_REQUESTED) return false;

  if (localStorage.getItem(LS.csrf)) {
    console.warn('porch: ?dev=1 refused — this browser holds a paired session.');
    return false;
  }

  // porchd answers /api/bootstrap with 200 (paired) or 401 (unpaired); it
  // never 404s that path. A static file server 404s it. Anything that looks
  // like a live daemon disqualifies fixture mode outright.
  try {
    const probe = await fetch('/api/bootstrap', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    });
    if (probe.status !== 404) {
      console.warn(`porch: ?dev=1 refused — a porch daemon is answering /api (HTTP ${probe.status}).`);
      return false;
    }
  } catch (_) {
    // No HTTP stack at all — consistent with a bare static host. Keep going.
  }

  try {
    const res = await fetch(DEV_FIXTURES_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    devData = await res.json();
  } catch (err) {
    console.warn(`porch: ?dev=1 refused — fixtures unavailable (${err.message}). `
                 + 'They live outside static/ and are never served by porchd.');
    return false;
  }
  return true;
}

function devImageUrl() {
  // Fixtures point at a real same-origin asset so the dev view never needs a
  // CSP exemption (no data: URIs, no remote hosts).
  return 'icons/icon-192.png';
}

/* ── failure gates ───────────────────────────────────────────────────── */

function gate(title, body, retry) {
  $('gate-title').textContent = title;
  $('gate-body').textContent = body;
  show($('gate-retry'), !!retry);
  $('gate-retry').onclick = retry || null;
  screen('gate');
}

function gateUnpaired() {
  S.paired = false;
  gate('Not paired',
       'Run porch-mobile pair on the Mac, then scan the QR code with this phone.',
       null);
}

function gateUnreachable() {
  gate('Mac unreachable',
       'Is it awake and on Tailscale?',
       () => { S.failures = 0; boot(); });
}

function noteFailure(err) {
  if (err instanceof Unpaired) { gateUnpaired(); return true; }
  if (err instanceof Unreachable) {
    S.failures += 1;
    if (S.failures >= UNREACHABLE_AFTER) { gateUnreachable(); return true; }
    return false;
  }
  return false;
}

/* ── pairing ─────────────────────────────────────────────────────────── */

async function maybePair() {
  const frag = location.hash.replace(/^#/, '');
  if (!frag) return;
  const token = frag.startsWith('pair=') ? decodeURIComponent(frag.slice(5)) : frag;
  if (!token) return;
  // Drop the token from the URL before anything can persist it.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const r = await api('/api/pair', { method: 'POST', json: { one_time_token: token } });
    if (r && r.csrf_secret) localStorage.setItem(LS.csrf, r.csrf_secret);
  } catch (_) {
    // A stale or spent token just means "carry on with the existing cookie".
  }
}

/* ── colors ──────────────────────────────────────────────────────────── */

function colorFor(msg) {
  if (msg.color) return msg.color;
  if (S.colors[msg.from]) return S.colors[msg.from];
  let h = 0;
  for (const ch of String(msg.from || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

/* ── time ────────────────────────────────────────────────────────────── */

function serverNow() {
  return Date.now() + S.clockSkew;
}

/* lease.status() gives armed + an epoch-seconds deadline + an ISO mirror. The
   deadline is the server's; we never infer one from a client timer (§3). */
function leaseOf(sig) {
  let ends = null;
  if (sig.deadline_utc) {
    const t = Date.parse(sig.deadline_utc);
    if (!isNaN(t)) ends = t;
  }
  if (ends === null && typeof sig.deadline === 'number') ends = sig.deadline * 1000;
  return { armed: !!sig.armed, deadline: ends };
}

function hhmm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function humanLeft(ms) {
  if (ms <= 0) return '';
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ── message rendering ───────────────────────────────────────────────── */

/* Mention spans are code-point offsets into the sanitized body, so the slicing
   goes through Array.from — UTF-16 indices would drift on every emoji. */
function renderBody(into, body, spans) {
  const cps = Array.from(String(body || ''));
  const list = (spans || [])
    .filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let i = 0;
  for (const s of list) {
    if (s.start < i || s.end > cps.length) continue;
    if (s.start > i) into.appendChild(document.createTextNode(cps.slice(i, s.start).join('')));
    const m = el('span', 'mention' + (s.owner || s.room === OWNER_ROOM ? ' mention-owner' : ''));
    m.textContent = cps.slice(s.start, s.end).join('');
    into.appendChild(m);
    i = s.end;
  }
  if (i < cps.length) into.appendChild(document.createTextNode(cps.slice(i).join('')));
}

/* verify_badge() hands us the rendered badge (" 🔏\u2713", " 🔏\u2717UNVERIFIED",
   " 🔏\u2026", " 🔏?") or "" — style it by what it says. */
function verifyBadge(v) {
  const text = String(v || '').trim();
  if (!text) return null;
  if (text.includes('\u2717')) return { text, cls: 'badge badge-bad' };
  if (text.includes('\u2026') || text.includes('?')) return { text, cls: 'badge badge-pending' };
  return { text, cls: 'badge' };
}

function senderLabel(m) {
  return m.sender_label || m.from || '';
}

function messageNode(m) {
  const node = el('article', 'msg');
  node.dataset.id = m.id;
  node.style.borderLeftColor = colorFor(m);
  if (m.mentions_owner) node.classList.add('mentions-owner');

  const head = el('div', 'msg-head');
  head.appendChild(el('span', 'msg-time', m.time || ''));
  const from = el('span', 'msg-from', senderLabel(m));
  from.style.color = colorFor(m);
  head.appendChild(from);

  const vb = verifyBadge(m.verify);
  if (vb) head.appendChild(el('span', vb.cls, vb.text));
  const drBadge = String(m.dr || '').trim();
  if (drBadge) head.appendChild(el('span', 'badge badge-dr', drBadge));
  node.appendChild(head);

  if (m.reply) node.appendChild(el('p', 'msg-reply', m.reply));

  const body = el('p', 'msg-body');
  renderBody(body, m.body, m.mentions);
  node.appendChild(body);

  if (Array.isArray(m.images) && m.images.length) {
    node.appendChild(imagesNode(m));
  }

  attachLongPress(node, m);
  return node;
}

function imagesNode(m) {
  const wrap = el('div', 'msg-images');
  m.images.forEach((img, idx) => {
    const index = Number.isInteger(img.index) ? img.index : idx;
    if (img.reason) {
      wrap.appendChild(el('span', 'img-fail', `📷 ${img.name || 'image'} · ${img.reason}`));
      return;
    }
    if (img.grant) {
      wrap.appendChild(thumbNode(img));
      return;
    }
    const chip = el('button', 'img-chip', `📷 ${img.name || 'image'} · tap to render`);
    chip.type = 'button';
    chip.addEventListener('click', async () => {
      chip.disabled = true;
      chip.textContent = `📷 ${img.name || 'image'} · rendering…`;
      try {
        const r = await api(`/api/messages/${encodeURIComponent(m.id)}/images/${index}/reveal`,
                            { method: 'POST', json: {} });
        if (r && r.grant) {
          img.grant = r.grant;
          chip.replaceWith(thumbNode(img));
        } else {
          chip.textContent = `📷 ${img.name || 'image'} · not available`;
        }
      } catch (err) {
        if (!noteFailure(err)) {
          chip.disabled = false;
          chip.textContent = `📷 ${img.name || 'image'} · ${err.message}`;
        }
      }
    });
    wrap.appendChild(chip);
  });
  return wrap;
}

function thumbNode(img) {
  const el2 = document.createElement('img');
  el2.className = 'thumb';
  el2.loading = 'lazy';
  el2.alt = img.name || 'image';
  el2.src = devMode ? devImageUrl() : `/api/images/${encodeURIComponent(img.grant)}`;
  return el2;
}

function daySepNode(day) {
  return el('div', 'daysep', day);
}

/* ── chat screen ─────────────────────────────────────────────────────── */

const scroller = () => $('scroller');

function atBottom() {
  const s = scroller();
  return s.scrollHeight - s.scrollTop - s.clientHeight < 48;
}

function toBottom() {
  const s = scroller();
  s.scrollTop = s.scrollHeight;
  S.pinned = true;
  show($('jump-latest'), false);
}

function appendMessages(list) {
  const box = $('messages');
  let lastDay = S.messages.length ? S.messages[S.messages.length - 1].day : null;
  const wasPinned = S.pinned;

  for (const m of list) {
    if (S.seenIds.has(m.id)) continue;
    S.seenIds.add(m.id);
    const day = m.day || (m.sent ? String(m.sent).slice(0, 10) : null);
    if (day && day !== lastDay) {
      box.appendChild(daySepNode(day));
      lastDay = day;
    }
    m.day = day;
    S.messages.push(m);
    box.appendChild(messageNode(m));
  }

  show($('chat-empty'), S.messages.length === 0);
  if (wasPinned) toBottom();
}

function resetChat() {
  clear($('messages'));
  S.messages = [];
  S.seenIds = new Set();
  S.tipId = null;
  S.deliveryToken = null;
  S.ackedThrough = null;
  S.pinned = true;
}

/* Cursor move: only after the browser has actually painted through the tip,
   and only against the token that covered it (§8). Never on fetch. */
function ackWhenPainted(throughId, token) {
  if (!throughId || !token) return;
  if (S.ackedThrough === throughId) return;
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    const channel = S.channel;
    try {
      await api(`/api/channels/${encodeURIComponent(channel)}/ack`,
                { method: 'POST', json: { through_id: throughId, delivery_token: token } });
      if (S.channel === channel) S.ackedThrough = throughId;
    } catch (err) {
      noteFailure(err);   // a lost ack is retried on the next poll; never fatal
    }
  }));
}

async function loadMessages({ full = false } = {}) {
  const channel = S.channel;
  if (!channel) return;
  if (full) resetChat();

  const q = S.tipId ? `?after=${encodeURIComponent(S.tipId)}` : '';
  let r;
  try {
    r = await api(`/api/channels/${encodeURIComponent(channel)}/messages${q}`);
  } catch (err) {
    noteFailure(err);
    return;
  }
  if (S.channel !== channel) return;   // switched away mid-flight
  S.failures = 0;

  const list = Array.isArray(r.messages) ? r.messages : [];
  if (list.length) appendMessages(list);

  if (r.tip) S.tipId = r.tip;
  else if (S.messages.length) S.tipId = S.messages[S.messages.length - 1].id;

  S.deliveryToken = r.delivery_token || null;
  ackWhenPainted(S.tipId, S.deliveryToken);
}

async function openChannel(name) {
  S.channel = name;
  resetChat();
  $('chat-title').textContent = '#' + name;
  const meta = S.channels.find((c) => c.name === name);
  const head = $('chat-head');
  head.textContent = meta && meta.description ? `#${name} — ${meta.description}` : `#${name}`;
  restoreDraft(name);
  clearSticky();
  keepEditing();
  screen('chat');
  await loadMessages({ full: true });
  toBottom();
}

/* ── channel list ────────────────────────────────────────────────────── */

function renderChannels() {
  const box = $('channel-list');
  clear(box);
  show($('channel-empty'), S.channels.length === 0);

  for (const c of S.channels) {
    const btn = el('button', 'chan');
    btn.type = 'button';

    const row = el('div', 'chan-row');
    row.appendChild(el('span', 'dot' + (c.live ? ' live' : '')));
    row.appendChild(el('span', 'chan-name', '#' + c.name));
    if (c.last_time || c.last_from) {
      const when = [c.last_time, c.last_from].filter(Boolean).join(' · ');
      row.appendChild(el('span', 'chan-when', when));
    }
    btn.appendChild(row);

    if (c.description) btn.appendChild(el('p', 'chan-desc', c.description));

    const prev = el('p', 'chan-prev');
    if (c.preview_from) {
      prev.appendChild(el('span', 'chan-prev-from', c.preview_from + ': '));
      prev.appendChild(document.createTextNode(c.preview || ''));
    } else {
      prev.textContent = c.preview || 'No messages yet';
    }
    btn.appendChild(prev);

    if (Array.isArray(c.members) && c.members.length) {
      const mem = el('div', 'chan-members');
      for (const m of c.members) {
        const one = el('span', 'member');
        one.appendChild(el('span', 'dot' + (m.live ? ' live' : '')));
        one.appendChild(document.createTextNode(m.room || String(m)));
        mem.appendChild(one);
      }
      btn.appendChild(mem);
    }

    btn.addEventListener('click', () => openChannel(c.name));
    box.appendChild(btn);
  }
}

/* ── lease + intent ──────────────────────────────────────────────────── */

function renderLease() {
  const chip = $('lease-chip');
  chip.classList.remove('armed', 'dark');

  if (S.lease.armed && S.lease.deadline) {
    const left = S.lease.deadline - serverNow();
    const until = hhmm(S.lease.deadline);
    chip.classList.add('armed');
    chip.textContent = left > 0 ? `🔏 ARMED until ${until} · ${humanLeft(left)}` : '🔏 ARMED';
  } else {
    chip.classList.add('dark');
    chip.textContent = 'unsigned chat';
  }

}

async function pollSigning() {
  try {
    const r = await api('/api/signing');
    if (r) {
      S.lease = leaseOf(r);
      renderLease();
    }
  } catch (err) { noteFailure(err); }
}

async function lockLease() {
  if (!S.lease.armed) return;
  if (!confirm('Lock the signing key now? You will need the Mac to arm it again.')) return;
  try {
    await api('/api/signing/lock', { method: 'POST', json: {} });
    await pollSigning();
    toast('signing locked');
  } catch (err) {
    if (!noteFailure(err)) toast(err.message, true);
  }
}

/* ── drafts ──────────────────────────────────────────────────────────── */

function draftId(channel) {
  if (!S.draftIds[channel]) S.draftIds[channel] = uuid();
  return S.draftIds[channel];
}

function rotateDraftId(channel) {
  S.draftIds[channel] = uuid();
}

function saveDraft() {
  const c = S.channel;
  if (!c) return;
  const payload = {
    text: $('draft').value,
    attachments: S.attachments[c] || [],   // upload_id + display name only — never a path
  };
  S.drafts[c] = payload.text;
  try { localStorage.setItem(LS.draft(c), JSON.stringify(payload)); } catch (_) { /* full disk */ }
}

function restoreDraft(channel) {
  let payload = { text: '', attachments: [] };
  try {
    const raw = localStorage.getItem(LS.draft(channel));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.text === 'string') payload = parsed;
    }
  } catch (_) { /* corrupt draft — start clean */ }

  const ta = $('draft');
  ta.value = payload.text || '';
  S.drafts[channel] = ta.value;
  S.attachments[channel] = Array.isArray(payload.attachments)
    ? payload.attachments.filter((a) => a && typeof a.upload_id === 'string')
    : [];
  autosize();
  renderChips();
  const end = ta.value.length;
  try { ta.setSelectionRange(end, end); } catch (_) { /* not focused yet */ }
}

function clearDraft(channel) {
  const c = channel || S.channel;
  if (!c) return;
  S.drafts[c] = '';
  S.attachments[c] = [];
  rotateDraftId(c);
  try { localStorage.removeItem(LS.draft(c)); } catch (_) { /* fine */ }
  // The persisted draft always dies; the visible composer is only touched
  // when it is still showing that channel.
  if (S.channel === c) {
    $('draft').value = '';
    autosize();
    renderChips();
  }
}

function autosize() {
  const ta = $('draft');
  ta.style.height = 'auto';
  // Cap against the VISIBLE viewport so a grown draft never swallows the
  // screen left above the keyboard.
  const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
  ta.style.height = Math.min(ta.scrollHeight, Math.round(vh * 0.32)) + 'px';
}

/* iOS keyboard: the fixed shell keeps layout-viewport size while the
   keyboard shrinks the VISUAL viewport, leaving the composer floating
   mid-screen. Track visualViewport and size/offset the shell to exactly
   the visible area so the composer hugs the keyboard (the operator's iPhone, 8/11). */
function fitToVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const app = $('app');
  const fit = () => {
    const full = window.innerHeight;
    // Within ~1px of full height = no keyboard; clear overrides.
    if (full - vv.height < 2 && vv.offsetTop < 2) {
      app.style.height = '';
      app.style.top = '';
      return;
    }
    app.style.height = vv.height + 'px';
    app.style.top = vv.offsetTop + 'px';
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  fit();
}

function renderChips() {
  const box = $('chips');
  const list = (S.channel && S.attachments[S.channel]) || [];
  clear(box);
  show(box, list.length > 0);
  list.forEach((a, i) => {
    const chip = el('span', 'chip-att');
    chip.appendChild(document.createTextNode('📎 ' + (a.name || 'image')));
    const x = el('button', 'chip-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove attachment');
    x.addEventListener('click', () => {
      list.splice(i, 1);
      onDraftEdited();
      renderChips();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

/* Any edit after a bounce invalidates the bounce token: a new draft is a new
   send, never a confirmation of the old one (§7). */
function onDraftEdited() {
  if (S.bounce) {
    keepEditing();
    rotateDraftId(S.channel);
  }
  saveDraft();
}

/* ── status surfaces ─────────────────────────────────────────────────── */

let toastTimer = null;

function toast(text, isError) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('err', !!isError);
  show(t, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), isError ? 6000 : 2800);
}

/* Must-acknowledge states stay put until the operator taps them away (§9). An optional
   action gives a refusal its explicit way out. */
function setSticky(text, action) {
  clearTimeout(toastTimer);
  show($('toast'), false);   // a green "sent" under a red refusal reads as a lie
  S.sticky = text;
  S.stickyAction = (action && action.fn) || null;
  $('sticky-text').textContent = text;
  const alt = $('sticky-alt');
  alt.textContent = action ? action.label : '';
  show(alt, !!action);
  show($('sticky'), true);
}

function clearSticky() {
  S.sticky = null;
  S.stickyAction = null;
  show($('sticky-alt'), false);
  show($('sticky'), false);
}

/* ── sending ─────────────────────────────────────────────────────────── */

function isSendEnvelope(err) {
  if (!(err instanceof ApiError) || !err.payload) return false;
  return !!(err.payload.state || (err.payload.error && err.payload.error.code));
}

/* Intent follows the lease at the moment of sending (the 8/11 ruling).
   If it goes dark mid-flight the server still refuses rather than
   downgrading — the retry then derives unsigned, which is the choice. */
function intentValue() {
  return S.lease.armed ? 'signed' : 'unsigned';
}

/* Dark means "choose again", not "silently switch" (§10). Both ways out are
   explicit: go arm the Mac, or tap the button that changes the preference. */
function chooseAgain(lead) {
  setSticky(
    lead + ' Your draft is kept. Arm the lease at the Mac to send it '
    + 'signed, or send it unsigned below.',
    { label: 'Send unsigned instead', fn: sendUnsignedByChoice },
  );
}

function sendUnsignedByChoice() {
  // Intent derives from the lease; it went dark, so the retry is unsigned.
  clearSticky();
  doSend();
}

async function doSend() {
  if (S.sending) return;
  const channel = S.channel;
  const text = $('draft').value;
  const attachments = S.attachments[channel] || [];
  if (!text.trim() && attachments.length === 0) return;

  S.sending = true;
  $('send').disabled = true;
  try {
    const body = {
      attempt_id: uuid(),
      draft_id: draftId(channel),
      draft_text: text,                     // raw, slash included — the Mac dispatches
      intent: intentValue(),
      attachments: attachments.map((a) => a.upload_id),
    };
    const r = await api(`/api/channels/${encodeURIComponent(channel)}/send`,
                        { method: 'POST', json: body });
    handleSendResult(r, channel, body.intent);
  } catch (err) {
    if (isSendEnvelope(err)) {
      handleSendResult(err.payload, channel, intentValue());
    } else if (!noteFailure(err)) {
      setSticky(`Send failed — ${err.message}. Draft kept.`);
    }
  } finally {
    S.sending = false;
    $('send').disabled = false;
  }
}

async function doConfirm() {
  if (S.sending || !S.bounce) return;
  const channel = S.bounce.channel;
  const token = S.bounce.bounce_token;
  S.sending = true;
  $('cross-send').disabled = true;
  try {
    const r = await api(`/api/channels/${encodeURIComponent(channel)}/confirm`,
                        { method: 'POST', json: { confirm_attempt_id: uuid(), bounce_token: token } });
    handleSendResult(r, channel, intentValue());
  } catch (err) {
    if (isSendEnvelope(err)) {
      handleSendResult(err.payload, channel, intentValue());
    } else if (!noteFailure(err)) {
      setSticky(`Send failed — ${err.message}. Draft kept.`);
    }
  } finally {
    S.sending = false;
    $('cross-send').disabled = false;
  }
}

/* The server hands back a ledger `state`, a finer `error.code`, and its own
   `clear_draft` verdict. Draft retention is the server's call, not ours (§7);
   the three must-acknowledge states get a sticky, everything else a toast. */
function handleSendResult(r, channel, intent) {
  const state = r && r.state;
  const code = (r && r.error && r.error.code) || '';
  const detail = (r && r.error && r.error.message) || (r && r.message) || '';

  if (state === 'crossed') {
    showBounce({
      channel,
      bounce_token: r.bounce_token,
      missed: Array.isArray(r.missed) ? r.missed : [],
    });
    return;
  }

  dismissBounce();

  if (state === 'sent') {
    clearSticky();
    clearDraft(channel);
    // Whether it was actually signed is the Mac's fact, not our intent (v1.5).
    const signed = typeof r.signed === 'boolean' ? r.signed : intent === 'signed';
    toast(signed ? 'signed + sent' : 'sent');
    if (S.channel === channel) loadMessages().then(toBottom);
    return;
  }

  if (r && r.clear_draft) clearDraft(channel);

  if (code === 'signing_unavailable') {
    // The lease died between our check and the Mac's. Refresh what we show,
    // but leave the preference alone — only the operator may downgrade it.
    pollSigning();
    chooseAgain('The lease went dark before the Mac executed this send.');
    return;
  }

  if (code === 'committed_output_failure' || state === 'committed_output_failure') {
    setSticky(detail || 'Committed — do not retry. The message went out but the Mac '
              + 'could not confirm the write. Check the porch on the Mac before resending.');
    return;
  }

  if (code === 'outcome_unknown' || state === 'unknown') {
    setSticky(detail || 'Outcome unknown — this send may or may not have landed. Nothing '
              + 'was retried and your draft is kept. Check the channel before sending again.');
    return;
  }

  if (code === 'idempotency_conflict') {
    rotateDraftId(channel);
    setSticky('That attempt id was already used for a different request. Nothing was sent '
              + 'and your draft is kept — tap Send again to make a fresh attempt.');
    return;
  }

  // refused: unknown slash command, bad args, generic send failure — draft kept
  toast(detail || 'refused — draft kept', true);
}

/* ── crossed-send modal ──────────────────────────────────────────────── */

function showBounce(b) {
  S.bounce = b;
  const box = $('cross-missed');
  clear(box);
  if (!b.missed.length) {
    box.appendChild(el('p', 'modal-note', 'The Mac did not return the missed messages.'));
  } else {
    for (const m of b.missed) box.appendChild(messageNode(m));
  }
  show($('cross-scrim'), true);
  show($('cross'), true);
}

/* Local teardown only — for when the server has already moved the attempt on. */
function dismissBounce() {
  S.bounce = null;
  show($('cross-scrim'), false);
  show($('cross'), false);
}

/* "Keep editing" is the explicit release of the attachment reservations the
   bounce is holding (§5). Without this call the chips stay reserved_for_confirm
   until the bounce token expires, and the edited draft's next send is refused
   for touching a held upload_id. */
function keepEditing() {
  const b = S.bounce;
  dismissBounce();
  if (!b || !b.bounce_token) return;
  api(`/api/channels/${encodeURIComponent(b.channel)}/dismiss`,
      { method: 'POST', json: { bounce_token: b.bounce_token } })
    .catch((err) => {
      // An expired or already-spent token means the hold is gone anyway —
      // the deduction the server makes at the bounce deadline. Nothing to say.
      if (!(err instanceof ApiError)) noteFailure(err);
    });
}

/* ── attachments ─────────────────────────────────────────────────────── */

async function uploadFile(file) {
  if (!file) return;
  toast('uploading ' + file.name + '…');
  try {
    const buf = await file.arrayBuffer();
    const r = await api('/api/images', {
      method: 'POST',
      raw: buf,
      contentType: file.type || 'application/octet-stream',
    });
    if (!r || !r.upload_id) throw new Error('upload refused');
    const list = S.attachments[S.channel] || (S.attachments[S.channel] = []);
    list.push({ upload_id: r.upload_id, name: r.name || file.name });
    onDraftEdited();
    renderChips();
    toast('image attached');
  } catch (err) {
    if (!noteFailure(err)) toast('image refused — ' + err.message, true);
  }
}

/* ── message detail sheet ────────────────────────────────────────────── */

function attachLongPress(node, m) {
  let timer = null;
  let start = null;

  const cancel = () => { clearTimeout(timer); timer = null; };

  node.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => { timer = null; openSheet(m); }, LONG_PRESS_MS);
  }, { passive: true });

  node.addEventListener('touchmove', (e) => {
    if (!timer || !start) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) cancel();
  }, { passive: true });

  node.addEventListener('touchend', cancel, { passive: true });
  node.addEventListener('touchcancel', cancel, { passive: true });

  // Desktop/dev affordance — long-press has no mouse equivalent.
  node.addEventListener('contextmenu', (e) => { e.preventDefault(); openSheet(m); });
}

async function openSheet(m) {
  S.sheetMsg = m;
  const box = $('sheet-body');
  clear(box);

  box.appendChild(el('p', 'sheet-label', 'From'));
  box.appendChild(el('p', 'sheet-val', senderLabel(m)));

  box.appendChild(el('p', 'sheet-label', 'Sent'));
  box.appendChild(el('p', 'sheet-val', `${m.day || ''} ${m.time || ''}`.trim()));

  box.appendChild(el('p', 'sheet-label', 'Message id'));
  box.appendChild(el('p', 'sheet-val', m.id));

  const vb = verifyBadge(m.verify);
  if (vb) {
    box.appendChild(el('p', 'sheet-label', 'Signature'));
    box.appendChild(el('p', 'sheet-val', vb.text));
  }

  box.appendChild(el('p', 'sheet-label', 'Body'));
  const body = el('p', 'sheet-val');
  body.style.whiteSpace = 'pre-wrap';
  body.appendChild(document.createTextNode(String(m.body || '')));
  box.appendChild(body);

  box.appendChild(el('p', 'sheet-label', 'Seen by'));
  const seen = el('div', 'seen-list');
  seen.appendChild(el('span', 'seen-pill', 'checking…'));
  box.appendChild(seen);

  show($('sheet-copy'), true);
  show($('sheet-scrim'), true);
  show($('sheet'), true);

  try {
    const r = await api(`/api/channels/${encodeURIComponent(S.channel)}/seen/${encodeURIComponent(m.id)}`);
    clear(seen);
    const list = (r && r.seen_by) || [];
    if (!list.length) seen.appendChild(el('span', 'seen-pill', 'nobody yet'));
    else for (const who of list) seen.appendChild(el('span', 'seen-pill', String(who)));
  } catch (err) {
    clear(seen);
    seen.appendChild(el('span', 'seen-pill', noteFailure(err) ? 'unavailable' : err.message));
  }
}

function closeSheet() {
  S.sheetMsg = null;
  show($('sheet-scrim'), false);
  show($('sheet'), false);
}

async function copySheet() {
  const m = S.sheetMsg;
  if (!m) return;
  const text = String(m.body || '');
  try {
    await navigator.clipboard.writeText(text);
    toast(`copied ${m.from} ${m.time || ''}`.trim());
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? 'copied' : 'copy blocked by the browser', !ok);
  }
  closeSheet();
}

/* ── decision records ────────────────────────────────────────────────── */

// needs_operator_decision reads OWNER_LABEL live (via drState), since
// bootstrap can update the label after this module evaluates.
const DR_STATE = {
  ratified:               { label: 'ratified',   cls: 'st-ratified' },
  rejected:               { label: 'rejected',   cls: 'st-rejected' },
  superseded:             { label: 'superseded', cls: 'st-superseded' },
};

function drState(d) {
  if (d.state === 'needs_operator_decision') {
    return { label: 'needs ' + (OWNER_LABEL || 'owner'), cls: 'st-needs' };
  }
  return DR_STATE[d.state] || { label: d.state || '', cls: '' };
}

async function loadDR() {
  try {
    const r = await api('/api/dr');
    S.dr = (r && r.records) || [];
    if (r && r.signing) { S.lease = leaseOf(r.signing); renderLease(); }
    renderDR();
    const needs = S.dr.filter((d) => d.state === 'needs_operator_decision').length;
    show($('dr-pip'), needs > 0);
  } catch (err) { noteFailure(err); }
}

function renderDR() {
  const box = $('dr-list');
  clear(box);
  show($('dr-empty'), S.dr.length === 0);

  for (const d of S.dr) {
    const btn = el('button', 'dr');
    btn.type = 'button';
    const st = drState(d);
    const row = el('div', 'dr-row');
    row.appendChild(el('span', 'dr-id', 'DR ' + d.dr));
    row.appendChild(el('span', 'dr-status ' + st.cls, st.label));
    btn.appendChild(row);
    if (d.title) btn.appendChild(el('p', 'dr-title', d.title));
    if (d.project) btn.appendChild(el('p', 'dr-project', d.project));
    btn.addEventListener('click', () => openDRSheet(d));
    box.appendChild(btn);
  }
}

/* DR mutations are never their own API call: the sheet loads slash text into
   the composer and the operator sends it down the one mutation lane (§4). */
function openDRSheet(d) {
  const box = $('sheet-body');
  clear(box);
  box.appendChild(el('p', 'sheet-label', 'Record'));
  box.appendChild(el('p', 'sheet-val', 'DR ' + d.dr));
  if (d.title) {
    box.appendChild(el('p', 'sheet-label', 'Title'));
    box.appendChild(el('p', 'sheet-val', d.title));
  }
  if (d.project) {
    box.appendChild(el('p', 'sheet-label', 'Project'));
    box.appendChild(el('p', 'sheet-val', d.project));
  }
  box.appendChild(el('p', 'sheet-label', 'Status'));
  box.appendChild(el('p', 'sheet-val', drState(d).label));

  box.appendChild(el('p', 'sheet-label', 'Authority actions'));
  if (!S.lease.armed) {
    box.appendChild(el('p', 'sheet-val',
      'Signing is dark. An unsigned ⚖️ message is theater, so these are disabled '
      + 'until the lease is armed at the Mac.'));
  } else {
    const row = el('div', 'seen-list');
    for (const verb of ['accept', 'reject']) {
      const b = el('button', 'btn btn-quiet', verb);
      b.type = 'button';
      b.addEventListener('click', () => loadSlashIntoComposer(`/${verb} ${d.dr}`, d.channel));
      row.appendChild(b);
    }
    const sup = el('button', 'btn btn-quiet', 'supersede…');
    sup.type = 'button';
    sup.addEventListener('click', () => loadSlashIntoComposer(`/supersede ${d.dr} `, d.channel));
    row.appendChild(sup);
    box.appendChild(row);
    box.appendChild(el('p', 'modal-note',
      'This fills the composer. Nothing is sent until you tap Send.'));
  }

  S.sheetMsg = null;
  show($('sheet-copy'), false);   // nothing to copy on a record sheet
  show($('sheet-scrim'), true);
  show($('sheet'), true);
}

async function loadSlashIntoComposer(text, channel) {
  closeSheet();
  const target = channel || S.channel;
  if (target && target !== S.channel) await openChannel(target);
  else screen('chat');
  const ta = $('draft');
  ta.value = text;
  onDraftEdited();
  autosize();
  ta.focus();
  try { ta.setSelectionRange(text.length, text.length); } catch (_) { /* ignore */ }
  // Intent derives from the lease, and DR actions are only offered while
  // armed, so this send will be signed — nothing to toggle.
}

/* ── polling ─────────────────────────────────────────────────────────── */

let msgTimer = null;
let slowTimer = null;

function visible() {
  return document.visibilityState === 'visible';
}

function scheduleMessages() {
  clearTimeout(msgTimer);
  if (!visible()) return;                       // a hidden tab does not poll (§1)
  msgTimer = setTimeout(async () => {
    if (S.screen === 'chat' && S.channel) await loadMessages();
    scheduleMessages();
  }, S.msgPollMs);
}

function scheduleSlow() {
  clearTimeout(slowTimer);
  slowTimer = setTimeout(async () => {
    if (visible()) {
      await refreshChannels();
      await pollSigning();
    }
    scheduleSlow();
  }, S.slowPollMs);
}

async function refreshChannels() {
  try {
    const r = await api('/api/bootstrap');
    applyBootstrap(r);
    if (S.screen === 'channels') renderChannels();
  } catch (err) { noteFailure(err); }
}

function applyBootstrap(r) {
  if (!r) return;
  S.failures = 0;
  if (typeof r.server_time === 'number') S.clockSkew = r.server_time * 1000 - Date.now();
  // The Mac owns the cadence; mirror whatever the TUI is running (§1).
  if (typeof r.poll_interval_s === 'number') S.msgPollMs = r.poll_interval_s * 1000;
  if (typeof r.channel_poll_interval_s === 'number') S.slowPollMs = r.channel_poll_interval_s * 1000;
  S.colors = (r.colors && typeof r.colors === 'object') ? r.colors : S.colors;
  if (r.owner_room) OWNER_ROOM = r.owner_room;
  if (r.owner_label) OWNER_LABEL = r.owner_label;
  if (r.owner_accent) {
    OWNER_ACCENT = r.owner_accent;
    document.documentElement.style.setProperty('--owner-accent', OWNER_ACCENT);
  }
  if (Array.isArray(r.fallback_palette) && r.fallback_palette.length) {
    // Theme payload is source of truth — replace boot fallback.
    FALLBACK_PALETTE = r.fallback_palette.slice();
  }
  S.channels = Array.isArray(r.channels) ? r.channels : [];
  if (r.signing) S.lease = leaseOf(r.signing);
  renderLease();
}

/* ── boot ────────────────────────────────────────────────────────────── */

async function boot() {
  try {
    const r = await api('/api/bootstrap');
    applyBootstrap(r);
    S.paired = true;
  } catch (err) {
    if (err instanceof Unpaired) { gateUnpaired(); return; }
    gateUnreachable();
    return;
  }

  renderChannels();
  loadDR();

  if (S.channel && S.channels.some((c) => c.name === S.channel)) {
    await openChannel(S.channel);
  } else {
    screen('channels');
  }
  scheduleMessages();
  scheduleSlow();
}

/* ── wiring ──────────────────────────────────────────────────────────── */

function wire() {
  fitToVisualViewport();
  $('nav-back').addEventListener('click', () => { screen('channels'); renderChannels(); });
  $('nav-dr').addEventListener('click', () => { screen('dr'); loadDR(); });
  $('dr-back').addEventListener('click', () => screen(S.channel ? 'chat' : 'channels'));

  $('lease-chip').addEventListener('click', lockLease);

  const ta = $('draft');
  ta.addEventListener('input', () => { autosize(); onDraftEdited(); });
  // Return inserts a newline; only the Send button sends (§9, deliberate
  // inversion of the TUI's Enter-sends grammar).
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
  });

  $('send').addEventListener('click', doSend);
  $('attach').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) uploadFile(f);
  });

  $('sticky-ack').addEventListener('click', clearSticky);
  $('sticky-alt').addEventListener('click', () => {
    const act = S.stickyAction;
    if (act) act();
  });

  $('cross-edit').addEventListener('click', keepEditing);
  $('cross-send').addEventListener('click', doConfirm);
  $('cross-scrim').addEventListener('click', keepEditing);

  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-scrim').addEventListener('click', closeSheet);
  $('sheet-copy').addEventListener('click', copySheet);

  $('jump-latest').addEventListener('click', toBottom);
  $('gate-retry').addEventListener('click', () => { S.failures = 0; boot(); });

  scroller().addEventListener('scroll', () => {
    S.pinned = atBottom();
    show($('jump-latest'), !S.pinned);
  }, { passive: true });

  const transcript = $('transcript');
  if (transcript) {
    transcript.addEventListener('click', () => {
      if (!S.channel) return;
      const a = document.createElement('a');
      a.href = `/api/channels/${encodeURIComponent(S.channel)}/transcript`;
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  document.addEventListener('visibilitychange', async () => {
    if (!visible()) { clearTimeout(msgTimer); return; }
    // Coming back from hidden: nothing polled while away, so re-sync fully (§1).
    await refreshChannels();
    await pollSigning();
    if (S.screen === 'chat' && S.channel) await loadMessages({ full: true });
    scheduleMessages();
  });

  window.addEventListener('resize', autosize);
}

async function main() {
  wire();
  devMode = await resolveDevMode();
  show($('devbar'), devMode);
  if (devMode) {
    document.title = 'porch (dev)';
  } else {
    await maybePair();
  }
  await boot();
}

main();
