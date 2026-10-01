/**
 * The app's controller: everything Porch knows and does between frames (plan T6, "State model").
 *
 * It reads post through post-kit's store (`markReadOnView: false`, so a read never acknowledges),
 * sends only through the send transaction, keeps one draft per channel, and builds one immutable
 * `AppState` per change for the frame and for every plug-in. Nothing here draws; `view.ts` does.
 *
 * Motion: the only moving thing the core owns is the needs-you flash, a finite burst on the
 * animation clock. Notices do not time out (no timers): they stay until replaced, until Esc, or,
 * when not sticky, until the next edit.
 */
import type { AvatarPack } from '@estate/pixel';
import {
  type ChannelSummary,
  type Crossed,
  type DisplayRecord,
  type Divider,
  dividerCount,
  dividerFor,
  isAttentionEligible,
  isMember,
  mergeRecords,
  type OwnerAnchor,
  type PostState,
  type RawRecord,
  type Result,
  type SendOutcome,
  type SendRequest,
  shouldClearDraft,
  toDisplay,
  type Verdict,
  VerificationScheduler,
  verify,
} from '@estate/post-kit';
import type { Burst } from '../host/animation-clock.ts';
import type { HostApi } from '../host/grid-host.ts';
import * as edit from './composer.ts';
import {
  directoryFor,
  nameSender,
  needsYou,
  preview,
  shortId,
  showMentionNames,
  trendOf,
} from './derive.ts';
import { layoutKind } from './layout.ts';
import {
  fromWire,
  indexNames,
  type Mention,
  mentionAfter,
  mentionAround,
  mentionBefore,
  plainName,
  remapMentions,
  retitle,
  toWire,
} from './mentions.ts';
import {
  allPasteHandlers,
  allPollObservers,
  type CommandContext,
  command,
  currentStage,
  type EmoteSendRequest,
  overlay as findOverlay,
  isEmoteRequest,
  type StageEvent,
} from './registry.ts';
import type { SavedLayout } from './remember.ts';
import type {
  AppActions,
  AppServices,
  AppState,
  ChannelState,
  ComposerState,
  CrossedStrip,
  MotionMode,
  Notice,
  OwnerView,
  PaneState,
} from './state.ts';
import {
  idSuffix,
  type Person,
  type RuntimeFacts,
  runtimeLine,
  type Tiebreak,
  tiebreaks,
  tiebreakText,
} from './who.ts';

/** A send shown before post has confirmed it. `id` is the receipt's, once there is one. */
type PendingSend = {
  key: number;
  channel: string;
  id: string | undefined;
  shown: DisplayRecord;
  /** The newest id in the channel when Enter was pressed: the real record is newer than this. */
  after: string;
};

/** What the model reads post through: post-kit's `PostStore` has this shape. */
export type PostSource = {
  getState(): PostState;
  subscribe(listener: () => void): () => void;
  onSeen(listener: (channel: string, id: string, participant: string) => void): () => void;
  open(channel: string, opts?: { background?: boolean }): Promise<void>;
  setBackground(channel: string, background: boolean): void;
  isOpen(channel: string): boolean;
  acknowledge(
    channel: string,
    visible: readonly RawRecord[],
  ): Promise<Result<{ advanced: boolean }>>;
  refreshChannels(): Promise<void>;
  /**
   * Read `channel` again now, after a record known to exist (Trey's own receipt) was missing from
   * the last read: resolves when a read that began after this call has been applied.
   */
  refreshChannel(channel: string): Promise<void>;
  trackConfirmed(channel: string, id: string): void;
  regainFocus(): Promise<void>;
  dispose(): void;
};

export type DraftStore = {
  load(): Promise<Map<string, string>>;
  save(drafts: ReadonlyMap<string, string>): Promise<void>;
};

export type RescueStore = {
  record(channel: string, text: string, opts?: { replyTo?: string }): Promise<string>;
};

export type ModelDeps = {
  owner: OwnerView;
  anchor: OwnerAnchor;
  source: PostSource;
  /** The send transaction. Every word Porch sends goes through this, and nothing else sends. */
  send(req: SendRequest): Promise<SendOutcome>;
  /**
   * Post's emote path (`post chat --emote`): unsigned, no recovery record, never wakes agents.
   * Without it, commands are not offered the emote route (`ctx.send.emotes` stays unset).
   */
  sendEmote?(channel: string, name: string, at?: string): Promise<SendOutcome>;
  /**
   * Join `channel` as Trey (`post chat --join`). A send or an emote in a channel he has not joined
   * joins first; without this, the send goes out and post refuses it.
   */
  join?(channel: string): Promise<Result<void>>;
  drafts?: DraftStore;
  /** The layout and channels last saved (boot reads them); they decide what opens at launch. */
  remembered?: SavedLayout;
  /** Writes the layout (boot: atomic, in the state directory). A failure is its own to swallow. */
  saveLayout?(layout: SavedLayout): void;
  rescue?: RescueStore;
  /** The last `limit` messages of a channel (Ctrl+O loads older through this). */
  history?(channel: string, limit: number): Promise<Result<RawRecord[]>>;
  /** Verifies records loaded by Ctrl+O, outside the store's window (default: post-kit's). */
  verify?: (raw: RawRecord, anchor: OwnerAnchor) => Promise<Verdict>;
  services?: AppServices;
  armed: boolean;
  signingBlocked?: string;
  motion: MotionMode;
  /** Show the "crossed while you typed" strip after a send that crossed messages (default off). */
  crossedStrip?: boolean;
  /** `NO_COLOR` was asked for (boot reads the environment; default colour). */
  noColor?: boolean;
  avatars?: ReadonlyMap<string, AvatarPack>;
  names?: ReadonlyMap<string, string>;
  /** Where each participant works (`workspace_path`), by participant id. */
  places?: ReadonlyMap<string, string>;
  /** The identity name each participant took, by id: the name shown when it has no profile name. */
  lineages?: ReadonlyMap<string, string>;
  /** The model and effort each participant reports (`runtime`), by id. */
  runtimes?: ReadonlyMap<string, RuntimeFacts> | undefined;
  /**
   * Reads the roster again. Names, directories and lineages are loaded once at boot, so a
   * participant that joined or took a name afterwards is missing until this runs; the mentions
   * picker calls it when it opens.
   */
  loadRoster?(): Promise<Roster | undefined>;
  /** Trey's home directory, shortened to `~` in the picker (default `$HOME`). */
  home?: string;
  /** Channels where a decision record waits on Trey. */
  decisionsWaiting?(): ReadonlySet<string>;
  /** Wall-clock time, for the trend (tests pin it). */
  wallClock?: () => number;
};

/** Messages Ctrl+O adds per press, and the most a channel's window holds. */
export const OLDER_STEP = 100;
export const MAX_WINDOW = 5000;
/**
 * The deepest a jump reaches for a message outside the window. Post reads only the newest N, so a
 * jump asks for doubling N until the message is in it; past this many it gives up and says so.
 */
export const JUMP_REACH = 160_000;
/** The needs-you flash: three on-off flashes on the 125 ms grid. */
export const FLASH_MS = 750;
/** Unsaved edits are written this long after the last keystroke. */
export const AUTOSAVE_MS = 800;
/** A layout change is written this long after the last one; a clean exit writes at once. */
export const LAYOUT_SAVE_MS = 400;

/** Who is in post by id: profile names, working directories and lineages. */
export type Roster = {
  names: ReadonlyMap<string, string>;
  places: ReadonlyMap<string, string>;
  lineages: ReadonlyMap<string, string>;
  /** What each participant reports about its model and effort; absent for one that never did. */
  runtimes?: ReadonlyMap<string, RuntimeFacts>;
};

const NO_HINTS: ReadonlyMap<string, string> = new Map();

/** The roster is read again at most this often, when the mentions picker opens. */
export const ROSTER_TTL_MS = 10_000;
/** Rows the mentions picker offers at once. */
export const PICKER_ROWS = 8;

type Picker = { start: number; index: number; dismissed: boolean };

/** Someone a mention can name: see `AppModel.channelPeople`. */
export type MentionCandidate = {
  insert: string;
  label: string;
  person: boolean;
  /**
   * What the picker shows after the name, in gray parentheses: `~/Code/porch · opus-5.5 · high`,
   * with the last four characters of the id when another participant shares the name and the
   * directory does not tell them apart. Absent when nothing is known.
   */
  hint?: string;
};

/** The name shown for each participant: the lineage, overridden by the profile name. */
function shownNames(roster: Roster): ReadonlyMap<string, string> {
  return new Map([...roster.lineages, ...roster.names]);
}

/**
 * A frame's record of what each pane showed, for Ctrl+U and the pick. It names the channel it
 * showed: Ctrl+U trusts it only for that channel, and a switch drops it before the next frame.
 */
export type PaneView = { channel: string | undefined; visible: RawRecord[]; streamRows: number };

/**
 * A window held around a jump target outside the newest `MAX_WINDOW`, shown instead of the newest
 * until Ctrl+G or a send. `after` counts the channel's messages newer than its last record.
 */
type Detached = { records: RawRecord[]; after: number; start: boolean };

export class AppModel {
  readonly deps: ModelDeps;
  host: HostApi | undefined;
  cols = 100;
  rows = 32;
  current: string | undefined;
  panes: PaneState[] = [{ channel: undefined, scroll: 0, pick: undefined }];
  focusedPane = 0;
  split = true;
  mode: 'casual' | 'signed' = 'casual';
  overlay: string | undefined;
  notice: Notice | undefined;
  crossed: CrossedStrip | undefined;
  /** Whether the crossed strip may show; starts from the setting, `/crossed` flips it for the session. */
  crossedStripOn: boolean;
  sending = false;
  focused = true;
  helpFallback = false;
  /** Set when a pick moved and the stream should scroll it into view on the next frame. */
  ensurePick = false;
  picker: Picker | undefined;
  readonly paneViews = new Map<number, PaneView>();
  readonly flashes = new Map<string, Burst>();
  /**
   * Set by the scene: whether drawing now would change any displayed cell. A data change (a poll,
   * a verdict) asks this before requesting a frame, so an update nothing shows draws nothing.
   */
  frameNeeded: (() => boolean) | undefined;
  private readonly composers = new Map<string, ComposerState>();
  private savedDrafts = new Map<string, string>();
  private draftsDirty = false;
  private autosave: ReturnType<typeof setTimeout> | undefined;
  private readonly older = new Map<string, RawRecord[]>();
  private readonly detached = new Map<string, Detached>();
  /** Channels this model opened in the store, whose background flag it keeps in step with panes. */
  private readonly opened = new Set<string>();
  private readonly observing = new Set<string>();
  private readonly beginning = new Set<string>();
  private readonly olderVerdicts = new Map<string, Verdict>();
  private olderVerifier: VerificationScheduler | undefined;
  private readonly dividers = new Map<string, Divider | undefined>();
  private readonly needs = new Map<string, boolean>();
  private readonly newest = new Map<string, string>();
  private readonly ownIds = new Set<string>();
  /** Trey's sends shown before post confirms them, in the order he pressed Enter. */
  private readonly pendingSends = new Map<number, PendingSend>();
  private pendingSeq = 0;
  private displayCache = new WeakMap<
    RawRecord,
    { verdict: Verdict | undefined; shown: DisplayRecord }
  >();
  private roster: Roster;
  /** Participant id to the name shown for it: the profile name, else the lineage. */
  private shown: ReadonlyMap<string, string>;
  private readonly ownerSkip: ReadonlySet<string>;
  private rosterAt: number | undefined;
  private rosterLoading = false;
  private snapshot: AppState | undefined;
  private unsubscribe: (() => void)[] = [];
  private quitting = false;
  /** The channel last shown beside the focused one: the second pane's choice when a split opens. */
  private lastOther: string | undefined;
  /** A remembered split whose focused pane was the right one: that channel goes on the right. */
  private rightPane: string | undefined;
  private layoutLive = false;
  private layoutTimer: ReturnType<typeof setTimeout> | undefined;
  private layoutWritten: string | undefined;
  private layoutBase: SavedLayout | undefined;

  constructor(deps: ModelDeps) {
    this.deps = deps;
    this.crossedStripOn = deps.crossedStrip === true;
    this.ownerSkip = new Set([deps.owner.participant.toLowerCase()]);
    this.roster = {
      names: deps.names ?? new Map(),
      places: deps.places ?? new Map(),
      lineages: deps.lineages ?? new Map(),
      runtimes: deps.runtimes ?? new Map(),
    };
    this.shown = shownNames(this.roster);
    if (deps.remembered !== undefined) {
      this.split = deps.remembered.split;
      this.layoutBase = deps.remembered;
      this.layoutWritten = JSON.stringify(deps.remembered);
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────

  /** Load drafts, list channels, open the launch channel and the lanes. */
  async start(requested: string | undefined, initial: string): Promise<void> {
    if (this.deps.drafts !== undefined) {
      try {
        this.savedDrafts = await this.deps.drafts.load();
        for (const [channel, wire] of this.savedDrafts) {
          // A draft is saved as post will read it (`@<id>`) and comes back drawn as names.
          const { text, mentions } = this.drawn(wire);
          this.composers.set(channel, {
            text,
            caret: text.length,
            revision: 0,
            replyTo: undefined,
            mentions,
          });
        }
      } catch (err) {
        this.status(`drafts could not be read: ${message(err)}`, 'caution', true);
      }
    }
    this.unsubscribe.push(this.deps.source.subscribe(() => this.changed()));
    this.unsubscribe.push(
      this.deps.source.onSeen((channel, id, participant) =>
        this.stageEvent({ kind: 'seen', channel, id, participant }),
      ),
    );
    await this.deps.source.refreshChannels().catch(() => undefined);
    const remembered = this.deps.remembered;
    const joined = this.joined();
    const launch = pickLaunchChannel(
      requested,
      initial,
      joined,
      remembered?.panes[remembered.focused],
    );
    if (requested !== undefined && launch !== requested)
      this.status(
        launch === undefined
          ? `#${requested} is not joined, and no channel is`
          : `#${requested} is not joined; showing #${launch}`,
        'caution',
      );
    if (launch !== undefined) await this.openChannel(launch);
    if (remembered !== undefined && launch !== undefined) {
      this.lastOther = remembered.panes.find((c) => c !== launch && joined.includes(c));
      if (
        remembered.focused === 1 &&
        launch === remembered.panes[1] &&
        this.lastOther === remembered.panes[0]
      )
        this.rightPane = launch;
    }
    for (const lane of this.lanes())
      if (!this.deps.source.isOpen(lane)) void this.deps.source.open(lane, { background: true });
    this.layoutLive = true;
    if (this.deps.signingBlocked !== undefined)
      this.status(`signing refused: ${this.deps.signingBlocked}`, 'warning', true);
  }

  /** The host to draw and animate through; the scene hands it over on every call. */
  attach(host: HostApi): void {
    this.host = host;
  }

  dispose(): void {
    for (const u of this.unsubscribe.splice(0)) u();
    clearTimeout(this.autosave);
    this.flushLayout();
    this.olderVerifier?.dispose();
    for (const b of this.flashes.values()) b.cancel();
  }

  private changed(): void {
    this.snapshot = undefined;
    this.observe();
    this.runPollObservers();
    this.redraw();
  }

  /** A data change: a frame only if it would show something different. */
  private redraw(): void {
    this.snapshot = undefined;
    if (this.host === undefined) return;
    if (this.frameNeeded !== undefined && !this.frameNeeded()) return;
    this.host.requestFrame();
  }

  /** Plug-ins watching post (decision records); one call each at a time, failures shown. */
  private runPollObservers(): void {
    for (const o of allPollObservers()) {
      if (this.observing.has(o.id)) continue;
      this.observing.add(o.id);
      let pending: void | Promise<void>;
      try {
        pending = o.observe(this.state());
      } catch (err) {
        this.observing.delete(o.id);
        this.status(`${o.id}: ${message(err)}`, 'warning');
        continue;
      }
      void Promise.resolve(pending)
        .catch((err: unknown) => this.status(`${o.id}: ${message(err)}`, 'warning'))
        .finally(() => this.observing.delete(o.id));
    }
  }

  /** After post state moves: dividers, arrivals for the stage, and lanes newly needing Trey. */
  private observe(): void {
    const self = this.self();
    for (const summary of this.deps.source.getState().channels) {
      const name = summary.name;
      const records = this.liveRecords(name);
      const unread = summary.unread ?? 0;
      if (unread <= 0) this.dividers.delete(name);
      else if (this.dividers.get(name) === undefined && records.length > 0)
        this.dividers.set(name, dividerFor(records, unread, self));
      const newestId = records.at(-1)?.id;
      const before = this.newest.get(name);
      if (newestId !== undefined && newestId !== before) {
        this.newest.set(name, newestId);
        if (before !== undefined) {
          const arrived = records.filter((r) => r.id > before).map((r) => this.display(r, name));
          if (arrived.length > 0)
            this.stageEvent({ kind: 'arrival', channel: name, records: arrived });
        }
      }
      const needed = this.needsYou(name);
      if (needed && this.needs.get(name) !== true) this.flash(name);
      this.needs.set(name, needed);
    }
  }

  private flash(channel: string): void {
    if (this.deps.motion !== 'full' || this.host === undefined) return;
    this.flashes.get(channel)?.cancel();
    this.flashes.set(channel, this.host.animate(FLASH_MS));
  }

  stageEvent(e: StageEvent): void {
    const stage = currentStage();
    if (stage?.event === undefined) return;
    stage.event(e, this.state());
  }

  // ── reading ────────────────────────────────────────────────────────────────────────────────

  self() {
    return {
      room: this.deps.owner.room,
      participant: this.deps.owner.participant,
      receiptIds: this.ownIds,
    };
  }

  summary(channel: string): ChannelSummary | undefined {
    return this.deps.source.getState().channels.find((c) => c.name === channel);
  }

  /**
   * `channel` is one post lists and Trey's participant is not in it. A channel the listing does not
   * hold is not "not joined": joining creates a channel, and nothing here should do that by typo.
   */
  notJoined(channel: string): boolean {
    const c = this.summary(channel);
    return c !== undefined && !isMember(c);
  }

  /**
   * Join `channel` before a send into it, when Trey is not in it. Undefined when he is (or the join
   * worked); the refusal to show when it did not. The one place a failed join is worded, so a
   * failed send reads once.
   */
  private async joinFirst(channel: string): Promise<SendOutcome | undefined> {
    if (this.deps.join === undefined || !this.notJoined(channel)) return undefined;
    let failure: string | undefined;
    try {
      const r = await this.deps.join(channel);
      if (!r.ok) failure = r.error.message;
    } catch (err) {
      failure = message(err);
    }
    if (failure !== undefined)
      return {
        kind: 'refused',
        code: 'join_failed',
        message: `could not join #${channel}: ${failure}`,
      };
    // The listing says he is in now: the next send does not join again.
    await this.deps.source.refreshChannels().catch(() => undefined);
    return undefined;
  }

  /** Live channels Trey has joined (post reports an unread count only for those). */
  joined(): string[] {
    return this.deps.source
      .getState()
      .channels.filter((c) => c.unread !== undefined && !c.archived)
      .map((c) => c.name);
  }

  /** The score bar's lanes: joined, live (not archived) channels, plus the current one. */
  lanes(): string[] {
    const out = this.deps.source
      .getState()
      .channels.filter((c) => c.unread !== undefined && !c.archived)
      .map((c) => c.name);
    if (this.current !== undefined && !out.includes(this.current)) out.push(this.current);
    return out;
  }

  /** What a pane shows for `channel`: a jump's held window, else the live window. */
  records(channel: string): RawRecord[] {
    const held = this.detached.get(channel);
    return held === undefined ? this.liveRecords(channel) : [...held.records];
  }

  /**
   * The live window for `channel`: the store's newest records and what Ctrl+O loaded. Arrivals,
   * the divider, needs-you and the trend always read this, whatever a pane shows.
   */
  liveRecords(channel: string): RawRecord[] {
    const view = this.deps.source.getState().views[channel];
    const older = this.older.get(channel);
    const live = view?.records ?? [];
    if (older === undefined || older.length === 0) return [...live];
    return mergeRecords(older, live, MAX_WINDOW);
  }

  private verdictFor(channel: string, raw: RawRecord): Verdict | undefined {
    return (
      this.deps.source.getState().views[channel]?.verdicts[raw.id] ??
      this.olderVerdicts.get(`${channel}/${raw.id}`)
    );
  }

  display(raw: RawRecord, channel: string): DisplayRecord {
    const verdict = this.verdictFor(channel, raw);
    const cached = this.displayCache.get(raw);
    if (cached !== undefined && cached.verdict === verdict) return cached.shown;
    const anchor = this.deps.anchor;
    const plain = toDisplay(raw, verdict === undefined ? { anchor } : { anchor, verdict });
    // A mention is stored as the participant id post resolves, and drawn as the name.
    const text = showMentionNames(plain.text, this.shown, this.ownerSkip);
    const shown = nameSender(
      text === plain.text ? plain : { ...plain, text },
      this.shown,
      anchor.ownerRoom,
    );
    this.displayCache.set(raw, { verdict, shown });
    return shown;
  }

  needsYou(channel: string): boolean {
    const summary = this.summary(channel);
    if (summary === undefined || summary.unread === undefined) return false;
    const records = this.liveRecords(channel);
    const dir = directoryFor(
      { room: this.deps.owner.room, participant: this.deps.owner.participant },
      records,
    );
    return needsYou(
      records,
      summary.unread,
      this.self(),
      dir,
      this.ownIds,
      this.deps.decisionsWaiting?.().has(channel) ?? false,
    );
  }

  channelState(channel: string): ChannelState {
    const summary = this.summary(channel);
    const live = this.liveRecords(channel);
    const held = this.detached.get(channel);
    const self = this.self();
    const divider = this.dividers.get(channel);
    const view = this.deps.source.getState().views[channel];
    const msgs = live.filter((r) => r.file === 'msg').length;
    const pending = this.pendingFor(channel, live);
    const top: ChannelState['top'] =
      held !== undefined
        ? held.start
          ? 'beginning'
          : 'older'
        : this.beginning.has(channel) ||
            (summary?.messages !== undefined && summary.messages <= msgs)
          ? 'beginning'
          : live.length >= MAX_WINDOW
            ? 'full'
            : 'older';
    return {
      name: channel,
      summary,
      records: (held?.records ?? live).map((r) => this.display(r, channel)),
      ...(pending.length === 0 ? {} : { pending }),
      acknowledged: view?.acknowledged,
      divider: divider?.before,
      newCount: divider === undefined ? 0 : dividerCount(divider, live, self),
      needsYou: this.needsYou(channel),
      trend: trendOf(live, self, (this.deps.wallClock ?? Date.now)()),
      top,
      detached: held !== undefined,
      error: view?.error,
    };
  }

  composer(channel = this.current): ComposerState {
    return (
      (channel === undefined ? undefined : this.composers.get(channel)) ?? {
        text: '',
        caret: 0,
        revision: 0,
        replyTo: undefined,
        mentions: [],
      }
    );
  }

  /** The snapshot every frame and plug-in reads; rebuilt after any change. */
  state(): AppState {
    if (this.snapshot !== undefined) {
      // The data snapshot is kept between changes; the animation clock is read for every frame.
      const now = this.host?.now() ?? 0;
      if (this.snapshot.now !== now) this.snapshot = { ...this.snapshot, now };
      return this.snapshot;
    }
    const views = new Map<string, ChannelState>();
    const names = new Set([...this.lanes(), ...this.panes.flatMap((p) => p.channel ?? [])]);
    for (const name of names) views.set(name, this.channelState(name));
    const services = this.deps.services;
    // Read lazily, once per snapshot and channel: only the channels a frame draws pay for it.
    const hintCache = new Map<string, ReadonlyMap<string, string>>();
    this.snapshot = {
      owner: this.deps.owner,
      channels: this.deps.source.getState().channels,
      views,
      current: this.current,
      panes: this.panes.map((p) => ({ ...p })),
      focusedPane: this.focusedPane,
      split: this.isSplit(),
      layout: layoutKind(this.cols),
      cols: this.cols,
      rows: this.rows,
      composer: this.composer(),
      mode: this.mode,
      armed: this.deps.armed,
      signingBlocked: this.deps.signingBlocked,
      sending: this.sending,
      crossed: this.crossed,
      overlay: this.overlay,
      notice: this.notice,
      avatars: this.deps.avatars ?? new Map(),
      names: this.shown,
      hints: (channel) => {
        if (channel === undefined) return NO_HINTS;
        const kept = hintCache.get(channel);
        if (kept !== undefined) return kept;
        const h = this.nameHints(channel);
        hintCache.set(channel, h);
        return h;
      },
      motion: this.deps.motion,
      noColor: this.deps.noColor === true,
      focused: this.focused,
      now: this.host?.now() ?? 0,
      ownMessageIds: new Set(this.ownIds),
      actions: this.actions,
      post: services,
    };
    return this.snapshot;
  }

  /** Anything visible changed: rebuild the snapshot and ask for a frame. */
  touch(): void {
    this.snapshot = undefined;
    this.host?.requestFrame();
    this.scheduleLayout();
  }

  // ── remembered layout ──────────────────────────────────────────────────────────────────────

  /** What a restart should restore: the preference, the panes in screen order, the focused one. */
  private layoutNow(): SavedLayout {
    const [a, b] = this.panes;
    if (a?.channel !== undefined && b?.channel !== undefined) {
      this.lastOther = this.focusedPane === 0 ? b.channel : a.channel;
      return { split: this.split, panes: [a.channel, b.channel], focused: this.focusedPane };
    }
    const cur = this.current;
    if (cur === undefined)
      return { ...(this.layoutBase ?? { panes: [], focused: 0 }), split: this.split };
    const other = this.lastOther !== undefined && this.lastOther !== cur ? [this.lastOther] : [];
    return { split: this.split, panes: [cur, ...other], focused: 0 };
  }

  private scheduleLayout(): void {
    if (!this.layoutLive || this.deps.saveLayout === undefined) return;
    if (this.layoutTimer !== undefined) return;
    if (JSON.stringify(this.layoutNow()) === this.layoutWritten) return;
    this.layoutTimer = setTimeout(() => this.flushLayout(), LAYOUT_SAVE_MS);
    this.layoutTimer.unref?.();
  }

  /** Write the layout now if it changed since it was last written. */
  private flushLayout(): void {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = undefined;
    if (!this.layoutLive || this.deps.saveLayout === undefined) return;
    const now = this.layoutNow();
    const json = JSON.stringify(now);
    if (json === this.layoutWritten) return;
    this.layoutWritten = json;
    this.layoutBase = now;
    try {
      this.deps.saveLayout(now);
    } catch {
      // Forgetting a layout is not worth a notice.
    }
  }

  isSplit(): boolean {
    return this.split && layoutKind(this.cols) === 'wide';
  }

  /** Set by the scene before each frame. */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.syncPanes();
    this.snapshot = undefined;
  }

  /** Two panes on a split wide screen, one otherwise; the second shows another lane. */
  private syncPanes(): void {
    const want = this.isSplit() ? 2 : 1;
    if (this.panes.length > want) {
      const gone = this.panes.find((_, i) => i !== this.focusedPane)?.channel;
      if (gone !== undefined) this.lastOther = gone;
      this.panes = [this.panes[this.focusedPane] ?? this.panes[0] ?? emptyPane()];
      this.focusedPane = 0;
      this.paneViews.clear();
    } else if (this.panes.length < want) {
      const lanes = this.lanes();
      const kept = this.lastOther;
      const remembered = kept !== undefined && kept !== this.current && lanes.includes(kept);
      const other = remembered ? kept : lanes.find((l) => l !== this.current);
      // A split saved with its right-hand pane focused comes back the same way round.
      const onRight = remembered && this.rightPane !== undefined && this.rightPane === this.current;
      this.rightPane = undefined;
      if (onRight) {
        this.panes.unshift({ channel: other, scroll: 0, pick: undefined });
        this.focusedPane = 1;
        this.paneViews.clear();
      } else this.panes.push({ channel: other, scroll: 0, pick: undefined });
      if (other !== undefined) {
        this.opened.add(other);
        if (this.deps.source.isOpen(other)) this.deps.source.setBackground(other, false);
        else void this.deps.source.open(other);
      }
    }
    this.reconcileBackground();
  }

  /**
   * Every channel this model opened polls in the foreground exactly while a pane shows it; the rest
   * fall back to the background cadence (a removed split pane, a switched-away channel).
   */
  private reconcileBackground(): void {
    for (const channel of this.opened) {
      if (!this.deps.source.isOpen(channel)) continue;
      this.deps.source.setBackground(channel, !this.panes.some((p) => p.channel === channel));
    }
  }

  /**
   * A frame clamped pane `index`'s scroll to its content: keep that, without asking for another
   * frame (the frame that found it already shows it).
   */
  clampScroll(index: number, scroll: number): void {
    const p = this.panes[index];
    if (p === undefined || p.scroll === scroll) return;
    this.panes = this.panes.map((q, i) => (i === index ? { ...q, scroll } : q));
    this.snapshot = undefined;
  }

  pane(index = this.focusedPane): PaneState {
    return this.panes[index] ?? emptyPane();
  }

  private setPane(index: number, next: Partial<PaneState>): void {
    const old = this.pane(index);
    const now = { ...old, ...next };
    this.panes = this.panes.map((p, i) => (i === index ? now : p));
    if (now.channel !== old.channel) this.paneViews.delete(index);
    this.touch();
    if (now.pick !== old.pick)
      this.stageEvent({ kind: 'pick', channel: now.channel, id: now.pick });
  }

  // ── actions plug-ins may call ──────────────────────────────────────────────────────────────

  readonly actions: AppActions = {
    openChannel: (channel) => void this.openChannel(channel),
    jumpTo: (channel, id) => void this.jumpTo(channel, id),
    openOverlay: (id) => this.openOverlay(id),
    closeOverlay: () => this.closeOverlay(),
    setDraft: (wire) => {
      // A saved or rescued draft is as post reads it; the composer draws the names.
      const { text, mentions } = this.drawn(wire);
      this.setComposer({ text, caret: text.length }, { mentions });
    },
    insert: (text) => this.setComposer(edit.insert(this.editOf(), text)),
    replyTo: (id) => this.setReply(id),
    pick: (id) => this.pick(id),
    status: (text, tone, sticky) => this.status(text, tone, sticky),
    animate: (ms) => this.host?.animate(ms) ?? { start: 0, end: 0, cancel: () => {} },
    requestFrame: () => this.touch(),
    quit: () => void this.quit(),
    appendImagePath: (channel, path) => this.appendTo(channel, path),
  };

  async openChannel(channel: string): Promise<void> {
    const other = this.panes.findIndex((p, i) => i !== this.focusedPane && p.channel === channel);
    if (other !== -1) {
      this.focusPane(other);
      return;
    }
    const previous = this.pane().channel;
    if (previous !== channel) {
      this.picker = undefined;
      // A reply target belongs to its channel's draft; switching keeps it there.
      this.setPane(this.focusedPane, { channel, scroll: 0, pick: undefined });
    }
    this.current = channel;
    if (this.crossed !== undefined && this.crossed.channel !== channel) this.crossed = undefined;
    this.touch();
    this.opened.add(channel);
    if (this.deps.source.isOpen(channel)) this.reconcileBackground();
    else {
      this.reconcileBackground();
      await this.deps.source.open(channel);
    }
  }

  focusPane(index: number): void {
    if (index < 0 || index >= this.panes.length) return;
    if (index !== this.focusedPane) this.paneViews.delete(index);
    this.focusedPane = index;
    this.current = this.pane(index).channel;
    this.picker = undefined;
    this.touch();
  }

  /**
   * A search hit: open its channel and pick it. A hit older than the live window is shown in a
   * window of up to `MAX_WINDOW` held around it, in place of the newest, until Ctrl+G.
   */
  async jumpTo(channel: string, id: string): Promise<void> {
    await this.openChannel(channel);
    if (!this.records(channel).some((r) => r.id === id)) await this.holdAround(channel, id);
    if (!this.records(channel).some((r) => r.id === id)) return;
    this.pick(id);
  }

  private async holdAround(channel: string, id: string): Promise<void> {
    if (this.deps.history === undefined) {
      this.status('that message is outside the loaded window, and older history is unavailable');
      return;
    }
    for (let limit = MAX_WINDOW * 2; ; limit *= 2) {
      const r = await this.deps.history(channel, Math.min(limit, JUMP_REACH));
      if (!r.ok) {
        this.status(`could not reach that message: ${r.error.message}`, 'warning');
        return;
      }
      const all = r.value;
      const at = all.findIndex((x) => x.id === id);
      if (at !== -1) {
        const half = Math.floor(MAX_WINDOW / 2);
        const from = Math.max(0, Math.min(at - half, all.length - MAX_WINDOW));
        const to = Math.min(all.length, from + MAX_WINDOW);
        this.detached.set(channel, {
          records: all.slice(from, to),
          after: all.length - to,
          start: from === 0 && all.length < Math.min(limit, JUMP_REACH),
        });
        this.setPane(this.focusedPane, { scroll: 0, pick: undefined });
        this.verifyOlder();
        this.status('showing messages around the hit; Ctrl+G returns to the newest', 'info', true);
        return;
      }
      if (all.length < limit || limit >= JUMP_REACH) {
        this.status(
          limit >= JUMP_REACH && all.length >= JUMP_REACH
            ? `that message is more than ${JUMP_REACH} back; Porch does not reach that far`
            : `that message is no longer in #${channel}`,
          'caution',
        );
        return;
      }
    }
  }

  openOverlay(id: string): void {
    if (findOverlay(id) === undefined) {
      if (id === 'help') {
        this.helpFallback = !this.helpFallback;
        this.touch();
        return;
      }
      this.status(`${id} is not available in this build`, 'caution');
      return;
    }
    if (this.overlay !== undefined && this.overlay !== id) findOverlay(this.overlay)?.reset?.();
    this.overlay = id;
    this.touch();
  }

  closeOverlay(): void {
    if (this.overlay !== undefined) findOverlay(this.overlay)?.reset?.();
    this.overlay = undefined;
    this.helpFallback = false;
    this.touch();
  }

  status(text: string, tone: Notice['tone'] = 'info', sticky = false): void {
    this.notice = { text, tone, sticky };
    this.touch();
  }

  /**
   * Add `text` to the end of `channel`'s draft (an attached image's path), whatever channel has
   * focus now, keeping the words already there.
   */
  appendTo(channel: string, text: string): void {
    const old = this.composer(channel);
    const sep = old.text === '' || /\s$/.test(old.text) ? '' : ' ';
    const next = `${old.text}${sep}${text}`;
    const atEnd = old.caret === old.text.length;
    this.composers.set(channel, {
      text: next,
      caret: atEnd ? next.length : old.caret,
      revision: old.revision + 1,
      replyTo: old.replyTo,
      mentions: old.mentions ?? [],
    });
    this.scheduleAutosave();
    if (channel === this.current) this.updatePicker();
    this.touch();
  }

  // ── composer ───────────────────────────────────────────────────────────────────────────────

  editOf(): edit.Edit {
    const c = this.composer();
    return { text: c.text, caret: c.caret };
  }

  /** Apply an edit to the current channel's draft; a change bumps its revision. */
  setComposer(
    next: edit.Edit,
    opts: { replyTo?: string | undefined; mentions?: readonly Mention[] } = {},
  ): void {
    const channel = this.current;
    if (channel === undefined) {
      this.status('open a channel first: Ctrl+K lists them', 'caution');
      return;
    }
    const old = this.composer(channel);
    const changedText = next.text !== old.text;
    const replyTo = 'replyTo' in opts ? opts.replyTo : old.replyTo;
    // The mentions follow the text: an edit moves, keeps or drops the ones it touches.
    const mentions =
      opts.mentions ??
      (changedText
        ? remapMentions(old.mentions ?? [], old.text, next.text, Math.min(old.caret, next.caret))
        : (old.mentions ?? []));
    this.composers.set(channel, {
      text: next.text,
      caret: edit.snap(next.text, Math.max(0, Math.min(next.caret, next.text.length))),
      revision: changedText ? old.revision + 1 : old.revision,
      replyTo,
      mentions,
    });
    if (changedText) {
      if (this.notice !== undefined && !this.notice.sticky) this.notice = undefined;
      this.scheduleAutosave();
      this.updatePicker();
    }
    this.touch();
  }

  setReply(id: string | undefined): void {
    this.setComposer(this.editOf(), { replyTo: id });
    if (id !== undefined) {
      const channel = this.current ?? '';
      const raw = this.records(channel).find((r) => r.id === id);
      const who = raw === undefined ? undefined : this.display(raw, channel).sender.text;
      this.status(
        `replying to ${raw === undefined ? shortId(id) : `${who}: ${preview(raw.body, 40)}`}`,
      );
    }
  }

  /** A bracketed paste: an overlay's, else a paste handler's (an image path), else the composer's. */
  async paste(text: string): Promise<void> {
    if (this.overlay === undefined) {
      for (const h of allPasteHandlers()) {
        try {
          if (await h.paste(text, this.state())) {
            this.touch();
            return;
          }
        } catch (err) {
          this.status(`${h.id}: ${message(err)}`, 'warning');
          return;
        }
      }
    }
    this.pasteText(text);
  }

  private pasteText(text: string): void {
    if (this.overlay !== undefined) {
      const o = findOverlay(this.overlay);
      // Overlays take typed keys; a paste into one goes in as one text key.
      o?.key(
        { name: 'paste', ctrl: false, alt: false, shift: false, text: edit.cleanInput(text) },
        this.state(),
      );
      this.touch();
      return;
    }
    this.pick(undefined);
    this.setComposer(edit.insert(this.editOf(), text));
  }

  // ── mentions picker ────────────────────────────────────────────────────────────────────────

  private updatePicker(): void {
    const at = edit.mentionAt(this.editOf());
    // A mention already made (the caret right after `@Fern`) is done, not a word to complete.
    const c = this.composer();
    if (at === undefined || (c.mentions ?? []).some((m) => m.end === c.caret)) {
      this.picker = undefined;
      return;
    }
    if (this.picker?.start === at.start) return;
    this.picker = { start: at.start, index: 0, dismissed: false };
    void this.refreshRoster();
  }

  /**
   * Reads the roster again (profile names, directories, lineages), at most once per
   * `ROSTER_TTL_MS` and one read at a time. Boot loads it once; without this a participant that
   * took a name after Porch started stays an id in the picker and the bylines.
   */
  async refreshRoster(): Promise<void> {
    const load = this.deps.loadRoster;
    if (load === undefined || this.rosterLoading) return;
    const now = (this.deps.wallClock ?? Date.now)();
    if (this.rosterAt !== undefined && now - this.rosterAt < ROSTER_TTL_MS) return;
    this.rosterLoading = true;
    this.rosterAt = now;
    try {
      const next = await load();
      if (next === undefined || this.quitting) return;
      this.roster = next;
      this.shown = shownNames(next);
      // Drawn text depends on the names, so nothing drawn before them is kept, and a mention in a
      // draft is redrawn under the name its participant has now.
      this.displayCache = new WeakMap();
      this.retitleDrafts();
      this.touch();
    } catch {
      // A failed read leaves what is known; the next opening of the picker tries again.
    } finally {
      this.rosterLoading = false;
    }
  }

  /**
   * Everyone a mention in `channel` can name: `insert` is what post resolves (a participant id, a
   * lineage or a room), `label` the name shown, `place` the directory the participant works in
   * (home shortened to `~`), and `person` whether `insert` is a participant id.
   */
  private channelPeople(channel: string): MentionCandidate[] {
    const home = this.homeDir();
    const ties = this.tiebreaks(channel);
    const seen = new Map<string, MentionCandidate>();
    const add = (insert: string | undefined, label: string, person: boolean) => {
      if (insert === undefined || insert === '' || seen.has(insert)) return;
      if (insert === this.deps.owner.participant || insert === this.deps.owner.room) return;
      // The parenthetical: directory, model, effort; the id's tail only when it is what tells two
      // same-named participants apart.
      const hint = person
        ? runtimeLine(
            this.roster.places.get(insert),
            this.roster.runtimes?.get(insert),
            home,
            ties.get(insert)?.suffix === undefined ? undefined : idSuffix(insert),
          )
        : '';
      seen.set(insert, { insert, label, person, ...(hint === '' ? {} : { hint }) });
    };
    const who = (id: string, fallback: string) => add(id, this.shown.get(id) ?? fallback, true);
    const summary = this.summary(channel);
    for (const p of summary?.participants ?? []) who(p, p);
    for (const room of summary?.members ?? []) add(room, room, false);
    for (const r of this.records(channel)) {
      const name = typeof r.envelope.display_name === 'string' ? r.envelope.display_name : r.from;
      if (r.fromParticipant !== undefined) who(r.fromParticipant, name);
      if (r.fromLineage !== undefined) add(r.fromLineage, r.fromLineage, false);
      add(r.from, r.from, false);
    }
    return [...seen.values()];
  }

  private homeDir(): string | undefined {
    return this.deps.home ?? process.env.HOME;
  }

  /**
   * How to tell apart the participants of `channel` that share a display name (see `tiebreaks`).
   * The context is who the channel shows: its participant list and the senders in its window.
   */
  private tiebreaks(channel: string): Map<string, Tiebreak> {
    const people = new Map<string, Person>();
    const self = this.deps.owner;
    const add = (id: string | undefined, fallback: string) => {
      if (id === undefined || id === '' || id === self.participant || people.has(id)) return;
      people.set(id, {
        id,
        label: this.shown.get(id) ?? fallback,
        place: this.roster.places.get(id),
      });
    };
    for (const id of this.summary(channel)?.participants ?? []) add(id, id);
    for (const r of this.records(channel)) {
      if (r.from === self.room) continue;
      add(r.fromParticipant, this.display(r, channel).sender.text);
    }
    return tiebreaks([...people.values()], this.homeDir());
  }

  /**
   * The gray text after a name for each participant of `channel` that shares it with another
   * (`~/Code/porch`, or with the id's tail when that is not enough); a unique name is absent.
   */
  nameHints(channel: string | undefined): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    if (channel === undefined) return out;
    for (const [id, t] of this.tiebreaks(channel)) out.set(id, tiebreakText(t));
    return out;
  }

  mentionCandidates(): MentionCandidate[] {
    const at = edit.mentionAt(this.editOf());
    if (at === undefined || this.current === undefined) return [];
    const q = at.query.toLowerCase();
    const matches = (insert: string, label: string) =>
      insert.toLowerCase().startsWith(q) ||
      label.toLowerCase().startsWith(q) ||
      // "Fern Bell" is found by `bell` as well as `fern`.
      label
        .toLowerCase()
        .split(/[\s._-]+/)
        .some((w) => w.startsWith(q));
    return this.channelPeople(this.current)
      .filter((c) => matches(c.insert, c.label))
      .slice(0, PICKER_ROWS);
  }

  pickerOpen(): boolean {
    return (
      this.picker !== undefined && !this.picker.dismissed && this.mentionCandidates().length > 0
    );
  }

  movePicker(dir: -1 | 1): void {
    if (this.picker === undefined) return;
    const n = this.mentionCandidates().length;
    this.picker = { ...this.picker, index: (this.picker.index + dir + n) % n };
    this.touch();
  }

  completePicker(): void {
    const choice = this.mentionCandidates()[this.picker?.index ?? 0];
    if (choice === undefined) return;
    const at = edit.mentionAt(this.editOf());
    if (at === undefined) return;
    // A participant with a name goes in as the name, remembered as a token that carries the id;
    // a lineage, a room or a participant with no name goes in as it is.
    const name = choice.person ? plainName(choice.label) : '';
    if (name === '' || name === choice.insert) {
      this.setComposer(edit.completeMention(this.editOf(), choice.insert));
      this.picker = undefined;
      return;
    }
    const c = this.composer();
    const next = edit.completeMention(this.editOf(), name);
    const kept = remapMentions(c.mentions ?? [], c.text, next.text, at.start);
    const token: Mention = { start: at.start, end: at.start + 1 + name.length, id: choice.insert };
    this.setComposer(next, { mentions: [...kept, token].sort((x, y) => x.start - y.start) });
    this.picker = undefined;
  }

  /** Backspace, Delete and Ctrl+W: a mention goes whole; anything else is the plain edit. */
  eraseKey(kind: 'backspace' | 'delete' | 'word'): void {
    const c = this.composer();
    const e = this.editOf();
    const mentions = c.mentions ?? [];
    const whole =
      kind === 'delete' ? mentionAfter(mentions, c.caret) : mentionBefore(mentions, c.caret);
    if (whole !== undefined) {
      this.setComposer({
        text: c.text.slice(0, whole.start) + c.text.slice(whole.end),
        caret: whole.start,
      });
      return;
    }
    if (kind === 'delete') {
      this.setComposer(edit.deleteForward(e));
      return;
    }
    if (kind === 'backspace') {
      this.setComposer(edit.backspace(e));
      return;
    }
    // Ctrl+W that would stop inside a mention takes the rest of it too.
    const next = edit.deleteWord(e);
    const through = mentionAround(mentions, next.caret);
    this.setComposer(
      through === undefined
        ? next
        : { text: c.text.slice(0, through.start) + c.text.slice(c.caret), caret: through.start },
    );
  }

  dismissPicker(): void {
    if (this.picker !== undefined) this.picker = { ...this.picker, dismissed: true };
    this.touch();
  }

  // ── drafts ─────────────────────────────────────────────────────────────────────────────────

  private draftMap(): Map<string, string> {
    const out = new Map<string, string>();
    // As post will read it: each mention as its id, so a restart or a rescue keeps who was meant.
    for (const [channel, c] of this.composers)
      if (c.text !== '') out.set(channel, toWire(c.text, c.mentions ?? []));
    return out;
  }

  /** A wire body as the composer draws it: each `@<id>` with a name becomes a `@Name` token. */
  private drawn(wire: string): { text: string; mentions: Mention[] } {
    return fromWire(wire, (id) =>
      this.ownerSkip.has(id.toLowerCase()) ? undefined : this.shown.get(id),
    );
  }

  /** Redraw every draft's mentions under the names the roster gives now. */
  private retitleDrafts(): void {
    for (const [channel, c] of this.composers) {
      if ((c.mentions ?? []).length === 0) continue;
      const next = retitle(c.text, c.caret, c.mentions ?? [], (id) => this.shown.get(id));
      if (next.text === c.text) continue;
      // The words changed but what is sent did not, so the revision stays: a send in flight must
      // still clear its draft.
      this.composers.set(channel, {
        ...c,
        text: next.text,
        caret: next.caret,
        mentions: next.mentions,
      });
    }
  }

  /** Who a hand-typed `@Name` in `channel` can mean: lower-cased name to the ids that carry it. */
  private nameIndex(channel: string) {
    return indexNames(
      this.channelPeople(channel)
        .filter((p) => p.person)
        .map((p) => [p.insert, p.label] as const),
    );
  }

  private scheduleAutosave(): void {
    this.draftsDirty = true;
    if (this.deps.drafts === undefined) return;
    clearTimeout(this.autosave);
    this.autosave = setTimeout(() => void this.saveDrafts(), AUTOSAVE_MS);
    this.autosave.unref?.();
  }

  /** Write every draft. A conflict or a read-only store is a notice, never lost typing. */
  async saveDrafts(): Promise<boolean> {
    clearTimeout(this.autosave);
    if (this.deps.drafts === undefined) return !this.draftsDirty;
    const wanted = this.draftMap();
    try {
      await this.deps.drafts.save(wanted);
      this.savedDrafts = wanted;
      this.draftsDirty = false;
      return true;
    } catch (err) {
      this.status(
        err instanceof Error && err.name === 'DraftConflictError'
          ? 'another Porch changed these drafts; yours are kept here and not written'
          : `drafts not saved: ${message(err)}`,
        'caution',
        true,
      );
      return false;
    }
  }

  /**
   * Quit (Ctrl+Q, Ctrl+C, /quit, /q): save the drafts; if that fails, rescue each unsaved draft
   * into a recovery record; if that fails too, refuse to quit and say why.
   */
  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    try {
      if ((await this.saveDrafts()) || (await this.rescueUnsaved())) this.host?.quit();
    } finally {
      this.quitting = false;
    }
  }

  /**
   * Each draft not saved as it stands, into a recovery record (`/restore` brings it back). True
   * when every one was rescued; false, with the reason on screen, when that is impossible.
   */
  async rescueUnsaved(): Promise<boolean> {
    const unsaved = [...this.draftMap()].filter(([ch, text]) => this.savedDrafts.get(ch) !== text);
    if (unsaved.length === 0) return true;
    if (this.deps.rescue === undefined) {
      this.status(
        'not quitting: drafts could not be saved, and there is nowhere to rescue them',
        'warning',
        true,
      );
      return false;
    }
    try {
      for (const [channel, text] of unsaved) {
        const replyTo = this.composers.get(channel)?.replyTo;
        await this.deps.rescue.record(channel, text, replyTo === undefined ? {} : { replyTo });
        this.savedDrafts.set(channel, text);
      }
      return true;
    } catch (err) {
      this.status(
        `not quitting: drafts could not be saved or rescued (${message(err)})`,
        'warning',
        true,
      );
      return false;
    }
  }

  // ── sending ────────────────────────────────────────────────────────────────────────────────

  /** Enter in the composer: a slash command, or a send through the transaction. */
  async submit(): Promise<void> {
    const c = this.composer();
    if (c.text.trim() === '') return;
    // What goes out is what post resolves: each mention as its participant id, and a hand-typed
    // `@Name` that names exactly one participant of this channel the same way.
    const text = toWire(
      c.text,
      c.mentions ?? [],
      this.current === undefined ? undefined : this.nameIndex(this.current),
    );
    const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (slash !== null && /^[A-Za-z]/.test(slash[1] ?? '')) {
      await this.runCommand(slash[1] ?? '', slash[2] ?? '');
      return;
    }
    const channel = this.current;
    if (channel === undefined) {
      this.status('open a channel first: Ctrl+K lists them', 'caution');
      return;
    }
    const req: SendRequest = {
      channel,
      body: text,
      mode: this.mode,
      draftRevision: c.revision,
      ...(c.replyTo === undefined ? {} : { replyTo: c.replyTo }),
    };
    await this.sendRequest(req, { fromComposer: true });
  }

  /**
   * The one way the app sends: the transaction for words, post's emote path for an emote request,
   * both behind the same one-at-a-time admission, then the outcome on screen.
   */
  async sendRequest(req: SendRequest, opts: { fromComposer?: boolean } = {}): Promise<SendOutcome> {
    if (isEmoteRequest(req)) return this.sendEmote(req);
    if (this.sending) {
      const refused: SendOutcome = {
        kind: 'refused',
        code: 'in_flight',
        message: 'a send is already in flight; your draft is kept',
      };
      this.status(refused.message, 'caution');
      return refused;
    }
    this.sending = true;
    // Trey's words are on screen before post is asked anything, then replaced by the real record.
    const pending = this.addPending(req);
    this.status(req.mode === 'signed' ? 'sending signed…' : 'sending…');
    let outcome: SendOutcome;
    try {
      outcome = (await this.joinFirst(req.channel)) ?? (await this.deps.send(req));
    } catch (err) {
      outcome = { kind: 'refused', code: 'send_failed', message: message(err) };
    } finally {
      this.sending = false;
    }
    const channel = req.channel;
    if (outcome.kind === 'confirmed') {
      pending.id = outcome.id;
      // The real record is read now, not at the next poll tick; the pending entry stands until it
      // is in the view (or that read has been applied), so it never shows twice and never blinks.
      void this.deps.source
        .refreshChannel(channel)
        .catch(() => undefined)
        .then(() => this.dropPending(pending));
    } else {
      // Refused, or not known to have landed: nothing is pending any more. The banner below says
      // which, and an uncertain or committed send that did land arrives by the read right here.
      this.dropPending(pending);
      if (outcome.kind !== 'refused')
        void this.deps.source.refreshChannel(channel).catch(() => undefined);
    }
    if (opts.fromComposer === true) {
      const now = this.composer(channel);
      if (shouldClearDraft(outcome, req.draftRevision, now.revision)) {
        this.composers.set(channel, {
          text: '',
          caret: 0,
          revision: now.revision + 1,
          replyTo: undefined,
          mentions: [],
        });
        this.picker = undefined;
        this.scheduleAutosave();
      }
    }
    switch (outcome.kind) {
      case 'confirmed': {
        this.ownIds.add(outcome.id);
        this.deps.source.trackConfirmed(channel, outcome.id);
        this.crossed = this.crossedStripOn
          ? crossedStrip(channel, outcome.id, outcome.crossed)
          : undefined;
        // What Trey just said shows with the newest, not in a window held around an old hit.
        this.detached.delete(channel);
        const pane = this.panes.findIndex((p) => p.channel === channel);
        if (pane !== -1) this.setPane(pane, { scroll: 0, pick: undefined });
        this.status(req.mode === 'signed' ? 'sent signed; verifying' : 'sent', 'good');
        this.stageEvent({ kind: 'sent', channel, id: outcome.id, mode: req.mode });
        break;
      }
      case 'committed':
        this.status(
          `post took it but answered oddly (${outcome.code}); check before resending`,
          'caution',
          true,
        );
        break;
      case 'uncertain':
        this.status(`send uncertain (${outcome.reason}); kept for /restore`, 'warning', true);
        break;
      case 'refused':
        this.status(`not sent: ${outcome.message}`, 'warning', true);
        break;
    }
    void this.deps.source.refreshChannels().catch(() => undefined);
    this.touch();
    return outcome;
  }

  /** Show `req` as Trey's own message, dimmed with `sending…`, at the bottom of its channel. */
  private addPending(req: SendRequest): PendingSend {
    const owner = this.deps.owner;
    const raw: RawRecord = Object.freeze({
      file: 'msg',
      storageChannel: req.channel,
      envelope: Object.freeze({}),
      id: `pending-${++this.pendingSeq}`,
      from: owner.room,
      channel: req.channel,
      sent: new Date((this.deps.wallClock ?? Date.now)()).toISOString(),
      fromParticipant: owner.participant,
      ...(req.replyTo === undefined ? {} : { re: req.replyTo }),
      mentions: Object.freeze([]),
      // As post stores a casual send, so the display strips the marker the way it does for the real one.
      body: req.mode === 'casual' ? `${owner.marker} ${req.body}` : req.body,
      bodyComplete: true,
      signature: { present: false },
    } as const);
    const shown = toDisplay(raw, {
      anchor: this.deps.anchor,
      verdict: { state: 'unsigned', reason: 'not sent yet' },
    });
    const pending: PendingSend = {
      key: this.pendingSeq,
      channel: req.channel,
      id: undefined,
      shown: { ...shown, pending: true },
      after: this.liveRecords(req.channel).at(-1)?.id ?? '',
    };
    this.pendingSends.set(pending.key, pending);
    // What he just said shows at the newest, not in a window held around an old hit.
    this.detached.delete(req.channel);
    const pane = this.panes.findIndex((p) => p.channel === req.channel);
    if (pane !== -1) this.setPane(pane, { scroll: 0, pick: undefined });
    this.touch();
    return pending;
  }

  private dropPending(pending: PendingSend): void {
    if (this.pendingSends.delete(pending.key)) this.touch();
  }

  /** The pending sends of `channel` whose real record is not in `live` (never both on screen). */
  private pendingFor(channel: string, live: readonly RawRecord[]): DisplayRecord[] {
    const out: DisplayRecord[] = [];
    for (const p of this.pendingSends.values()) {
      if (p.channel !== channel) continue;
      // The receipt names the real record. A read can also bring it before the receipt comes back:
      // then it is the new record from Trey's room with exactly the words sent.
      const landed =
        p.id !== undefined
          ? live.some((r) => r.id === p.id)
          : live.some(
              (r) => r.id > p.after && r.from === p.shown.raw.from && r.body === p.shown.raw.body,
            );
      if (landed) continue;
      out.push(p.shown);
    }
    return out;
  }

  /** An emote: no signature, no recovery record, no `sent` stage event, never wakes agents. */
  private async sendEmote(req: EmoteSendRequest): Promise<SendOutcome> {
    if (this.deps.sendEmote === undefined) {
      const refused: SendOutcome = {
        kind: 'refused',
        code: 'no_emote_route',
        message: 'emotes cannot be sent from here',
      };
      this.status(`not sent: ${refused.message}`, 'warning', true);
      return refused;
    }
    if (this.sending) {
      const refused: SendOutcome = {
        kind: 'refused',
        code: 'in_flight',
        message: 'a send is already in flight; nothing sent',
      };
      this.status(refused.message, 'caution');
      return refused;
    }
    this.sending = true;
    this.touch();
    let outcome: SendOutcome;
    try {
      outcome =
        (await this.joinFirst(req.channel)) ??
        (await this.deps.sendEmote(req.channel, req.emote.name, req.emote.at));
    } catch (err) {
      outcome = { kind: 'refused', code: 'send_failed', message: message(err) };
    } finally {
      this.sending = false;
    }
    if (outcome.kind === 'confirmed') this.ownIds.add(outcome.id);
    if (outcome.kind === 'refused') this.status(`not sent: ${outcome.message}`, 'warning', true);
    void this.deps.source.refreshChannels().catch(() => undefined);
    this.touch();
    return outcome;
  }

  /**
   * Dispatch on the exact first token; an unknown `/word` is refused and the draft kept.
   *
   * A command's own text is not a draft: it leaves the composer when the command starts (so `/quit`
   * saves the drafts without it), and the model holds it until the command is done. It comes back
   * if the command failed or a send it made does not allow clearing (`shouldClearDraft`: refused),
   * unless something newer was typed meanwhile, which is kept instead.
   */
  async runCommand(name: string, args: string): Promise<void> {
    const cmd = command(name.toLowerCase() === name ? name : '');
    if (cmd === undefined) {
      this.status(`unknown command /${name}; nothing sent, draft kept`, 'warning');
      return;
    }
    if (cmd.needsChannel && this.current === undefined) {
      this.status(`/${cmd.name} needs an open channel`, 'caution');
      return;
    }
    const channel = this.current;
    const held = this.composer(channel);
    let cleared: number | undefined;
    if (channel !== undefined) {
      cleared = held.revision + 1;
      this.composers.set(channel, { ...held, text: '', caret: 0, revision: cleared, mentions: [] });
      this.picker = undefined;
      this.scheduleAutosave();
    }
    const outcomes: SendOutcome[] = [];
    const ran = await this.invoke(cmd.name, args, (_req, outcome) => outcomes.push(outcome));
    if (channel === undefined || cleared === undefined) return;
    // Each outcome against its own request (newer typing is the revision check that follows).
    const keep = !ran || outcomes.some((o) => !shouldClearDraft(o, 0, 0));
    if (!keep || this.composer(channel).revision !== cleared) return;
    this.composers.set(channel, { ...held, revision: cleared + 1 });
    this.scheduleAutosave();
    if (channel === this.current) this.updatePicker();
    this.touch();
  }

  /**
   * Run a registered command with `args` (a slash command, or pick mode's `c`, `s` and `1`–`9`).
   * Its word sends go through the same transaction as the composer's; `ctx.send.emotes` says an
   * emote request is routed to post's emote path. False when the command failed or did not run.
   */
  async invoke(
    name: string,
    args: string,
    onSend?: (req: SendRequest, outcome: SendOutcome) => void,
  ): Promise<boolean> {
    const cmd = command(name);
    if (cmd === undefined) return false;
    if (cmd.needsChannel && this.current === undefined) {
      this.status(`/${cmd.name} needs an open channel`, 'caution');
      return false;
    }
    const send = async (req: SendRequest) => {
      const outcome = await this.sendRequest(req);
      onSend?.(req, outcome);
      return outcome;
    };
    const ctx: CommandContext = {
      state: this.state(),
      send: this.deps.sendEmote === undefined ? send : Object.assign(send, { emotes: true }),
      status: (text) => this.status(text),
      openOverlay: (id) => this.openOverlay(id),
    };
    let ok = true;
    try {
      await cmd.run(args.trim(), ctx);
    } catch (err) {
      ok = false;
      this.status(`/${cmd.name} failed: ${message(err)}`, 'warning');
    }
    this.touch();
    return ok;
  }

  /** Ctrl+S: flip the next sends between casual and signed, only when signing is armed. */
  toggleSigned(): void {
    if (this.deps.signingBlocked !== undefined) {
      this.status(`signing refused: ${this.deps.signingBlocked}`, 'warning');
      return;
    }
    if (!this.deps.armed) {
      this.status('signing is not armed (restart Porch and arm it to sign)', 'caution');
      return;
    }
    this.mode = this.mode === 'signed' ? 'casual' : 'signed';
    this.status(
      this.mode === 'signed'
        ? 'SIGNED: the next sends go out signed'
        : 'CASUAL: sends are unsigned',
    );
  }

  // ── reading actions ────────────────────────────────────────────────────────────────────────

  /**
   * Ctrl+U: acknowledge through the newest attention-eligible record the pane shows. Only a frame
   * of this channel counts, and only its own records: before the first frame after a switch there
   * is nothing on screen to mark.
   */
  async acknowledge(): Promise<void> {
    const channel = this.current;
    if (channel === undefined) return;
    const view = this.paneViews.get(this.focusedPane);
    const visible =
      view?.channel === channel ? view.visible.filter((r) => r.storageChannel === channel) : [];
    const r = await this.deps.source.acknowledge(channel, visible);
    if (r.ok) {
      this.dividers.delete(channel);
      this.status('marked read through what you can see', 'good');
      await this.deps.source.refreshChannels().catch(() => undefined);
    } else if (r.error.code === 'nothing_to_mark') this.status('nothing on screen to mark read');
    else this.status(`could not mark read: ${r.error.message}`, 'warning');
    this.touch();
  }

  /** Ctrl+G: back to the newest messages (leaving a window held around a search hit). */
  jumpLatest(): void {
    const channel = this.pane().channel;
    if (channel !== undefined && this.detached.delete(channel)) this.status('back to the newest');
    this.setPane(this.focusedPane, { scroll: 0, pick: undefined });
  }

  scroll(by: number): void {
    const p = this.pane();
    this.setPane(this.focusedPane, { scroll: Math.max(0, p.scroll + by) });
  }

  /** Ctrl+O: 100 older messages, up to the window's bound. */
  async loadOlder(channel = this.current): Promise<void> {
    if (channel === undefined) return;
    if (this.deps.history === undefined) {
      this.status('older history is not available here');
      return;
    }
    if (this.detached.has(channel)) {
      await this.olderHeld(channel);
      return;
    }
    const have = this.records(channel).length;
    if (this.beginning.has(channel)) {
      this.status(`already at the beginning of #${channel}`);
      return;
    }
    if (have >= MAX_WINDOW) {
      this.status(`the window holds the newest ${MAX_WINDOW}; Ctrl+F searches the rest`);
      return;
    }
    const r = await this.deps.history(channel, Math.min(MAX_WINDOW, have + OLDER_STEP));
    if (!r.ok) {
      this.status(`could not load older messages: ${r.error.message}`, 'warning');
      return;
    }
    const merged = mergeRecords(this.older.get(channel) ?? [], r.value, MAX_WINDOW);
    this.older.set(channel, merged);
    if (this.records(channel).length <= have) {
      this.beginning.add(channel);
      this.status(`already at the beginning of #${channel}`);
    } else this.status(`loaded ${this.records(channel).length - have} older messages`);
    this.verifyOlder();
    this.touch();
  }

  /** Ctrl+O in a window held around a hit: 100 older, dropping the newest past the bound. */
  private async olderHeld(channel: string): Promise<void> {
    const held = this.detached.get(channel);
    if (held === undefined || this.deps.history === undefined) return;
    if (held.start) {
      this.status(`already at the beginning of #${channel}`);
      return;
    }
    const limit = held.after + held.records.length + OLDER_STEP;
    if (limit > JUMP_REACH) {
      this.status(`Porch does not reach more than ${JUMP_REACH} back`, 'caution');
      return;
    }
    const r = await this.deps.history(channel, limit);
    if (!r.ok) {
      this.status(`could not load older messages: ${r.error.message}`, 'warning');
      return;
    }
    const all = r.value;
    const oldest = held.records[0]?.id;
    const at = oldest === undefined ? -1 : all.findIndex((x) => x.id === oldest);
    if (at === -1) {
      this.status('the channel changed under this window; Ctrl+G returns to the newest', 'caution');
      return;
    }
    const from = Math.max(0, at - OLDER_STEP);
    const to = Math.min(at + held.records.length, from + MAX_WINDOW);
    this.detached.set(channel, {
      records: all.slice(from, to),
      after: all.length - to,
      start: from === 0 && all.length < limit,
    });
    this.status(
      at - from === 0
        ? `already at the beginning of #${channel}`
        : `loaded ${at - from} older messages`,
    );
    this.verifyOlder();
    this.touch();
  }

  /** Records only Ctrl+O loaded are verified here, with the same scheduler the store uses. */
  private verifyOlder(): void {
    if (this.olderVerifier === undefined)
      this.olderVerifier = new VerificationScheduler(
        this.deps.anchor,
        (raw, verdict) => this.setOlderVerdicts([{ raw, verdict }]),
        this.deps.verify ?? verify,
        { batch: (changes) => this.setOlderVerdicts(changes) },
      );
    const loaded = [...this.older.values(), ...[...this.detached.values()].map((d) => d.records)];
    const channels = new Set([...this.older.keys(), ...this.detached.keys()]);
    const live = new Set(
      [...channels].flatMap((c) =>
        (this.deps.source.getState().views[c]?.records ?? []).map((r) => r.id),
      ),
    );
    this.olderVerifier.window(loaded.flat().filter((r) => !live.has(r.id)));
  }

  private setOlderVerdicts(changes: readonly { raw: RawRecord; verdict: Verdict }[]): void {
    for (const { raw, verdict } of changes)
      this.olderVerdicts.set(`${raw.storageChannel}/${raw.id}`, verdict);
    this.redraw();
  }

  /** Tab: the next lane that needs Trey, after the current one. */
  nextNeedsYou(): void {
    const lanes = this.lanes();
    const at = this.current === undefined ? -1 : lanes.indexOf(this.current);
    for (let k = 1; k <= lanes.length; k++) {
      const lane = lanes[(at + k) % lanes.length];
      if (lane === undefined || !this.needsYou(lane)) continue;
      if (lane === this.current) {
        this.status('this lane needs you; no other does');
        return;
      }
      void this.openChannel(lane);
      this.status(`#${lane} needs you`);
      return;
    }
    this.status('all clear: nobody needs you', 'good');
  }

  lane(n: number): void {
    const lane = this.lanes()[n - 1];
    if (lane === undefined) this.status(`there is no lane ${n}`);
    else void this.openChannel(lane);
  }

  toggleSplit(): void {
    if (layoutKind(this.cols) !== 'wide') {
      this.status('the split needs a wide terminal (140 columns or more)');
      return;
    }
    this.split = !this.split;
    this.syncPanes();
    this.paneViews.clear();
    this.touch();
  }

  // ── pick mode ──────────────────────────────────────────────────────────────────────────────

  /** Records a pick can land on: messages, not emotes or events (never reply targets). */
  pickable(channel = this.current): RawRecord[] {
    if (channel === undefined) return [];
    return this.records(channel).filter((r) => this.display(r, channel).kind === 'message');
  }

  pick(id: string | undefined): void {
    this.setPane(this.focusedPane, { pick: id });
    this.ensurePick = id !== undefined;
  }

  /** Ctrl+↑/↓ and ↑/↓ in pick mode: the previous or next message; past the newest clears. */
  movePick(dir: -1 | 1): void {
    const list = this.pickable();
    if (list.length === 0) return;
    const at =
      this.pane().pick === undefined ? -1 : list.findIndex((r) => r.id === this.pane().pick);
    if (at === -1) {
      if (dir === -1) this.pick(list.at(-1)?.id);
      return;
    }
    const next = list[at + dir];
    if (next === undefined && dir === 1) this.pick(undefined);
    else if (next !== undefined) this.pick(next.id);
  }

  /** `/reply <prefix>`: the one loaded message whose id (or short id) starts with it. */
  replyByPrefix(prefix: string): void {
    if (prefix === '') {
      this.setReply(undefined);
      this.status('reply cleared');
      return;
    }
    const hits = this.pickable().filter(
      (r) => r.id.startsWith(prefix) || shortId(r.id).startsWith(prefix),
    );
    if (hits.length === 1 && hits[0] !== undefined) this.setReply(hits[0].id);
    else
      this.status(
        hits.length === 0
          ? `no loaded message matches ${prefix}`
          : `${prefix} matches ${hits.length} messages`,
        'caution',
      );
  }

  /** `/crossed [on|off]`: show or hide the crossed strip for this session; no argument flips it. */
  setCrossedStrip(arg: string): void {
    const a = arg.trim().toLowerCase();
    if (a !== '' && a !== 'on' && a !== 'off') {
      this.status('usage: /crossed [on|off]', 'caution');
      return;
    }
    this.crossedStripOn = a === '' ? !this.crossedStripOn : a === 'on';
    if (!this.crossedStripOn) this.crossed = undefined;
    this.status(`crossed strip ${this.crossedStripOn ? 'on' : 'off'} for this session`);
    this.touch();
  }

  /** Esc outside an overlay: the pick, then the reply target, then the strip, then the notice. */
  escape(): void {
    if (this.pane().pick !== undefined) this.pick(undefined);
    else if (this.composer().replyTo !== undefined) this.setReply(undefined);
    else if (this.crossed !== undefined) {
      this.crossed = undefined;
      this.touch();
    } else if (this.notice !== undefined) {
      this.notice = undefined;
      this.touch();
    } else if (this.helpFallback) this.closeOverlay();
  }

  focus(focused: boolean): void {
    this.focused = focused;
    if (focused) void this.deps.source.regainFocus();
    this.stageEvent({ kind: 'focus', focused });
    this.snapshot = undefined;
  }
}

export function emptyPane(): PaneState {
  return { channel: undefined, scroll: 0, pick: undefined };
}

/** The crossed strip for a confirmed send, when the receipt says messages crossed it. */
export function crossedStrip(
  channel: string,
  sentId: string,
  crossed: Crossed | undefined,
): CrossedStrip | undefined {
  return crossed === undefined || crossed.unseen <= 0 ? undefined : { channel, sentId, crossed };
}

/**
 * Which channel opens at launch: the one asked for if Trey has joined it, else (when none was asked
 * for) the one he was last in if it is still joined, else the configured initial channel if joined, else the first joined channel, else none. Porch never joins one.
 */
export function pickLaunchChannel(
  requested: string | undefined,
  initial: string,
  joined: readonly string[],
  remembered?: string,
): string | undefined {
  if (requested !== undefined && joined.includes(requested)) return requested;
  if (requested === undefined && remembered !== undefined && joined.includes(remembered))
    return remembered;
  if (joined.includes(initial)) return initial;
  return joined[0];
}

/** Attention-eligible records in `records` (re-exported for views). */
export function eligible(
  records: readonly RawRecord[],
  self: { room: string; participant: string },
) {
  return records.filter((r) => isAttentionEligible(r, self));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
