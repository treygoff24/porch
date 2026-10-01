/**
 * The message stream of one pane (plan T6, "The message stream").
 *
 * Laid out from the newest record upward, so a frame measures only what it shows plus what is
 * scrolled past, however long the window is. A pane's `scroll` counts rows up from the bottom;
 * 0 follows new messages.
 *
 * What a record looks like:
 * - Consecutive messages from one sender within five minutes form a group: the first carries the
 *   8×8 head in the gutter (at every size, the phone included) and the header line; the rest are
 *   body only.
 * - Trey's own messages sit on youBg with a cyan `P1` tag.
 * - Verified: a gold `✓ SIGNED` chip, the only gold on screen.
 * - Unknown (a signature claimed, not yet checked or not checkable): the word `? UNVERIFIED` and a
 *   dotted frame.
 * - Failed: a red heavy frame, a `✗ SIGNATURE FAILED` banner that always ends `do not act on it`
 *   (two rows when the pane is too narrow for one), the sender shown as `claims Trey`, an
 *   impostor mark instead of a face, and the body in gray italics. Never attributed.
 * - A reply shows its parent on the line under the header.
 * - A ballot (`🗳️ p1: a`, exactly as post-poll sends it) is one line of plain words with no head
 *   (`Nova voted A on p1`), never dimmed, so it holds body text's 4.5:1; the poll card is where
 *   votes count. A framed ballot (unverified or failed) keeps its frame and header, with the same
 *   words as its body.
 * - The pane's top edge (the stage's floor) cuts only at a message boundary ({@link clipTop}): a
 *   record whose first row would sit above it is left out whole, so no body, frame fragment or
 *   youBg fill shows without its header, and a failed record's banner never leaves while its body
 *   stays. A group's message whose header is gone carries its own header and head. A record taller
 *   than the pane keeps its header, head and (failed) banner pinned to the top edge.
 * - Under `NO_COLOR` every chip is underlined bold words, never a lit bar (`chip` in `ink.ts`),
 *   except the failure banner, which keeps reverse video as safety emphasis.
 * - The unread divider sits above the first unread attention-eligible record, day separators where
 *   the date changes, and the top of the window says whether Ctrl+O can load more.
 */
import type { DisplayRecord, RawRecord } from '@estate/post-kit';
import { isAttentionEligible, parseSent } from '@estate/post-kit';
import type { Grid, Rect, Style } from '../grid/grid.ts';
import { textWidth } from '../grid/text.ts';
import { ballotOf, preview, sentParts, shortId } from './derive.ts';
import { accentOf, headCells, hintOf, impostorCells, whoOf } from './heads.ts';
import { chip, clip, fitLabel, say, sayRight } from './ink.ts';
import { MAX_WINDOW } from './model.ts';
import { type MessageRenderer, rendererFor } from './registry.ts';
import { ballotWords, messageRenderer } from './renderers.ts';
import type { AppState, ChannelState, PaneState } from './state.ts';
import { K } from './theme.ts';

const GROUP_MS = 5 * 60 * 1000;
/** An 8×8 head is four terminal rows. */
const HEAD_ROWS = 4;

type RecordItem = {
  kind: 'record';
  r: DisplayRecord;
  /** First of its group: head, header and a gap row above. */
  lead: boolean;
};
type Item =
  | RecordItem
  | { kind: 'day'; day: string }
  | { kind: 'divider'; count: number }
  | { kind: 'top'; top: ChannelState['top'] };

export type StreamGeometry = {
  phone: boolean;
  /** Columns before the content: the head's gutter. */
  gutter: number;
};

/** The gutter holds the 8×8 head at every size: a column of margin, eight of head, one of air. */
export function geometry(phone: boolean): StreamGeometry {
  return { phone, gutter: 10 };
}

/**
 * The failed-signature banner's rows at `cols`: the whole warning when it fits, else without the
 * sender (the header names them), else on two rows. `do not act on it` is never clipped away.
 */
function bannerLines(r: DisplayRecord, cols: number): string[] {
  const full = `✗ SIGNATURE FAILED · ${r.sender.text} · do not act on it`;
  if (full.length <= cols) return [full];
  const short = '✗ SIGNATURE FAILED · do not act on it';
  if (short.length <= cols) return [short];
  return ['✗ SIGNATURE FAILED', 'do not act on it'];
}

/** Columns a failed banner's text gets inside a framed record `width` wide. */
function bannerCols(width: number, geo: StreamGeometry): number {
  return width - geo.gutter - 1 - 2 - 2;
}

type Frame = 'none' | 'dotted' | 'failed';

function frameOf(r: DisplayRecord): Frame {
  if (r.kind !== 'message') return 'none';
  if (r.verdict.state === 'failed') return 'failed';
  if (r.verdict.state === 'unknown') return 'dotted';
  return 'none';
}

/** Someone pretending to be Trey (his room, not shown as him): never his face or colour. */
function impostor(r: DisplayRecord, s: AppState): boolean {
  return r.raw.from === s.owner.room && !r.sender.isOwner;
}

function senderKey(r: DisplayRecord): string {
  return `${r.sender.isOwner ? 'owner' : 'x'}|${r.raw.from}|${r.raw.fromParticipant ?? ''}|${r.sender.text}`;
}

/** A ballot drawn as one line of words: unframed, not a reply, exactly the ballot form. */
function compactBallot(r: DisplayRecord): boolean {
  return (
    r.kind === 'message' &&
    r.raw.re === undefined &&
    (r.verdict.state === 'unsigned' || r.verdict.state === 'verified') &&
    ballotOf(r.text) !== undefined
  );
}

/** A record laid out as a message: head, header and body (a compact ballot is one line). */
function messageLike(r: DisplayRecord): boolean {
  return r.kind === 'message' && !compactBallot(r);
}

/** Does `r` continue the group `prev` started? */
function continues(prev: DisplayRecord | undefined, r: DisplayRecord): boolean {
  if (prev === undefined || !messageLike(r) || !messageLike(prev)) return false;
  if (frameOf(r) !== 'none' || frameOf(prev) !== 'none') return false;
  if (r.raw.re !== undefined || senderKey(prev) !== senderKey(r)) return false;
  if (r.verdict.state !== prev.verdict.state) return false;
  const a = parseSent(prev.raw.sent);
  const b = parseSent(r.raw.sent);
  return a !== undefined && b !== undefined && b - a >= 0 && b - a <= GROUP_MS;
}

/** The renderer that draws `r`'s body (a feature's when it matches, else the core's). */
function bodyRenderer(r: DisplayRecord): MessageRenderer {
  // A send not confirmed yet is plain words: no feature (an image, a poll) acts on it.
  if (r.pending === true) return messageRenderer;
  return rendererFor(r) ?? messageRenderer;
}

const heights = new Map<string, number>();

/**
 * Rows an item takes at `width`. The core's own layout of a message is cached; a feature's body
 * (an image, a poll card) can change height after it first draws (a raster decodes, a tally
 * loads), so a record a feature draws is measured afresh every frame.
 */
function measure(item: Item, width: number, geo: StreamGeometry): number {
  if (item.kind !== 'record') return 1;
  const r = item.r;
  if (r.kind !== 'message') return bodyRenderer(r).measure(r, width - geo.gutter - 1);
  if (compactBallot(r)) return 1;
  const renderer = bodyRenderer(r);
  const cacheable = renderer === messageRenderer;
  const key = `${r.raw.storageChannel}/${r.raw.id}|${width}|${r.verdict.state}|${item.lead}|${geo.gutter}|${r.raw.re ?? ''}`;
  const known = cacheable ? heights.get(key) : undefined;
  if (known !== undefined) return known;
  const frame = frameOf(r);
  const inner = width - geo.gutter - 1 - (frame === 'none' ? 0 : 2);
  const header = item.lead || frame !== 'none' ? 1 : 0;
  const reply = r.raw.re === undefined ? 0 : 1;
  const banner = frame === 'failed' ? bannerLines(r, bannerCols(width, geo)).length : 0;
  const body = Math.max(1, renderer.measure(r, Math.max(1, inner)));
  let rows = header + reply + banner + body + (frame === 'none' ? 0 : 2);
  rows += item.lead ? 1 : 0;
  if (!cacheable) return rows;
  if (heights.size > 20000) heights.clear();
  heights.set(key, rows);
  return rows;
}

/**
 * Items from the newest upward, made one at a time: a record, then whatever separates it from the
 * record before it (divider, day), and at the very top the window's edge.
 */
function* itemsUpward(view: ChannelState): Generator<Item> {
  // Sends not confirmed yet come after the newest record, each with its own header (`sending…`).
  const records = view.pending === undefined ? view.records : [...view.records, ...view.pending];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as DisplayRecord;
    const prev = records[i - 1];
    const day = sentParts(r.raw.sent).day;
    const newDay = prev === undefined || sentParts(prev.raw.sent).day !== day;
    const divider = view.divider === r.raw.id;
    const lead = r.pending === true || !(continues(prev, r) && !newDay && !divider);
    yield { kind: 'record', r, lead: messageLike(r) ? lead : false };
    if (divider) yield { kind: 'divider', count: view.newCount };
    if (newDay && day !== '') yield { kind: 'day', day };
  }
  yield { kind: 'top', top: view.top };
}

export type StreamResult = {
  /** Records with at least one row on screen, oldest first. */
  visible: RawRecord[];
  /** The scroll actually used (clamped to the content). */
  scroll: number;
};

/** Draw `pane`'s channel into `area`. */
export function drawStream(
  g: Grid,
  area: Rect,
  pane: PaneState,
  paneIndex: number,
  s: AppState,
  opts: { ensurePick: boolean },
): StreamResult {
  const view = pane.channel === undefined ? undefined : s.views.get(pane.channel);
  if (view === undefined) {
    drawEmpty(g, area, pane.channel, s);
    return { visible: [], scroll: 0 };
  }
  const geo = geometry(s.layout === 'phone');
  let scroll = pane.scroll;
  let placed = place(view, area, geo, s, scroll, opts.ensurePick ? pane.pick : undefined);
  if (opts.ensurePick && placed.pickAt !== undefined) {
    const [top, h] = placed.pickAt;
    // `top` counts rows up from the bottom to the item's top edge.
    const bottom = top - h;
    if (bottom < scroll) scroll = bottom;
    else if (top > scroll + area.h) scroll = top - area.h;
    scroll = Math.max(0, scroll);
    placed = place(view, area, geo, s, scroll, undefined);
  }
  scroll = placed.scroll;
  g.withClip(area, () => {
    // The row under the head the current group's lead drew: the head runs down beside the later
    // messages of its group, so their gutter belongs to it until then.
    let headEnd = area.y;
    for (const p of placed.items) {
      drawItem(
        g,
        p.item,
        { x: area.x, y: p.y, w: area.w, h: p.h },
        geo,
        pane,
        paneIndex,
        s,
        view,
        area.y,
        headEnd,
      );
      if (p.item.kind === 'record' && messageLike(p.item.r) && p.item.lead)
        headEnd = p.y + 1 + HEAD_ROWS;
    }
    if (scroll > 0 || view.detached) {
      const below = placed.newBelow;
      // A window held around a search hit is never the newest: Ctrl+G returns there.
      const label = view.detached
        ? ' ↓ newer messages · Ctrl+G '
        : below > 0
          ? ` ↓ ${below} new · Ctrl+G `
          : ' ↓ more below · Ctrl+G ';
      const y = area.y + area.h - 1;
      const x = sayRight(
        g,
        area.x + area.w - 1,
        y,
        label,
        chip(below > 0 ? K.green : K.gray, K.glass, s.noColor === true),
        area.x,
      );
      g.hit({ x, y, w: area.x + area.w - 1 - x, h: 1 }, { id: 'latest', data: paneIndex });
    }
  });
  return { visible: placed.visible, scroll };
}

type PlacedItem = { item: Item; y: number; h: number };

type Placed = {
  items: PlacedItem[];
  visible: RawRecord[];
  scroll: number;
  /** For the pick: rows from the bottom to the picked item's top, and its height. */
  pickAt: [number, number] | undefined;
  newBelow: number;
};

function place(
  view: ChannelState,
  area: Rect,
  geo: StreamGeometry,
  s: AppState,
  wantScroll: number,
  pickId: string | undefined,
): Placed {
  const out: { item: Item; b: number; h: number }[] = [];
  let b = 0; // rows from the content's bottom to the current item's bottom
  let pickAt: [number, number] | undefined;
  let exhausted = true;
  let newBelow = 0;
  const self = { room: s.owner.room, participant: s.owner.participant };
  const unreadFrom = view.divider;
  // Rows the rest of the current group takes below its first message: the head (four rows tall)
  // runs down beside them, so the group needs only enough rows in total.
  let groupBelow = 0;
  for (const item of itemsUpward(view)) {
    let h = measure(item, area.w, geo);
    // The pick must fit as clipTop would draw it at the top edge: a group's later message there
    // carries its own header and head, so it needs its height as a lead.
    let pickH = h;
    if (item.kind === 'record' && messageLike(item.r)) {
      if (item.lead) {
        h = Math.max(h, HEAD_ROWS + 1 - groupBelow);
        pickH = h;
        groupBelow = 0;
      } else {
        pickH = leadHeight(item, groupBelow, area.w, geo);
        groupBelow += h;
      }
    } else groupBelow = 0;
    if (item.kind === 'record' && item.r.raw.id === pickId) pickAt = [b + pickH, pickH];
    if (
      item.kind === 'record' &&
      b + h <= wantScroll &&
      unreadFrom !== undefined &&
      item.r.raw.id >= unreadFrom &&
      isAttentionEligible(item.r.raw, self)
    )
      newBelow += 1;
    if (b < wantScroll + area.h && b + h > wantScroll) out.push({ item, b, h });
    b += h;
    if (b >= wantScroll + area.h && (pickId === undefined || pickAt !== undefined)) {
      exhausted = false;
      break;
    }
  }
  const total = b;
  let scroll = wantScroll;
  if (exhausted && total < wantScroll + area.h) {
    // Scrolled past the top: hold the top edge at the top of the pane.
    scroll = Math.max(0, total - area.h);
    if (scroll !== wantScroll) return place(view, area, geo, s, scroll, pickId);
  }
  // Bottom-anchored, except a window shorter than the pane starts at its top.
  const base = exhausted && total <= area.h ? area.y + total : area.y + area.h + scroll;
  const items = clipTop(
    out.map((p) => ({ item: p.item, y: base - p.b - p.h, h: p.h })).reverse(),
    area,
    geo,
  );
  // What is acknowledged, picked or replied to is post's records; a pending send is none of them.
  const visible = items.flatMap((p) =>
    p.item.kind === 'record' && p.item.r.pending !== true ? [p.item.r.raw] : [],
  );
  return { items, visible, scroll, pickAt, newBelow };
}

/** Rows a group's later message takes drawn as its group's lead, with `below` rows of group under it. */
function leadHeight(item: RecordItem, below: number, width: number, geo: StreamGeometry): number {
  return Math.max(measure({ ...item, lead: true }, width, geo), HEAD_ROWS + 1 - below);
}

/**
 * Cut at a message boundary under the pane's top edge (`items` top-down, as placed). A record
 * whose first row (a framed record's top edge, else its header) would sit above `area.y` is left
 * out whole, and so is the next, until one starts on screen. A group's later message found there
 * has lost its header above the edge, so it is drawn as the group's lead (its own header, head
 * and gap row) when that still starts on screen. A record taller than the pane can never show
 * whole, so it stays cut while at least a head's height of it shows, and drawRecord pins its
 * header, head and banner to the edge; a thinner sliver of it is left out like any other. What is
 * left out leaves blank rows under the floor.
 */
/** A record too tall for the pane with room under the edge for its whole head, banner and header. */
function pinnable(y: number, h: number, area: Rect): boolean {
  return h > area.h && y + h - area.y >= HEAD_ROWS;
}

function clipTop(items: PlacedItem[], area: Rect, geo: StreamGeometry): PlacedItem[] {
  let k = 0;
  while (k < items.length) {
    const p = items[k] as PlacedItem;
    // One-row items (the window's top, a day, the divider) are whole whenever they are listed.
    if (p.item.kind !== 'record') break;
    const item = p.item;
    if (messageLike(item.r) && !item.lead) {
      let below = 0;
      for (const q of items.slice(k + 1)) {
        if (q.item.kind !== 'record' || !messageLike(q.item.r) || q.item.lead) break;
        below += q.h;
      }
      const h = leadHeight(item, below, area.w, geo);
      const y = p.y + p.h - h;
      if (y + 1 >= area.y || pinnable(y, h, area)) {
        items[k] = { item: { ...item, lead: true }, y, h };
        break;
      }
    } else if (p.y + (item.lead ? 1 : 0) >= area.y || pinnable(p.y, p.h, area)) break;
    k++;
  }
  return items.slice(k);
}

function drawEmpty(g: Grid, area: Rect, channel: string | undefined, s: AppState): void {
  const lines =
    channel === undefined
      ? s.channels.length === 0
        ? ['No channels are visible yet.', 'Porch is still looking.']
        : ['No channel is open.', 'Ctrl+K lists the channels you have joined.']
      : [`Loading #${channel}…`];
  lines.forEach((line, i) => {
    g.text(area.x + 2, area.y + 1 + i, clip(line, area.w - 4), { fg: i === 0 ? K.data : K.gray });
  });
}

function drawItem(
  g: Grid,
  item: Item,
  rect: Rect,
  geo: StreamGeometry,
  pane: PaneState,
  paneIndex: number,
  s: AppState,
  view: ChannelState,
  paneTop: number,
  headEnd: number,
): void {
  const maxX = rect.x + rect.w;
  if (item.kind === 'top') {
    const text =
      item.top === 'older'
        ? '⤒ Ctrl+O loads older messages'
        : item.top === 'full'
          ? `⤒ the newest ${MAX_WINDOW} are held · Ctrl+F searches older`
          : `⤒ beginning of #${view.name}`;
    say(
      g,
      rect.x + geo.gutter,
      rect.y,
      clip(text, rect.w - geo.gutter - 1),
      { fg: K.gray, italic: true },
      maxX,
    );
    if (item.top === 'older') g.hit(rect, { id: 'older', data: paneIndex });
    return;
  }
  if (item.kind === 'day') {
    const label = ` ${item.day} `;
    g.rule(rect.x + geo.gutter, rect.y, rect.w - geo.gutter - 1, '─', { fg: K.grayDim });
    say(g, rect.x + geo.gutter + 2, rect.y, label, { fg: K.gray }, maxX - 1);
    return;
  }
  if (item.kind === 'divider') {
    const label = geo.phone ? ` NEW · ${item.count} ` : ` NEW · ${item.count} UNREAD `;
    const tail = geo.phone ? ' ^U ' : ' Ctrl+U marks read ';
    g.rule(rect.x, rect.y, rect.w - 1, '─', { fg: K.violet });
    say(g, rect.x + 2, rect.y, label, chip(K.violet, K.glass, s.noColor === true), maxX);
    sayRight(g, maxX - 2, rect.y, tail, { fg: K.violet, bold: true }, rect.x);
    g.hit(rect, { id: 'ack', data: paneIndex });
    return;
  }
  drawRecord(g, item, rect, geo, pane, paneIndex, s, view, paneTop, headEnd);
}

function drawRecord(
  g: Grid,
  item: RecordItem,
  rect: Rect,
  geo: StreamGeometry,
  pane: PaneState,
  paneIndex: number,
  s: AppState,
  view: ChannelState,
  paneTop: number,
  headEnd: number,
): void {
  const r = item.r;
  const picked = pane.pick === r.raw.id;
  const top = rect.y + (item.lead ? 1 : 0);
  const rows = rect.h - (item.lead ? 1 : 0);
  const x0 = rect.x + geo.gutter;
  const maxX = rect.x + rect.w - 1;
  // No click target on a pending send: there is no real record to pick or reply to yet.
  if (r.pending !== true)
    g.hit(
      { x: rect.x, y: top, w: rect.w, h: rows },
      { id: 'record', data: { pane: paneIndex, id: r.raw.id } },
    );
  if (r.kind !== 'message') {
    bodyRenderer(r).draw(g, { x: x0, y: top, w: maxX - x0, h: rows }, r, s);
    if (picked) g.put(rect.x, top, '▶', { fg: K.cyan, bold: true });
    return;
  }
  if (compactBallot(r)) {
    // `Nova voted A on p1`: plain words, no head; the poll card is where the vote counts. Never
    // `dim`: the line carries content, so it keeps body text's 4.5:1 on the ground.
    const name = fitLabel(r.sender.text, Math.max(8, Math.floor((maxX - x0) / 2)));
    let x = say(g, x0, top, name, { fg: accentOf(whoOf(r, s), s) }, maxX);
    const hint = hintOf(r, s);
    if (hint !== undefined) x = say(g, x + 1, top, `· ${clip(hint, 24)}`, { fg: K.gray }, maxX);
    say(g, x + 1, top, ballotWords(r.text) ?? '', { fg: K.gray }, maxX);
    if (picked) g.put(rect.x, top, '▶', { fg: K.cyan, bold: true });
    return;
  }
  const frame = frameOf(r);
  const own = r.sender.isOwner;
  const fake = impostor(r, s);
  if (own) g.fill({ x: x0 - 1, y: top, w: maxX - x0 + 2, h: rows }, { bg: K.youBg });
  if (picked) {
    // The message's own rows only: a later message of a group has the group's head beside its
    // first rows (drawn before it), so past the margin column the fill starts under the head.
    g.fill({ x: rect.x, y: top, w: 1, h: rows }, { bg: K.bezel });
    const from = item.lead || frame !== 'none' ? top : Math.min(top + rows, Math.max(top, headEnd));
    g.fill({ x: rect.x + 1, y: from, w: geo.gutter - 2, h: top + rows - from }, { bg: K.bezel });
  }
  // The gutter: a head (or the impostor mark) for a group's first message, whole or not at all.
  if ((item.lead || frame !== 'none') && top >= paneTop)
    g.blit(
      rect.x + 1,
      top,
      fake || frame === 'failed' ? impostorCells(s.noColor === true) : headCells(whoOf(r, s), s),
    );
  if (picked) g.put(rect.x, top, '▶', { fg: K.cyan, bold: true, bg: K.bezel });
  let y = top;
  let cx = x0;
  let right = maxX;
  if (frame === 'dotted') {
    g.box({ x: x0 - 1, y, w: maxX - x0 + 2, h: rows }, 'dotted', { fg: K.gray });
    y += 1;
    cx = x0 + 1;
    right = maxX - 1;
  } else if (frame === 'failed') {
    g.box({ x: x0 - 1, y, w: maxX - x0 + 2, h: rows }, 'heavy', { fg: K.red, bold: true });
    y += 1;
    cx = x0 + 1;
    right = maxX - 1;
    y = drawBanner(g, r, cx, y, right, rect.w, geo);
  }
  if (item.lead || frame !== 'none') {
    drawHeader(g, r, cx, y, right, s, picked, paneIndex);
    y += 1;
  }
  if (r.raw.re !== undefined) {
    const parent = view.records.find((p) => p.raw.id === r.raw.re);
    const line =
      parent === undefined
        ? `↳ re ${shortId(r.raw.re)}`
        : `↳ re ${shortId(r.raw.re)} (${parent.sender.text}: ${preview(parent.text, 40)})`;
    say(g, cx, y, clip(line, right - cx), { fg: K.gray, italic: true }, right);
    y += 1;
  }
  const bodyRows = Math.max(1, top + rows - y - (frame === 'none' ? 0 : 1));
  bodyRenderer(r).draw(g, { x: cx, y, w: Math.max(1, right - cx), h: bodyRows }, r, s);
  // Only a record taller than the pane gets here with its first row above the top edge (clipTop
  // leaves out every other, and keeps this one only with a head's height on screen): pin what
  // names it to the edge, over the body rows scrolled under it, never past its own rows.
  if (top < paneTop)
    g.withClip({ x: rect.x, y: paneTop, w: rect.w, h: rect.y + rect.h - paneTop }, () => {
      let py = paneTop;
      if (frame === 'failed') {
        g.fill({ x: cx, y: py, w: right - cx, h: 1 }, {});
        py = drawBanner(g, r, cx, py, right, rect.w, geo);
      }
      g.fill({ x: cx, y: py, w: right - cx, h: 1 }, {});
      drawHeader(g, r, cx, py, right, s, picked, paneIndex);
      g.blit(
        rect.x + 1,
        paneTop,
        fake || frame === 'failed' ? impostorCells(s.noColor === true) : headCells(whoOf(r, s), s),
      );
    });
}

/**
 * The failed-signature banner from row `y`; returns the row after it. It keeps its red reverse
 * video under `NO_COLOR` too: the one chip exempt from the mono path (coordinator ruling, T9 fix
 * round 2), because a forged claim of Trey is the one thing on screen that must shout.
 */
function drawBanner(
  g: Grid,
  r: DisplayRecord,
  cx: number,
  y: number,
  right: number,
  width: number,
  geo: StreamGeometry,
): number {
  let row = y;
  for (const line of bannerLines(r, bannerCols(width, geo))) {
    g.fill({ x: cx, y: row, w: right - cx, h: 1 }, { bg: K.red });
    say(g, cx + 1, row, clip(line, right - cx - 2), { fg: K.glass, bg: K.red, bold: true }, right);
    row += 1;
  }
  return row;
}

function drawHeader(
  g: Grid,
  r: DisplayRecord,
  x: number,
  y: number,
  maxX: number,
  s: AppState,
  picked: boolean,
  paneIndex: number,
): void {
  const own = r.sender.isOwner;
  const phone = s.layout === 'phone';
  const mono = s.noColor === true;
  const { time } = sentParts(r.raw.sent);
  let showTime = time !== '';
  let cx = x;
  if (own) {
    cx = say(g, cx, y, ` P1 ${s.owner.label.toUpperCase()} `, chip(K.cyan, K.glass, mono), maxX);
  } else {
    const claim = r.raw.from === s.owner.room;
    const fg = claim ? K.red : accentOf(whoOf(r, s), s);
    // On the phone the label may take what the time, the verdict chip and a pick's reply button
    // leave; elsewhere half the line. A record claiming to be Trey keeps "claims <Trey>" whole:
    // the time gives way first, and the claim is never clipped.
    const chipCols = (verdictChip(r, mono)?.text.length ?? -1) + 1;
    const room = maxX - x - chipCols - (picked ? 12 : 0);
    let budget = phone ? room - (showTime ? time.length + 1 : 0) : Math.floor((maxX - x) / 2);
    const whole = textWidth(r.sender.text);
    if (claim && whole > budget) {
      if (phone && showTime) {
        showTime = false;
        budget = room;
      }
      budget = Math.max(budget, whole);
    }
    cx = say(g, cx, y, fitLabel(r.sender.text, Math.max(8, budget)), { fg, bold: true }, maxX);
    // Two participants of one name: the directory (or the id's tail) in gray, in what the line
    // leaves after the time, the verdict and the `#id`; with no room for a useful stretch, none.
    const hint = hintOf(r, s);
    if (hint !== undefined) {
      const after =
        (showTime ? time.length + 1 : 0) + chipCols + (phone ? 0 : 9) + (picked ? 12 : 0);
      const room = Math.min(maxX - cx - 1 - after, 40);
      if (room >= 8) cx = say(g, cx + 1, y, `· ${clip(hint, room - 2)}`, { fg: K.gray }, maxX);
    }
  }
  if (showTime) cx = say(g, cx + 1, y, time, { fg: K.gray }, maxX);
  if (r.pending === true) {
    // Not post's yet: no id, no verdict, just the word that says so (gray, never dimmer: it is read).
    say(g, cx + 1, y, 'sending…', { fg: K.gray, italic: true }, maxX);
    return;
  }
  const verdict = verdictChip(r, mono);
  if (verdict !== undefined) cx = say(g, cx + 1, y, verdict.text, verdict.style, maxX);
  if (!phone) cx = say(g, cx + 1, y, `#${shortId(r.raw.id)}`, { fg: K.gray }, maxX);
  if (picked) {
    const label = ' [r] reply ';
    const bx = sayRight(g, maxX, y, label, chip(K.cyan, K.glass, mono), cx + 1);
    g.hit(
      { x: bx, y, w: maxX - bx, h: 1 },
      { id: 'reply', data: { pane: paneIndex, id: r.raw.id } },
    );
  }
}

/** The verification word for a header. Unsigned shows nothing; failed has its own banner. */
function verdictChip(r: DisplayRecord, mono: boolean): { text: string; style: Style } | undefined {
  switch (r.verdict.state) {
    case 'verified':
      return { text: ' ✓ SIGNED ', style: chip(K.gold, K.glass, mono) };
    case 'unknown':
      return { text: '? UNVERIFIED', style: { fg: K.gray, bold: true } };
    case 'failed':
      return { text: '✗ FAILED', style: { fg: K.red, bold: true } };
    default:
      return undefined;
  }
}
