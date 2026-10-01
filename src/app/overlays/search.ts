/**
 * Search (Ctrl+F, or `/search <words>`): the current channel's whole history. Type the words, Enter
 * runs the search, ↑↓ choose a hit, Enter again opens it (the core scrolls the channel to the hit
 * and picks it), Esc closes and stops a search still running. Editing the words during or after a
 * search stops it and goes back to typing.
 *
 * The history is searched by post itself (`post search`, through post-kit's `OwnerPost.search`): a
 * literal, case-insensitive substring of a message's body, sender room or id, newest first, at most
 * 1000 hits. Nothing pages the history through Porch, so a channel's size costs post's scan, not
 * Porch's memory. When post stops at the limit the overlay says so ("1000+ matches; refine").
 *
 * The loaded window adds what post's search does not match: an exact message id, and a sender's
 * shown name or participant id. A hit already in the window keeps the stream's verdict. Any other
 * hit arrives with only post's preview (the body's first ~160 characters, lines run together), which
 * may not reach the match, so the overlay reads the full body of each such hit as it comes on
 * screen, a few at a time, through post-kit's `message` read; Esc stops those reads with the search.
 * Neither the preview nor that read checks a signature, so a hit from Trey's room outside the window
 * is labelled as a claim ("claims Trey"), never as Trey.
 */
import {
  type DisplayRecord,
  displayText,
  type OwnerAnchor,
  parseRaw,
  type RawRecord,
  type Result,
  type SearchHit,
  toDisplay,
} from '@estate/post-kit';
import type { Grid, Rect } from '../../grid/grid.ts';
import { graphemes, textWidth } from '../../grid/text.ts';
import { nameSender, sentWhen } from '../derive.ts';
import type { Key, KeyResult, Overlay } from '../registry.ts';
import { T } from '../stage/theme.ts';
import type { AppState } from '../state.ts';
import {
  card,
  edit,
  field,
  footer,
  isDown,
  isEnter,
  isEsc,
  isUp,
  scrollFor,
  trunc,
} from './kit.ts';

export const SEARCH = 'search';

/**
 * Hits newest first; `truncated` means post found more than `limit` and stopped. `partial` names the
 * hits whose text is only post's preview, whose full body the overlay reads when it shows them.
 */
export type SearchResult = {
  hits: readonly DisplayRecord[];
  truncated: boolean;
  limit: number;
  partial?: ReadonlySet<string>;
};
/** The full record of one hit, by id (the default reads it through post-kit's `message`). */
export type BodySource = (
  s: AppState,
  channel: string,
  id: string,
  signal: AbortSignal,
) => Promise<Result<DisplayRecord>>;
export type SearchSource = (
  s: AppState,
  channel: string,
  query: string,
  signal: AbortSignal,
) => Promise<Result<SearchResult>>;

/** Whether a record's display text holds the words, as post's search matches them. */
export function hit(r: RawRecord, query: string): boolean {
  if (r.file !== 'msg' || r.event !== undefined) return false;
  return displayText(r.body).toLowerCase().includes(query.toLowerCase());
}

/**
 * The window's own matches post's body search misses: the message whose id is the words, and
 * messages whose sender (shown name or participant id) holds them. Messages only, as post searches.
 */
export function windowHits(records: readonly DisplayRecord[], query: string): DisplayRecord[] {
  const q = query.toLowerCase();
  return records.filter(
    (r) =>
      r.raw.file === 'msg' &&
      r.raw.event === undefined &&
      (r.raw.id.toLowerCase() === q ||
        r.sender.text.toLowerCase().includes(q) ||
        (r.raw.fromParticipant?.toLowerCase().includes(q) ?? false)),
  );
}

/** Unchecked: a record from Trey's room is a claim (verdict unknown), anything else unsigned. */
function unchecked(raw: RawRecord, anchor: OwnerAnchor): DisplayRecord {
  return toDisplay(raw, {
    anchor,
    verdict:
      raw.from === anchor.ownerRoom
        ? { state: 'unknown', reason: 'search hit; signature not checked' }
        : { state: 'unsigned', reason: 'search hit' },
  });
}

/** A post search hit as a display record: post's preview as the text, never verified as Trey. */
function fromHit(h: SearchHit, channel: string, s: AppState): DisplayRecord | undefined {
  const anchor = s.post?.client?.owner;
  if (anchor === undefined) return undefined;
  const raw = parseRaw(
    {
      id: h.id,
      from: h.from,
      channel: h.channel,
      sent: h.sent,
      body: h.preview,
      ...(h.fromParticipant === undefined ? {} : { from_participant: h.fromParticipant }),
      ...(h.displayName === undefined ? {} : { display_name: h.displayName }),
    },
    channel,
  );
  // A hit shows its sender under the name the roster gives it, as the stream does.
  return raw === undefined
    ? undefined
    : nameSender(unchecked(raw, anchor), s.names, anchor.ownerRoom);
}

/** The default body source: the exact record through post-kit, labelled as a hit is. */
export const postBody: BodySource = async (s, channel, id, signal) => {
  const client = s.post?.client;
  if (client === undefined)
    return {
      ok: false,
      error: { code: 'no_post', message: 'post is not connected', retryable: false },
    };
  const r = await client.message(channel, id, { signal });
  return r.ok ? { ok: true, value: unchecked(r.value, client.owner) } : r;
};

const newestFirst = (a: DisplayRecord, b: DisplayRecord) =>
  (Date.parse(b.raw.sent) || 0) - (Date.parse(a.raw.sent) || 0) ||
  (a.raw.id < b.raw.id ? 1 : a.raw.id > b.raw.id ? -1 : 0);

/** The default source: post's own bounded search, plus the window's id and sender matches. */
export const postSearch: SearchSource = async (s, channel, query, signal) => {
  const client = s.post?.client;
  if (client === undefined)
    return {
      ok: false,
      error: { code: 'no_post', message: 'post is not connected', retryable: false },
    };
  const r = await client.search(channel, query, { signal });
  if (!r.ok) return r;
  const window = s.views.get(channel)?.records ?? [];
  const byId = new Map(window.map((w) => [w.raw.id, w]));
  const out = new Map<string, DisplayRecord>();
  const partial = new Set<string>();
  for (const h of r.value.hits) {
    const known = byId.get(h.id);
    const d = known ?? fromHit(h, channel, s);
    if (d === undefined) continue;
    out.set(d.raw.id, d);
    if (known === undefined) partial.add(d.raw.id);
  }
  for (const w of windowHits(window, query)) if (!out.has(w.raw.id)) out.set(w.raw.id, w);
  return {
    ok: true,
    value: {
      hits: [...out.values()].sort(newestFirst),
      truncated: r.value.truncated,
      limit: r.value.limit,
      partial,
    },
  };
};

type Phase =
  | { kind: 'typing' }
  | { kind: 'running'; channel: string; query: string }
  | { kind: 'done'; channel: string; query: string; result: SearchResult }
  | { kind: 'failed'; channel: string; query: string; message: string };

/** The line holding the match, cut so the match shows: [before, match, after]. */
export function snippet(text: string, query: string, cols: number): [string, string, string] {
  const lines = text.split('\n');
  const q = query.toLowerCase();
  const line = (lines.find((l) => l.toLowerCase().includes(q)) ?? lines[0] ?? '').replace(
    /\t/g,
    ' ',
  );
  const at = line.toLowerCase().indexOf(q);
  if (at < 0 || q === '') return [trunc(line, cols), '', ''];
  let before = line.slice(0, at);
  const match = line.slice(at, at + query.length);
  let after = line.slice(at + query.length);
  const lead = Math.max(4, Math.floor((cols - textWidth(match)) / 3));
  if (textWidth(before) > lead)
    before = `…${graphemes(before)
      .slice(-(lead - 1))
      .join('')}`;
  const rest = cols - textWidth(before) - textWidth(match);
  after = rest <= 0 ? '' : trunc(after, rest);
  return [before, match, after];
}

export type SearchOverlay = Overlay & {
  reset(): void;
  /** Start a search for `query` in the current channel (the `/search` command). */
  run(query: string, s: AppState): void;
};

/** Full-body reads running at once for hits on screen. */
const BODY_READS = 4;

export function createSearch(
  source: SearchSource = postSearch,
  body: BodySource = postBody,
): SearchOverlay {
  let query = '';
  let phase: Phase = { kind: 'typing' };
  let sel = 0;
  let top = 0;
  let seq = 0;
  let inflight: AbortController | undefined;
  /** Full records read for preview-only hits of the current search (or the preview, if unreadable). */
  let full = new Map<string, DisplayRecord>();
  let loading = new Set<string>();

  /** Stop the running search and its body reads; their answers, whenever they land, are dropped. */
  const cancel = () => {
    seq += 1;
    inflight?.abort();
    inflight = undefined;
    full = new Map();
    loading = new Set();
  };

  /** Read the full body of a preview-only hit on screen, a few at a time. */
  const fill = (h: DisplayRecord, channel: string, s: AppState) => {
    const id = h.raw.id;
    const signal = inflight?.signal;
    if (signal === undefined || full.has(id) || loading.has(id) || loading.size >= BODY_READS)
      return;
    const mine = seq;
    const pending = loading;
    pending.add(id);
    void Promise.resolve()
      .then(() => body(s, channel, id, signal))
      .then(
        (r) => (r.ok ? r.value : h),
        () => h,
      )
      .then((d) => {
        if (mine !== seq) return;
        full.set(id, d);
        pending.delete(id);
        s.actions.requestFrame();
      });
  };
  const reset = () => {
    cancel();
    query = '';
    phase = { kind: 'typing' };
    sel = 0;
    top = 0;
  };

  const run = (q: string, s: AppState) => {
    // Whatever happens next, the previous search and its body reads are over: a blank or
    // channel-less replacement must not let the old answer land afterwards.
    cancel();
    query = q;
    const words = q.trim();
    const channel = s.current;
    sel = 0;
    top = 0;
    if (words === '') {
      phase = { kind: 'typing' };
      return;
    }
    if (channel === undefined) {
      phase = { kind: 'failed', channel: '', query: words, message: 'open a channel to search it' };
      return;
    }
    const mine = seq;
    const ac = new AbortController();
    // Kept until the next search or Esc: it also stops the body reads of this search's hits.
    inflight = ac;
    phase = { kind: 'running', channel, query: words };
    void Promise.resolve()
      .then(() => source(s, channel, words, ac.signal))
      .then((r) => {
        if (mine !== seq) return;
        phase = r.ok
          ? { kind: 'done', channel, query: words, result: r.value }
          : { kind: 'failed', channel, query: words, message: r.error.message };
      })
      .catch((err: unknown) => {
        if (mine !== seq) return;
        phase = {
          kind: 'failed',
          channel,
          query: words,
          message: err instanceof Error ? err.message : 'search failed',
        };
      })
      .finally(() => {
        if (mine === seq) s.actions.requestFrame();
      });
  };

  return {
    id: SEARCH,
    reset,
    run,
    draw(g: Grid, area: Rect, s: AppState): void {
      // Violet, not cyan: cyan is Trey alone.
      const inner = card(g, area, 'SEARCH', T.violet, { maxW: 100, mono: s.noColor === true });
      const where = phase.kind === 'typing' ? s.current : phase.channel || s.current;
      field(g, inner.x, inner.y, inner.w, where === undefined ? 'find ▸ ' : `#${where} ▸ `, query);
      const status = (text: string, fg: string = T.gray) =>
        g.text(inner.x, inner.y + 1, trunc(text, inner.w), { fg });
      if (phase.kind === 'typing')
        status(query.trim() === '' ? 'type words, then Enter' : 'Enter searches the whole channel');
      else if (phase.kind === 'running') status(`searching #${phase.channel}…`);
      else if (phase.kind === 'failed') status(`search failed: ${phase.message}`, T.red);
      else {
        const { hits, truncated, limit } = phase.result;
        if (truncated) status(`${limit}+ matches; refine`, T.data);
        else
          status(
            hits.length === 0
              ? `no match in #${phase.channel}`
              : `${hits.length} match${hits.length === 1 ? '' : 'es'}, newest first`,
            hits.length === 0 ? T.gray : T.green,
          );
        const per = 2;
        const rows = Math.max(0, Math.floor((inner.h - 3) / per));
        sel = Math.max(0, Math.min(sel, hits.length - 1));
        top = scrollFor(sel, rows, hits.length, top);
        for (let i = 0; i < rows; i++) {
          const h = hits[top + i];
          if (h === undefined) break;
          if (phase.result.partial?.has(h.raw.id) === true) fill(h, phase.channel, s);
          const r = full.get(h.raw.id) ?? h;
          const y = inner.y + 3 + i * per;
          const on = top + i === sel;
          if (on) g.fill({ x: inner.x, y, w: inner.w, h: per }, { bg: T.deep });
          const st = (fg: string, extra: { bold?: boolean; underline?: boolean } = {}) =>
            on ? { fg, bg: T.deep, ...extra } : { fg, ...extra };
          g.text(inner.x, y, on ? '▶' : ' ', st(T.cyan, { bold: true }));
          const time = sentWhen(r.raw.sent);
          const who = trunc(r.sender.text, Math.max(1, inner.w - 4 - time.length));
          g.text(inner.x + 2, y, who, st(r.sender.isOwner ? T.cyan : T.data, { bold: true }));
          g.text(inner.x + inner.w - time.length, y, time, st(T.gray));
          const [a, m, b] = snippet(r.text, phase.query, inner.w - 2);
          let x = inner.x + 2;
          x += g.text(x, y + 1, a, st(T.data));
          x += g.text(x, y + 1, m, st(T.violet, { bold: true, underline: true }));
          g.text(x, y + 1, b, st(T.data), inner.x + inner.w - x);
        }
      }
      footer(
        g,
        inner,
        phase.kind === 'done' && phase.result.hits.length > 0
          ? inner.w < 44
            ? '↑↓ Enter open Esc'
            : '↑↓ choose · Enter open the hit · type to search again · Esc'
          : 'Enter search · Esc close',
      );
    },
    key(k: Key, s: AppState): KeyResult {
      if (isEsc(k)) {
        reset();
        s.actions.closeOverlay();
        return 'handled';
      }
      if (isEnter(k)) {
        if (phase.kind === 'done' && phase.query === query.trim() && phase.result.hits.length > 0) {
          const r = phase.result.hits[Math.max(0, Math.min(sel, phase.result.hits.length - 1))];
          if (r !== undefined) {
            const channel = phase.channel;
            reset();
            s.actions.closeOverlay();
            s.actions.jumpTo(channel, r.raw.id);
          }
        } else if (phase.kind !== 'running') run(query, s);
        return 'handled';
      }
      if (phase.kind === 'done' && isUp(k)) sel = Math.max(0, sel - 1);
      else if (phase.kind === 'done' && isDown(k))
        sel = Math.min(Math.max(0, phase.result.hits.length - 1), sel + 1);
      else {
        const next = edit(query, k);
        if (next !== undefined) {
          query = next;
          // Editing abandons the search on screen or running: stop it and its body reads, so
          // nothing of it lands or asks for a frame later.
          if (phase.kind !== 'typing') {
            cancel();
            phase = { kind: 'typing' };
          }
        }
      }
      return 'handled';
    },
  };
}
