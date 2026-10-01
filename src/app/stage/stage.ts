/**
 * The stage strip (plan T7): each pane's crew standing as full-body sprites with a name tag and a
 * magenta task line, or one row of heads when the pane is short, plus the motion that happens on
 * it and the attract screen drawn over everything.
 *
 * Motion follows ruling 4 as adjusted after the renderer probe. Nothing here owns a timer that
 * draws: every movement is a finite burst from `actions.animate`, whose clock samples the 125 ms
 * grid and renders only when displayed cells change, and draws nothing once the last burst ends.
 * The moving things are:
 * - an emote, played once on arrival from its frozen payload (`@estate/pixel`'s player), and again
 *   when Trey picks its record; a payload that does not play shows the generic bubble instead;
 * - the READY! hop: each participant newly in post's seen set for Trey's latest send hops once
 *   (post-kit's `seenBy` stream reaches the stage as `seen` events); several readers in one poll
 *   hop one after another, 250 ms apart;
 * - the power-up plate for a signed send;
 * - the attract screen's one burst.
 * Several emotes from one sender queue rather than cut each other off (at most four wait). Any key
 * skips every flourish to its end state (keybinding layer 3) and passes on; on the attract screen
 * any key dismisses it and is consumed (layer 2).
 *
 * `PORCH_MOTION=reduced` shows end states: an emote's final frame held for its length, the READY
 * mark without the hop, the plate without the flash, the attract screen still. `off` shows no
 * motion at all: emotes appear only as their line in the stream, and only the read marks change.
 *
 * The one timer here is the attract screen's idle check (10 minutes without input). It draws
 * nothing itself; when it finds Porch idle it starts the attract screen's bounded burst.
 */
import {
  type EmotePlayer,
  type FrozenEmote,
  NAME_GRAMMAR,
  playEmote,
  type SpriteFrame,
} from '@estate/pixel';
import { type DisplayRecord, isAttentionEligible } from '@estate/post-kit';
import type { Grid, Rect } from '../../grid/grid.ts';
import type { Burst } from '../../host/animation-clock.ts';
import { FRAME_MS } from '../../host/animation-clock.ts';
import type { Key, KeyResult, Stage, StageEvent, StageFit, StagePane } from '../registry.ts';
import type { AppState } from '../state.ts';
import { ATTRACT_MS, attractSeen, drawAttract, markAttractSeen, stateDir } from './attract.ts';
import { attributable, type CrewMember, crewFor, NO_TASK } from './crew.ts';
import { drawPowerUp, POWER_UP_MS } from './power-up.ts';
import { drawSprite, restingPixels, SIZE, type Target } from './sprites.ts';
import { centre, trunc } from './text.ts';
import { T } from './theme.ts';

/**
 * Strip heights (plan T7: bodies 10). A body fills its strip exactly: eight sprite rows, the name,
 * the task line. A hop lifts the sprite one row, so its top row clips at the strip's edge for the
 * two frames it is up, and the gap under its feet shows the jump. Heads keep a row of headroom.
 * Neither strip has room above its sprite for a whole particle, so `drawSprite` starts one over
 * the sprite's top-right corner and lets it rise out of the strip.
 */
export const STAGE_HEIGHT: Readonly<Record<StageFit, number>> = { bodies: 10, heads: 6 };
/** Columns per member: a body is 16 wide, a head 8, plus a gap. */
const SLOT_MIN: Readonly<Record<StageFit, number>> = { bodies: 18, heads: 10 };
const SLOT_MAX: Readonly<Record<StageFit, number>> = { bodies: 26, heads: 12 };
/** Columns the overflow count needs: ` +NN more` for bodies, ` +NN` for heads. */
const MORE_W: Readonly<Record<StageFit, number>> = { bodies: 9, heads: 4 };

/** How many members fit in a strip of `area`, and each one's slot width. */
export function slots(
  area: Rect,
  fitKind: StageFit,
  count: number,
): { visible: number; slotW: number } {
  const min = SLOT_MIN[fitKind];
  const all = Math.floor(area.w / min) >= count;
  // When some must be hidden, the overflow count's columns come off the top first.
  const room = all ? area.w : area.w - MORE_W[fitKind];
  const visible = all ? count : Math.max(1, Math.floor(room / min));
  const slotW = Math.max(min, Math.min(SLOT_MAX[fitKind], Math.floor(room / Math.max(1, visible))));
  return { visible, slotW };
}

/** Where member `i` of `count` stands: its slot, its sprite's top-left cell, its tag rows. */
export type MemberBox = {
  x: number;
  slotW: number;
  spriteX: number;
  spriteY: number;
  nameY: number;
  /** Bodies only: heads have no task line. */
  taskY: number | undefined;
};

/** The strip is laid out from the bottom up, so a shorter strip loses headroom first. */
export function memberBox(area: Rect, fitKind: StageFit, count: number, i: number): MemberBox {
  const { slotW } = slots(area, fitKind, count);
  const size = SIZE[fitKind === 'bodies' ? 'body' : 'head'];
  const bottom = area.y + area.h - 1;
  const nameY = fitKind === 'bodies' ? bottom - 1 : bottom;
  const x = area.x + i * slotW;
  return {
    x,
    slotW,
    spriteX: x + Math.floor((slotW - 1 - size.w) / 2),
    spriteY: nameY - size.h,
    nameY,
    taskY: fitKind === 'bodies' ? bottom : undefined,
  };
}

/** One hop: up for two frames, down, with READY! under the sprite throughout. */
export const HOP_MS = 750;
const HOP_UP_FRAMES = 2;
/** Readers seen in one poll hop one after another, this far apart. */
export const HOP_STAGGER_MS = 250;
/** How long a bubble record's generic bubble stays up. */
export const BUBBLE_MS = 1500;
/** Emotes waiting behind the one playing, per sender; more are dropped (the stream keeps them). */
const MAX_QUEUED = 4;
/** Ten minutes without input. */
export const IDLE_MS = 600_000;
/** When the idle check finds a reason not to show the screen, it looks again this much later. */
const IDLE_RECHECK_MS = 60_000;

export const READY = 'READY!';
export const READ_MARK = '✓';

export type IdleTimers = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const wallTimers: IdleTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type StageOptions = {
  /** The marker directory, resolved when first needed (default: {@link stateDir}). */
  stateDir?: () => string;
  /** Wall-clock timers for the idle check (tests pass their own). */
  timers?: IdleTimers;
  idleMs?: number;
};

/** A span of clock time something shows for, inside the burst that draws it. */
type Timed = { burst: Burst; from: number; to: number };
type Play =
  | (Timed & {
      kind: 'emote';
      emote: FrozenEmote;
      label: string;
      reduced: boolean;
      players: Partial<Record<Target, EmotePlayer>>;
    })
  | (Timed & { kind: 'bubble'; label: string });

export type PorchStage = Stage &
  Required<Pick<Stage, 'event' | 'key' | 'drawOver'>> & {
    /** Whether the attract screen is up (tests). */
    readonly attracting: boolean;
    /** Stop the idle timer and every burst. */
    dispose(): void;
  };

const key = (channel: string, participant: string) => `${channel}\u0000${participant}`;

export function createStage(opts: StageOptions = {}): PorchStage {
  const timers = opts.timers ?? wallTimers;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const dir = opts.stateDir ?? (() => stateDir());

  const plays = new Map<string, Play[]>();
  const hops = new Map<string, Timed>();
  const lastHop = new Map<string, number>();
  const power = new Map<string, Timed>();
  const readBy = new Map<string, { id: string; seen: Set<string> }>();
  const known = new Map<string, Set<string>>();
  /**
   * The channels in post's listing when the stage first saw one: what Porch loads at startup. A
   * startup channel's first arrival is its initial load (history); every other arrival is live,
   * a channel's first included once it appeared after startup. Undefined until a listing exists,
   * and until then every first arrival counts as startup history.
   */
  let startup: ReadonlySet<string> | undefined;
  const noteStartup = (s: AppState): void => {
    if (startup === undefined && s.channels.length > 0)
      startup = new Set(s.channels.map((c) => c.name));
  };
  const lastPick = new Map<string, string | undefined>();
  /** The attract screen while it is up. */
  let attract: { burst: Burst | undefined } | undefined;
  /** The first-launch marker's directory, while the first-launch screen is still owed. */
  let firstOwed: string | undefined;
  let launched = false;
  let lastState: AppState | undefined;
  let lastInput = timers.now();
  let idleTimer: unknown;

  // ── Bookkeeping ─────────────────────────────────────────────────────────────────────────────

  const allTimed = (): Timed[] => [
    ...[...plays.values()].flat(),
    ...hops.values(),
    ...power.values(),
  ];

  /** Queue `ms` of display after `after`, inside one burst that lasts until it ends. */
  const schedule = (s: AppState, ms: number, after: number): Timed => {
    const wait = Math.max(0, after - s.now);
    const burst = s.actions.animate(wait + ms);
    const from = Math.max(burst.start, after);
    return { burst, from, to: from + ms };
  };

  const shown = (s: AppState, channel: string) => s.panes.some((p) => p.channel === channel);

  /** The first time the stage hears of a channel, everything in it is history and plays nothing. */
  const baseline = (s: AppState, channel: string, extra: readonly DisplayRecord[] = []): void => {
    if (known.has(channel)) return;
    const view = s.views.get(channel);
    const records = view?.records ?? [];
    const loaded = records.length > 0 || extra.length > 0 || view?.summary?.messages === 0;
    if (!loaded) return;
    known.set(channel, new Set([...records, ...extra].map((r) => r.raw.id)));
  };

  const emoteName = (r: DisplayRecord): string | undefined => {
    const payload = r.raw.envelope.emote;
    const name =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).name
        : undefined;
    return typeof name === 'string' && NAME_GRAMMAR.test(name) ? name : undefined;
  };

  const enqueue = (s: AppState, channel: string, r: DisplayRecord): void => {
    const participant = r.raw.fromParticipant;
    const parse = r.raw.emote;
    if (participant === undefined || parse === undefined || parse.verdict === 'omitted') return;
    // Arrival and picked replay alike: nothing unverified moves Trey's avatar (or anyone's).
    if (!attributable(r, s)) return;
    if (s.motion === 'off') return;
    const k = key(channel, participant);
    const queue = (plays.get(k) ?? []).filter((p) => p.to > s.now);
    if (queue.length > MAX_QUEUED) return;
    const after = queue.at(-1)?.to ?? s.now;
    if (parse.verdict === 'playable' && parse.emote !== null) {
      const emote = parse.emote;
      const target = emote.at === undefined ? '' : ` → ${s.names.get(emote.at) ?? emote.at}`;
      const duration = emote.steps.reduce((sum, step) => sum + step.ms, 0);
      queue.push({
        ...schedule(s, duration, after),
        kind: 'emote',
        emote,
        label: `✦ ${emote.name}${target}`,
        reduced: s.motion === 'reduced',
        players: {},
      });
    } else {
      queue.push({
        ...schedule(s, BUBBLE_MS, after),
        kind: 'bubble',
        label: `✦ ${emoteName(r) ?? 'emoted'}`,
      });
    }
    plays.set(k, queue);
  };

  const hop = (s: AppState, channel: string, participant: string): void => {
    // Reduced motion shows the tag for the hop's whole span, without the lift (see `draw`).
    if (s.motion === 'off' || !shown(s, channel)) return;
    const after = Math.max(s.now, (lastHop.get(channel) ?? -Infinity) + HOP_STAGGER_MS);
    const timed = schedule(s, HOP_MS, after);
    lastHop.set(channel, timed.from);
    hops.get(key(channel, participant))?.burst.cancel();
    hops.set(key(channel, participant), timed);
  };

  /** Skip every flourish to its end state; true when one was showing or waiting to. */
  const skip = (now: number): boolean => {
    const live = allTimed().filter((t) => t.to > now);
    for (const t of allTimed()) t.burst.cancel();
    plays.clear();
    hops.clear();
    power.clear();
    lastHop.clear();
    return live.length > 0;
  };

  // ── The attract screen ──────────────────────────────────────────────────────────────────────

  const quiet = (s: AppState) =>
    s.composer.text === '' && ![...s.views.values()].some((v) => v.needsYou);

  /** `drawing`: called while a frame is being drawn, which already shows it. */
  const showAttract = (s: AppState, drawing = false): void => {
    if (attract !== undefined) return;
    skip(s.now);
    attract = { burst: s.motion === 'full' ? s.actions.animate(ATTRACT_MS) : undefined };
    // Shown, by either road: the first-launch screen is no longer owed.
    if (firstOwed !== undefined) {
      markAttractSeen(firstOwed);
      firstOwed = undefined;
    }
    if (!drawing) s.actions.requestFrame();
  };

  const dismissAttract = (s: AppState | undefined): void => {
    if (attract === undefined) return;
    attract.burst?.cancel();
    attract = undefined;
    armIdle(idleMs);
    s?.actions.requestFrame();
  };

  const armIdle = (ms: number): void => {
    if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
    idleTimer = timers.setTimeout(checkIdle, ms);
  };

  function checkIdle(): void {
    idleTimer = undefined;
    const s = lastState;
    if (s === undefined || attract !== undefined) return;
    const idle = timers.now() - lastInput;
    if (idle < idleMs) {
      armIdle(idleMs - idle);
      return;
    }
    if (!quiet(s)) {
      armIdle(IDLE_RECHECK_MS);
      return;
    }
    showAttract(s);
  }

  /**
   * On the first draw, find out whether the first-launch screen is owed (no marker yet). While it
   * is, each draw shows it as soon as Porch is quiet (no draft, no lane needing Trey); the marker
   * is written only once it has actually shown.
   */
  const firstLaunch = (s: AppState): void => {
    if (!launched) {
      launched = true;
      armIdle(idleMs);
      try {
        const path = dir();
        if (!attractSeen(path)) firstOwed = path;
      } catch {
        firstOwed = undefined;
      }
    }
    // Only ever reached from a draw, whose drawOver layer shows it in this same frame.
    if (firstOwed !== undefined && attract === undefined && quiet(s)) showAttract(s, true);
  };

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────────

  const current = <X extends Timed>(items: readonly X[] | undefined, now: number) =>
    items?.find((t) => t.from <= now && now < t.to);

  const frameOf = (play: Play, target: Target, now: number): SpriteFrame | undefined => {
    if (play.kind !== 'emote') return undefined;
    let player = play.players[target];
    if (player === undefined) {
      player = playEmote(play.emote, target, play.reduced ? 'reduced' : 'full');
      play.players[target] = player;
    }
    return player.frameAt(now - play.from) ?? undefined;
  };

  const replayPicked = (s: AppState, channel: string): void => {
    const pick = s.panes.find((p) => p.channel === channel && p.pick !== undefined)?.pick;
    if (lastPick.get(channel) === pick) return;
    lastPick.set(channel, pick);
    if (pick === undefined) return;
    const r = s.views.get(channel)?.records.find((x) => x.raw.id === pick);
    if (r?.kind === 'emote') enqueue(s, channel, r);
  };

  const drawMember = (
    g: Grid,
    s: AppState,
    area: Rect,
    fitKind: StageFit,
    channel: string,
    m: CrewMember,
    box: MemberBox,
  ): void => {
    const target: Target = fitKind === 'bodies' ? 'body' : 'head';
    const { x, slotW, nameY, taskY } = box;
    const k = key(channel, m.id);
    const play = current(plays.get(k), s.now);
    const hopping = hops.get(k);
    const hopOn = hopping !== undefined && hopping.from <= s.now && s.now < hopping.to;
    const lift =
      hopOn &&
      s.motion === 'full' &&
      Math.floor((s.now - (hopping?.from ?? 0)) / FRAME_MS) < HOP_UP_FRAMES
        ? 1
        : 0;
    const frame = play === undefined ? undefined : frameOf(play, target, s.now);
    drawSprite(
      g,
      box.spriteX,
      box.spriteY,
      target,
      restingPixels(m.pack, target),
      { isOwner: m.isOwner, accent: m.accent, mono: s.noColor === true },
      area,
      frame,
      lift,
    );

    const read = readBy.get(channel)?.seen.has(m.id) === true && !m.isOwner;
    const tagW = slotW - 1;
    if (fitKind === 'heads' && hopOn) {
      g.text(x, nameY, trunc(READY, tagW), { fg: T.green, bold: true });
    } else {
      const mark = read ? ` ${READ_MARK}` : '';
      const name = trunc(m.name, tagW - mark.length);
      const w = g.text(x, nameY, name, { fg: m.accentHex, bold: true }, tagW);
      // A second member of the same name: the hint in gray after it, in what the tag has left.
      const left = tagW - mark.length - w - 1;
      const hw =
        m.hint !== '' && left >= 3
          ? g.text(x + w + 1, nameY, trunc(m.hint, left), { fg: T.gray }, tagW)
          : 0;
      if (read) g.text(x + w + (hw > 0 ? hw + 1 : 0), nameY, mark, { fg: T.green, bold: true });
    }
    if (taskY === undefined) return;
    if (hopOn) g.text(x, taskY, trunc(READY, tagW), { fg: T.green, bold: true });
    else if (play !== undefined)
      g.text(x, taskY, trunc(play.label, tagW), { fg: T.white, bold: true });
    // Cyan is Trey: his own line says what he last said, in his colour; an agent's is magenta,
    // where it is headed.
    else
      g.text(x, taskY, trunc(m.task, tagW), {
        fg: m.task === NO_TASK ? T.grayDim : m.isOwner ? T.cyan : T.magenta,
      });
  };

  const stage: PorchStage = {
    get attracting() {
      return attract !== undefined;
    },

    height(fitKind) {
      return STAGE_HEIGHT[fitKind];
    },

    draw(g: Grid, area: Rect, pane: StagePane, s: AppState): void {
      lastState = s;
      noteStartup(s);
      firstLaunch(s);
      const channel = pane.channel;
      if (channel === undefined || area.w <= 0 || area.h <= 0) return;
      baseline(s, channel);
      replayPicked(s, channel);
      const crew = crewFor(channel, s);
      g.withClip(area, () => {
        if (crew.length === 0) {
          const empty = 'the stage is empty';
          g.text(centre(area.x, area.w, empty), area.y + Math.floor(area.h / 2), empty, {
            fg: T.gray,
          });
          return;
        }
        const { visible, slotW } = slots(area, pane.fit, crew.length);
        for (let i = 0; i < visible; i++) {
          const m = crew[i];
          if (m !== undefined)
            drawMember(g, s, area, pane.fit, channel, m, memberBox(area, pane.fit, crew.length, i));
        }
        const more = crew.length - visible;
        if (more > 0) {
          const label = pane.fit === 'bodies' ? `+${more} more` : `+${more}`;
          const y = area.y + area.h - (pane.fit === 'bodies' ? 6 : 3);
          g.text(area.x + visible * slotW, y, label, { fg: T.gray, bold: true }, MORE_W[pane.fit]);
        }
        const plate = power.get(channel);
        if (plate !== undefined && plate.from <= s.now && s.now < plate.to)
          drawPowerUp(
            g,
            area,
            s.motion === 'full' ? Math.floor((s.now - plate.from) / FRAME_MS) : undefined,
            s.noColor === true,
          );
      });
    },

    drawOver(g: Grid, area: Rect, s: AppState): void {
      lastState = s;
      firstLaunch(s);
      if (attract === undefined) return;
      const b = attract.burst;
      const k =
        b !== undefined && b.start <= s.now && s.now < b.end
          ? Math.floor((s.now - b.start) / FRAME_MS)
          : undefined;
      drawAttract(g, area, s, k);
    },

    event(e: StageEvent, s: AppState): void {
      lastState = s;
      noteStartup(s);
      switch (e.kind) {
        case 'arrival': {
          const self = {
            room: s.owner.room,
            participant: s.owner.participant,
            receiptIds: s.ownMessageIds,
          };
          const calls = (r: DisplayRecord) => isAttentionEligible(r.raw, self);
          if (!known.has(e.channel)) {
            // A channel heard of for the first time: its records play nothing. If it was loaded
            // at startup they are its history; if it appeared after startup they arrived live,
            // and one that calls on Trey dismisses the attract screen (no timestamps: post's are
            // whole seconds and clocks skew).
            const live = startup !== undefined && !startup.has(e.channel);
            if (live && attract !== undefined && e.records.some(calls)) dismissAttract(s);
            baseline(s, e.channel, e.records);
            if (!known.has(e.channel))
              known.set(e.channel, new Set(e.records.map((r) => r.raw.id)));
            return;
          }
          const ids = known.get(e.channel) ?? new Set<string>();
          const fresh = e.records.filter((r) => !ids.has(r.raw.id));
          for (const r of fresh) ids.add(r.raw.id);
          if (attract !== undefined && fresh.some(calls)) dismissAttract(s);
          if (!shown(s, e.channel)) return;
          for (const r of fresh) if (r.kind === 'emote') enqueue(s, e.channel, r);
          return;
        }
        case 'seen': {
          let entry = readBy.get(e.channel);
          if (entry !== undefined && entry.id !== e.id) return;
          if (entry === undefined) {
            entry = { id: e.id, seen: new Set() };
            readBy.set(e.channel, entry);
          }
          if (entry.seen.has(e.participant) || e.participant === s.owner.participant) return;
          entry.seen.add(e.participant);
          hop(s, e.channel, e.participant);
          s.actions.requestFrame();
          return;
        }
        case 'sent': {
          readBy.set(e.channel, { id: e.id, seen: new Set() });
          for (const [k, t] of hops)
            if (k.startsWith(`${e.channel}\u0000`)) {
              t.burst.cancel();
              hops.delete(k);
            }
          lastHop.delete(e.channel);
          if (e.mode === 'signed' && s.motion !== 'off' && shown(s, e.channel)) {
            power.get(e.channel)?.burst.cancel();
            power.set(e.channel, schedule(s, POWER_UP_MS, s.now));
          }
          s.actions.requestFrame();
          return;
        }
        case 'input':
          lastInput = timers.now();
          if (launched && idleTimer === undefined && attract === undefined) armIdle(idleMs);
          return;
        case 'focus':
          return;
      }
    },

    key(_k: Key, s: AppState): KeyResult {
      lastState = s;
      lastInput = timers.now();
      if (attract !== undefined) {
        dismissAttract(s);
        return 'handled';
      }
      if (skip(s.now)) s.actions.requestFrame();
      return 'pass';
    },

    dispose(): void {
      if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
      idleTimer = undefined;
      skip(Number.NEGATIVE_INFINITY);
      attract?.burst?.cancel();
      attract = undefined;
    },
  };
  return stage;
}
