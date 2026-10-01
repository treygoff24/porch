/**
 * A test rig for the stage and overlays: a real `AnimationClock` on hand-stepped timers, and an
 * `AppState` built the way the core builds one (every field, actions that record what they were
 * asked), so frame tests step the clock deterministically and read the grid as text.
 *
 * The rig stands in for the app core (T6), which is built in parallel: it lays out a score-bar row,
 * each pane's stage strip at the height the stage asks for, and the overlay or attract screen on
 * top, which is the order the registry documents. It does not imitate the core's stream.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AvatarPack, freezeEmote, parseAvatar } from '@estate/pixel';
import {
  type ChannelSummary,
  type DisplayRecord,
  type OwnerAnchor,
  parseRaw,
  toDisplay,
  type Verdict,
} from '@estate/post-kit';
import type { Overlay, Stage, StageFit } from '../../src/app/registry.ts';
import type {
  AppActions,
  AppState,
  ChannelState,
  LayoutKind,
  MotionMode,
  PaneState,
} from '../../src/app/state.ts';
import { MONO_LIGHT, monochrome } from '../../src/grid/color.ts';
import { Grid, scanlines } from '../../src/grid/grid.ts';
import { AnimationClock, type Timers } from '../../src/host/animation-clock.ts';

export const GROUND = scanlines('#05080b', '#0a0f14');

/** Hand-stepped timers: nothing fires until the test says so. */
export class StepTimers implements Timers {
  t = 0;
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; at: number }>();
  now = (): number => this.t;
  setInterval = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { fn, at: this.t + ms });
    return id;
  };
  clearInterval = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  /** Fire the earliest timer, moving time to it. False when none is pending. */
  step(): boolean {
    let best: [number, { fn: () => void; at: number }] | undefined;
    for (const e of this.pending) if (best === undefined || e[1].at < best[1].at) best = e;
    if (best === undefined) return false;
    this.pending.delete(best[0]);
    this.t = Math.max(this.t, best[1].at);
    best[1].fn();
    return true;
  }
}

/** Wall-clock timers for the stage's idle check, stepped by hand too. */
export class IdleSteps {
  t = 1_000_000;
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; at: number }>();
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.set(id, { fn, at: this.t + ms });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  /** Move time on by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let best: [number, { fn: () => void; at: number }] | undefined;
      for (const e of this.pending)
        if (e[1].at <= end && (best === undefined || e[1].at < best[1].at)) best = e;
      if (best === undefined) break;
      this.pending.delete(best[0]);
      this.t = best[1].at;
      best[1].fn();
    }
    this.t = end;
  }
}

export const OWNER = { room: 'trey', participant: 'porch-trey', label: 'Trey', marker: '🦊' };
export const ANCHOR: OwnerAnchor = {
  ownerRoom: OWNER.room,
  sidecarDir: '/nonexistent',
  allowedSigners: '/nonexistent',
  namespace: 'porch',
  principal: 'trey@porch',
  marker: OWNER.marker,
  label: OWNER.label,
};

const examples = join(process.cwd(), 'packages', 'pixel', 'examples');
export function example(name: string): AvatarPack {
  const r = parseAvatar(readFileSync(join(examples, `${name}.json`)));
  if (r.pack === null) throw new Error(`${name}: ${r.rules.join(', ')}`);
  return r.pack;
}

/** The crew used across stage tests: participant id → room and example pack. */
export const CREW = {
  bolt: { id: 'p-bolt', room: 'bolt', name: 'Bolt' },
  wisp: { id: 'p-wisp', room: 'wisp', name: 'Wisp' },
  mochi: { id: 'p-mochi', room: 'mochi', name: 'Mochi' },
  ribbit: { id: 'p-ribbit', room: 'ribbit', name: 'Ribbit' },
  blob: { id: 'p-blob', room: 'blob', name: 'Blob' },
} as const;
export type CrewName = keyof typeof CREW;

let serial = 0;
/** A post message id, increasing with each call (bytewise order is time order). */
export function nextId(): string {
  serial += 1;
  return `20260930-230000-${String(serial).padStart(6, '0')}-abcdef`;
}

export function message(
  who: CrewName | 'trey',
  body: string,
  opts: {
    channel?: string;
    id?: string;
    verdict?: Verdict;
    extra?: Record<string, unknown>;
    /** Written from this room and participant instead of the sender's own (a spoof). */
    as?: { room: string; id: string };
  } = {},
): DisplayRecord {
  const channel = opts.channel ?? 'commons';
  const sender =
    opts.as ??
    (who === 'trey'
      ? { room: OWNER.room, id: OWNER.participant }
      : { room: CREW[who].room, id: CREW[who].id });
  const raw = parseRaw(
    {
      id: opts.id ?? nextId(),
      from: sender.room,
      channel,
      sent: '2026-09-30T23:00:00Z',
      body,
      from_participant: sender.id,
      ...(opts.extra ?? {}),
    },
    channel,
  );
  if (raw === undefined) throw new Error('record did not parse');
  return toDisplay(raw, {
    anchor: ANCHOR,
    ...(opts.verdict === undefined ? {} : { verdict: opts.verdict }),
  });
}

/** An emote record as post writes one: the sender's emote frozen from its pack (I1 "Freeze"). */
export function emote(
  who: CrewName | 'trey',
  name: string,
  opts: {
    channel?: string;
    at?: string;
    payload?: unknown;
    /** The verdict post-kit gave it (default: unsigned, as an emote is). */
    verdict?: Verdict;
    /** Written from this room and participant instead of the sender's own (a spoof). */
    as?: { room: string; id: string };
  } = {},
): DisplayRecord {
  const channel = opts.channel ?? 'commons';
  const pack = who === 'trey' ? example('trey') : example(who);
  const frozen = freezeEmote(pack, name);
  if (frozen === null && opts.payload === undefined) throw new Error(`${who} cannot ${name}`);
  const payload = opts.payload ?? {
    ...frozen?.emote,
    ...(opts.at === undefined ? {} : { at: opts.at }),
  };
  const sender =
    opts.as ??
    (who === 'trey'
      ? { room: OWNER.room, id: OWNER.participant }
      : { room: CREW[who].room, id: CREW[who].id });
  const raw = parseRaw(
    {
      id: nextId(),
      from: sender.room,
      channel,
      sent: '2026-09-30T23:00:00Z',
      from_participant: sender.id,
      event: 'emote',
      emote: payload,
      body: '',
    },
    channel,
    { file: 'emote' },
  );
  if (raw === undefined) throw new Error('emote record was omitted');
  return toDisplay(raw, {
    anchor: ANCHOR,
    verdict: opts.verdict ?? { state: 'unsigned', reason: 'emote' },
  });
}

export function summary(
  name: string,
  members: readonly string[],
  extra: Partial<ChannelSummary> = {},
): ChannelSummary {
  return {
    name,
    unread: 0,
    messages: 0,
    members: [],
    participants: [...members],
    description: undefined,
    archived: false,
    ...extra,
  };
}

export function channelState(
  name: string,
  records: readonly DisplayRecord[],
  extra: Partial<ChannelState> = {},
): ChannelState {
  return {
    name,
    summary: undefined,
    records,
    acknowledged: undefined,
    divider: undefined,
    newCount: 0,
    needsYou: false,
    trend: 'flat',
    top: 'beginning',
    detached: false,
    error: undefined,
    ...extra,
  };
}

export type Call = { action: keyof AppActions; args: unknown[] };

/**
 * One app in a test: mutable inputs, a snapshot builder, and a frame drawer. `clock` is real; its
 * timers are stepped by hand.
 */
export class Rig {
  readonly timers = new StepTimers();
  readonly calls: Call[] = [];
  frames = 0;
  ticks: number[] = [];
  channels: ChannelSummary[] = [];
  views = new Map<string, ChannelState>();
  panes: PaneState[] = [{ channel: 'commons', scroll: 0, pick: undefined }];
  avatars = new Map<string, AvatarPack>();
  names = new Map<string, string>();
  motion: MotionMode = 'full';
  draft = '';
  overlay: string | undefined;
  current: string | undefined = 'commons';
  ownMessageIds = new Set<string>();
  readonly clock: AnimationClock;

  constructor() {
    this.clock = new AnimationClock({
      timers: this.timers,
      onTick: (now) => {
        this.ticks.push(now);
      },
    });
  }

  private record =
    (action: keyof AppActions) =>
    (...args: unknown[]) => {
      this.calls.push({ action, args });
    };

  readonly actions: AppActions = {
    openChannel: this.record('openChannel'),
    jumpTo: this.record('jumpTo'),
    openOverlay: (id: string) => {
      this.calls.push({ action: 'openOverlay', args: [id] });
      this.overlay = id;
    },
    closeOverlay: () => {
      this.calls.push({ action: 'closeOverlay', args: [] });
      this.overlay = undefined;
    },
    setDraft: this.record('setDraft'),
    appendImagePath: this.record('appendImagePath'),
    insert: this.record('insert'),
    replyTo: this.record('replyTo'),
    pick: this.record('pick'),
    status: this.record('status'),
    animate: (ms: number) => this.clock.burst(ms),
    requestFrame: () => {
      this.frames += 1;
    },
    quit: this.record('quit'),
  };

  /** A crew member in the channel's member list, with its example avatar and profile name. */
  join(who: CrewName, channel = 'commons', avatar = true): void {
    const c = CREW[who];
    if (avatar) this.avatars.set(c.id, example(who));
    this.names.set(c.id, c.name);
    const s = this.channels.find((x) => x.name === channel);
    if (s === undefined) this.channels.push(summary(channel, [OWNER.participant, c.id]));
    else if (!s.participants.includes(c.id))
      this.channels = this.channels.map((x) =>
        x.name === channel ? { ...x, participants: [...x.participants, c.id] } : x,
      );
    // The core keeps post's listing on the view once listed; an empty listed channel is loaded.
    const view = this.views.get(channel) ?? channelState(channel, []);
    this.views.set(channel, { ...view, summary: this.channels.find((x) => x.name === channel) });
  }

  /** Put records in a channel's loaded window (already there: history). */
  load(channel: string, records: readonly DisplayRecord[]): void {
    const view = this.views.get(channel) ?? channelState(channel, []);
    this.views.set(channel, { ...view, records: [...view.records, ...records] });
  }

  state(cols = 100, rows = 32, overrides: Partial<AppState> = {}): AppState {
    const layout: LayoutKind = cols < 60 ? 'phone' : cols < 140 ? 'laptop' : 'wide';
    return {
      owner: OWNER,
      channels: this.channels,
      views: this.views,
      current: this.current,
      panes: this.panes,
      focusedPane: 0,
      split: this.panes.length > 1,
      layout,
      cols,
      rows,
      composer: { text: this.draft, caret: this.draft.length, revision: 0, replyTo: undefined },
      mode: 'casual',
      armed: false,
      signingBlocked: undefined,
      sending: false,
      crossed: undefined,
      overlay: this.overlay,
      notice: undefined,
      avatars: this.avatars,
      names: this.names,
      hints: () => new Map(),
      motion: this.motion,
      focused: true,
      now: this.clock.now(),
      ownMessageIds: this.ownMessageIds,
      actions: this.actions,
      post: undefined,
      ...overrides,
    };
  }

  /**
   * One frame the way the core composes it: a score-bar row, each pane's stage strip under it at
   * the height the stage asks for (panes side by side when split), then the open overlay, then the
   * stage's over-everything layer.
   */
  draw(
    stage: Stage,
    cols: number,
    rows: number,
    opts: {
      fit?: StageFit;
      overlays?: ReadonlyMap<string, Overlay>;
      state?: AppState;
      /** Draw into this grid (a host's) instead of a fresh one. */
      grid?: Grid;
    } = {},
  ): Grid {
    const s = opts.state ?? this.state(cols, rows);
    const g = opts.grid ?? new Grid(cols, rows, GROUND);
    g.text(0, 0, `1UP ${OWNER.label}`, { fg: '#3fd9f2', bold: true });
    const fit = opts.fit ?? 'bodies';
    const h = stage.height(fit);
    const w = Math.floor(cols / this.panes.length);
    this.panes.forEach((p, i) => {
      stage.draw(
        g,
        { x: i * w, y: 1, w: i === this.panes.length - 1 ? cols - i * w : w, h },
        { channel: p.channel, fit, focused: i === 0 },
        s,
      );
    });
    const open = s.overlay === undefined ? undefined : opts.overlays?.get(s.overlay);
    open?.draw(g, { x: 0, y: 0, w: cols, h: rows }, s);
    stage.drawOver?.(g, { x: 0, y: 0, w: cols, h: rows }, s);
    return g;
  }

  /** Step the clock's timer once; the sample time, or undefined when no timer is pending. */
  tick(): number | undefined {
    const before = this.ticks.length;
    if (!this.timers.step()) return undefined;
    return this.ticks.length > before ? this.ticks.at(-1) : this.timers.t;
  }
}

/** The grid's rows as text. */
export const lines = (g: Grid): string[] => g.toText().split('\n');

/**
 * What a NO_COLOR terminal shows: each cell through the host's own monochrome mapping. Text whose
 * ink lands on its background's shade is drawn blank. Pixel cells (half and full blocks) are drawn
 * by the shades a viewer sees: `█` both halves lit, `▀`/`▄` one lit, blank neither. `text` is the
 * visible frame; `key` is every displayed cell (glyph, shade pair, attributes), to tell two frames
 * apart in monochrome.
 */
export function monoView(g: Grid): { text: string; key: string } {
  const rows: string[][] = [];
  const key: string[] = [];
  g.forEachCell((c, x, y) => {
    const { fg, bg } = monochrome(c.fg, c.bg, c.ch);
    const lit = (hex: string) => hex === MONO_LIGHT;
    let shown: string;
    if (c.ch === '▀' || c.ch === '▄' || c.ch === '█') {
      const top = lit(c.ch === '▄' ? bg : fg);
      const bottom = lit(c.ch === '▀' ? bg : fg);
      shown = top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    } else shown = fg === bg ? ' ' : c.ch;
    const row = rows[y] ?? [];
    rows[y] = row;
    row[x] = shown;
    key.push(
      `${x},${y}:${c.ch}${fg}${bg}${c.bold ? 'b' : ''}${c.dim ? 'd' : ''}${c.underline ? 'u' : ''}${c.italic ? 'i' : ''}`,
    );
  });
  return {
    text: rows.map((r) => Array.from(r, (ch) => ch ?? '').join('')).join('\n'),
    key: key.join('|'),
  };
}

/** The cells of a rect as text rows (for comparing sprites). */
export function region(g: Grid, x: number, y: number, w: number, h: number): string[] {
  const out: string[] = [];
  for (let yy = y; yy < y + h; yy++) {
    let row = '';
    for (let xx = x; xx < x + w; xx++) {
      const c = g.at(xx, yy);
      row += c === undefined ? '' : `${c.ch}${c.fg}${c.bg}|`;
    }
    out.push(row);
  }
  return out;
}
