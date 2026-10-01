/**
 * Headless app worlds for frame tests: the real `AppModel`, view and key table, over a fake post
 * source that holds records in memory. The fake's `acknowledge` follows the store's rule exactly
 * (post-kit's `newestEligible` over what the pane shows), and records are parsed by post-kit's own
 * `parseRaw`, so what the screen gets has production's shape.
 *
 * A frame is drawn the way the host draws one: into a fresh `Grid` on the app's ground, with a host
 * whose clock is pinned, so the same world always draws the same cells.
 */
import {
  type ChannelSummary,
  type ChannelView,
  newestEligible,
  type OwnerAnchor,
  type PostState,
  parseRaw,
  type RawRecord,
  type Result,
  type SendOutcome,
  type SendRequest,
  type Verdict,
} from '@estate/post-kit';
import { bindCommands, registerCoreCommands } from '../../src/app/commands.ts';
import { dispatchKey } from '../../src/app/keys.ts';
import { AppModel, type ModelDeps, type PostSource } from '../../src/app/model.ts';
import { Grid } from '../../src/grid/grid.ts';
import type { HostApi } from '../../src/host/grid-host.ts';
// The core's own renderers only: core tests register stand-in stages and overlays, and the real
// plug-ins (plugins.ts) load through boot in the PTY tests and in test/app/integrated.test.ts.
import '../../src/app/renderers.ts';
import type { Key } from '../../src/app/registry.ts';
import { GROUND } from '../../src/app/theme.ts';
import { drawScreen } from '../../src/app/view.ts';

export const OWNER = {
  room: 'mara',
  participant: 'porch-7f3a9c',
  label: 'Mara',
  marker: '🦊',
} as const;

export const ANCHOR: OwnerAnchor = {
  ownerRoom: 'mara',
  sidecarDir: '/nonexistent/mara',
  allowedSigners: '/nonexistent/mara/allowed_signers',
  namespace: 'mara-porch',
  principal: 'mara@porch',
  marker: '🦊',
  label: 'Mara',
};

/** The three sizes the design is judged at. */
export const SIZES = [
  { name: 'phone', cols: 40, rows: 52 },
  { name: 'laptop', cols: 100, rows: 32 },
  { name: 'wide', cols: 160, rows: 44 },
] as const;

/** 2026-09-30 21:00:00 UTC plus `minutes`, as post writes `sent`. */
export function at(minutes: number): string {
  return new Date(Date.UTC(2026, 8, 30, 21, 0, 0) + minutes * 60_000).toISOString();
}

/** A post id for `minutes` past the base time and a sequence number (ids sort by time). */
export function idAt(minutes: number, seq = 0): string {
  const d = new Date(Date.UTC(2026, 8, 30, 21, 0, 0) + minutes * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  // The last segment is what a short id shows: unique per minute and sequence, as post's are.
  const tail = ((minutes + 100_000) * 64 + seq).toString(16).padStart(6, '0');
  return `${stamp}-${p(seq, 6)}-${tail}`;
}

export type RecordSpec = {
  minutes: number;
  seq?: number;
  from?: string;
  body?: string;
  participant?: string;
  lineage?: string;
  name?: string;
  re?: string;
  event?: string;
  /** A v2 signature reference (the record claims a signature). */
  signed?: boolean;
  emote?: string;
  channel?: string;
};

/** A record as post-kit parses one from post's JSON. */
export function record(spec: RecordSpec): RawRecord {
  const channel = spec.channel ?? 'commons';
  const raw: Record<string, unknown> = {
    id: idAt(spec.minutes, spec.seq ?? 0),
    from: spec.from ?? 'crew',
    channel,
    sent: at(spec.minutes),
    body: spec.body ?? '',
  };
  if (spec.participant !== undefined) raw.from_participant = spec.participant;
  else if ((spec.from ?? 'crew') === 'crew') raw.from_participant = 'test-bolt01';
  if (spec.lineage !== undefined) raw.from_lineage = spec.lineage;
  if (spec.name !== undefined) raw.display_name = spec.name;
  else if ((spec.from ?? 'crew') === 'crew') raw.display_name = 'Bolt';
  if (spec.re !== undefined) raw.re = spec.re;
  if (spec.event !== undefined) raw.event = spec.event;
  if (spec.signed === true) raw.signature_ref = { version: 2, tag: '20260930T230000Z' };
  if (spec.emote !== undefined) {
    raw.event = 'emote';
    raw.emote = { name: spec.emote };
  }
  const r = parseRaw(raw, channel, spec.emote === undefined ? {} : { file: 'emote' });
  if (r === undefined) throw new Error('test record failed to parse');
  return r;
}

export function summary(name: string, extra: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    name,
    unread: 0,
    messages: undefined,
    members: ['mara', 'crew'],
    participants: [OWNER.participant, 'test-bolt01'],
    description: undefined,
    archived: false,
    ...extra,
  };
}

/** Post state in memory, with the store's acknowledge rule. */
export class FakeSource implements PostSource {
  state: PostState;
  /** Every channel's full record list; a view holds the newest `window` of it. */
  readonly all = new Map<string, RawRecord[]>();
  readonly acks: { channel: string; id: string }[] = [];
  readonly opened = new Set<string>();
  /** Each open channel's polling cadence, as the store keeps it: true is the background cycle. */
  readonly background = new Map<string, boolean>();
  private listeners = new Set<() => void>();
  private seen = new Set<(channel: string, id: string, participant: string) => void>();
  constructor(
    channels: ChannelSummary[],
    readonly window = 200,
  ) {
    this.state = { channels, views: {} };
  }
  /** Set `channel`'s records (and its view, when open) and tell the app. */
  setRecords(channel: string, records: RawRecord[], verdicts: Record<string, Verdict> = {}): void {
    this.all.set(channel, records);
    if (this.opened.has(channel)) this.load(channel, verdicts);
    this.emit();
  }
  setChannels(channels: ChannelSummary[]): void {
    this.state = { ...this.state, channels };
    this.emit();
  }
  setVerdicts(channel: string, verdicts: Record<string, Verdict>): void {
    const view = this.state.views[channel];
    if (view === undefined) return;
    this.setView(channel, { ...view, verdicts: { ...view.verdicts, ...verdicts } });
    this.emit();
  }
  private load(channel: string, verdicts: Record<string, Verdict> = {}): void {
    const records = (this.all.get(channel) ?? []).slice(-this.window);
    const old = this.state.views[channel];
    this.setView(channel, {
      records,
      verdicts: { ...(old?.verdicts ?? {}), ...verdicts },
      ...(old?.acknowledged === undefined ? {} : { acknowledged: old.acknowledged }),
    });
  }
  private setView(channel: string, view: ChannelView): void {
    this.state = { ...this.state, views: { ...this.state.views, [channel]: view } };
  }
  emit(): void {
    for (const l of this.listeners) l();
  }
  getState = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  onSeen(l: (channel: string, id: string, participant: string) => void) {
    this.seen.add(l);
    return () => this.seen.delete(l);
  }
  /** As the store reports it: `participant` is now in post's seen set for `id`. */
  markSeen(channel: string, id: string, participant: string): void {
    for (const l of this.seen) l(channel, id, participant);
  }
  async open(channel: string, opts: { background?: boolean } = {}): Promise<void> {
    this.opened.add(channel);
    this.background.set(channel, opts.background === true);
    this.load(channel);
    this.emit();
  }
  /** Like the store: a channel that is not open has no cadence to change. */
  setBackground(channel: string, background: boolean): void {
    if (this.opened.has(channel)) this.background.set(channel, background);
  }
  isOpen(channel: string): boolean {
    return this.opened.has(channel);
  }
  async acknowledge(
    channel: string,
    visible: readonly RawRecord[],
  ): Promise<Result<{ advanced: boolean }>> {
    const target = newestEligible(visible, { room: OWNER.room, participant: OWNER.participant });
    if (target === undefined)
      return {
        ok: false,
        error: { code: 'nothing_to_mark', message: 'nothing here to mark read', retryable: false },
      };
    this.acks.push({ channel, id: target.id });
    return { ok: true, value: { advanced: true } };
  }
  async refreshChannels(): Promise<void> {}
  /** Every channel `refreshChannel` was asked for, and what to do when it is (a test's hook). */
  readonly refreshed: string[] = [];
  onRefresh: ((channel: string) => void | Promise<void>) | undefined;
  async refreshChannel(channel: string): Promise<void> {
    this.refreshed.push(channel);
    await this.onRefresh?.(channel);
  }
  trackConfirmed(): void {}
  async regainFocus(): Promise<void> {}
  dispose(): void {}
}

/** A host with a pinned clock that records what was asked of it. */
export class StillHost implements HostApi {
  time = 0;
  frames = 0;
  quits = 0;
  bursts: number[] = [];
  requestFrame(): void {
    this.frames += 1;
  }
  animate(ms: number) {
    this.bursts.push(ms);
    const start = Math.ceil(this.time / 125) * 125;
    return { start, end: start + Math.ceil(ms / 125) * 125, cancel: () => {} };
  }
  now(): number {
    return this.time;
  }
  focused(): boolean {
    return true;
  }
  quit(): void {
    this.quits += 1;
  }
}

export type App = {
  m: AppModel;
  source: FakeSource;
  host: StillHost;
  sends: SendRequest[];
};

export type AppOptions = Partial<Omit<ModelDeps, 'source' | 'owner' | 'anchor'>> & {
  channels?: ChannelSummary[];
  records?: Record<string, RawRecord[]>;
  verdicts?: Record<string, Record<string, Verdict>>;
  /** What the send transaction answers (default: confirmed with a fresh id). */
  outcome?: (req: SendRequest) => SendOutcome | Promise<SendOutcome>;
  launch?: string;
  window?: number;
  /** Trey's display label (default 'Mara'). */
  ownerLabel?: string;
};

/** A started app over a fake source. */
export async function makeApp(opts: AppOptions = {}): Promise<App> {
  const channels = opts.channels ?? [summary('commons'), summary('ops')];
  const source = new FakeSource(channels, opts.window ?? 200);
  for (const [ch, rs] of Object.entries(opts.records ?? {})) source.all.set(ch, rs);
  const sends: SendRequest[] = [];
  let n = 0;
  const host = new StillHost();
  const {
    channels: _c,
    records: _r,
    verdicts,
    outcome,
    launch,
    window: _w,
    ownerLabel,
    ...rest
  } = opts;
  const label = ownerLabel ?? OWNER.label;
  const m = new AppModel({
    owner: { ...OWNER, label },
    anchor: { ...ANCHOR, label },
    source,
    armed: false,
    motion: 'full',
    wallClock: () => Date.parse(at(60)),
    send: async (req) => {
      sends.push(req);
      if (outcome !== undefined) return outcome(req);
      n += 1;
      return { kind: 'confirmed', id: idAt(70, n) };
    },
    ...rest,
  });
  registerCoreCommands();
  bindCommands(m);
  m.attach(host);
  await m.start(launch, 'commons');
  for (const [ch, v] of Object.entries(verdicts ?? {})) source.setVerdicts(ch, v);
  return { m, source, host, sends };
}

/** Draw one frame at `cols` by `rows`. */
export function frame(app: App, cols: number, rows: number): Grid {
  const g = new Grid(cols, rows, GROUND);
  app.m.attach(app.host);
  drawScreen(g, app.m);
  return g;
}

export function lines(g: Grid): string[] {
  return g
    .toText()
    .split('\n')
    .map((l) => l.trimEnd());
}

/** Where `text` first appears on screen (its first cell's column and row), or undefined. */
export function find(g: Grid, text: string): { x: number; y: number } | undefined {
  for (let y = 0; y < g.rows; y++) {
    let row = '';
    const column: number[] = [];
    for (let x = 0; x < g.cols; x++) {
      const cell = g.at(x, y);
      if (cell === undefined || cell.w === 0) continue;
      for (let k = 0; k < cell.ch.length; k++) column.push(x);
      row += cell.ch;
    }
    const i = row.indexOf(text);
    if (i !== -1) return { x: column[i] ?? 0, y };
  }
  return undefined;
}

/** A key, as the table sees one. */
export function key(
  name: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): Key {
  const k: Key = {
    name,
    ctrl: mods.ctrl ?? false,
    alt: mods.alt ?? false,
    shift: mods.shift ?? false,
  };
  if (!k.ctrl && !k.alt && [...name].length === 1) k.text = name;
  return k;
}

/** Type `text` key by key. */
export function type(app: App, text: string): void {
  for (const ch of text) dispatchKey(app.m, key(ch === ' ' ? 'space' : ch));
}

export function press(app: App, k: Key): boolean {
  return dispatchKey(app.m, k);
}

/** Let queued promises settle (the model's async actions). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}
