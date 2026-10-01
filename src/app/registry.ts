/**
 * The app's registries (build plan I6). Overlays, slash commands and message renderers register
 * here when their module is imported, so the stage and overlay lane (T7) and the features lane
 * (T8) plug in without editing the app core. `src/app/plugins.ts` is where their modules are
 * imported.
 *
 * The I6 declarations are verbatim. Three additions sit below them, each additive (nothing in I6
 * changes meaning):
 * - readers, so the app can find what was registered;
 * - `registerStage`, the one stage strip (T7) that the layout reserves room for in each pane;
 * - `registerKeyBinding`, for app chords and pick-mode keys a feature owns (Ctrl+R, Ctrl+V).
 *
 * Dispatch rules:
 * - A slash command is found by the exact first token, name or alias; an unknown `/word` is
 *   refused and never sent (inventory §6). Names and aliases are unique; a repeat throws.
 * - Overlay ids are unique; a repeat throws.
 * - A record is drawn by the most recently registered renderer of its kind whose `match` is
 *   absent or true. The core registers one plain renderer per kind first, so a feature's renderer
 *   with a `match` (an image, a poll) takes the records it claims and leaves the rest.
 * - Pick-mode `c`, `s` and `1`–`9` run the commands named `copy`, `seen` and `vote` (with the digit
 *   as args) when they are registered; a command reads the pick from `state.panes`.
 */
import type { DisplayRecord, SendOutcome, SendRequest } from '@estate/post-kit';
import type { Grid, Rect } from '../grid/grid.ts';
import type { AppState } from './state.ts';

export type { AppState } from './state.ts';

// ── I6, as declared ────────────────────────────────────────────────────────────────────────────

export type Key = { name: string; ctrl: boolean; alt: boolean; shift: boolean; text?: string };
export type KeyResult = 'handled' | 'pass';
export type Overlay = {
  id: string;
  draw(g: Grid, area: Rect, s: AppState): void;
  key(k: Key, s: AppState): KeyResult;
  /**
   * Called when the core closes this overlay or replaces it with another, so work it started
   * (reads, searches) stops and nothing of it draws later. Must be safe to call more than once.
   */
  reset?(): void;
};
export type CommandContext = {
  state: AppState;
  send(req: SendRequest): Promise<SendOutcome>;
  status(text: string): void;
  openOverlay(id: string): void;
};
export type SlashCommand = {
  name: string;
  aliases?: readonly string[];
  usage: string;
  needsChannel: boolean;
  run(args: string, ctx: CommandContext): Promise<void>;
};
export type MessageRenderer = {
  kind: 'message' | 'emote' | 'event';
  match?(r: DisplayRecord): boolean;
  measure(r: DisplayRecord, width: number): number;
  draw(g: Grid, area: Rect, r: DisplayRecord, s: AppState): void;
};

const overlays = new Map<string, Overlay>();
const commands = new Map<string, SlashCommand>();
const renderers: MessageRenderer[] = [];

export function registerOverlay(o: Overlay): void {
  if (overlays.has(o.id)) throw new Error(`overlay ${o.id} is already registered`);
  overlays.set(o.id, o);
}

export function registerCommand(c: SlashCommand): void {
  const names = [c.name, ...(c.aliases ?? [])];
  for (const name of names) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid command name: ${name}`);
    if (commands.has(name)) throw new Error(`command /${name} is already registered`);
  }
  for (const name of names) commands.set(name, c);
}

export function registerMessageRenderer(r: MessageRenderer): void {
  renderers.push(r);
}

// ── Additions: the stage and key bindings ──────────────────────────────────────────────────────

/** What a pane's stage strip shows: full bodies, or one row of heads when height is short. */
export type StageFit = 'bodies' | 'heads';
export type StagePane = { channel: string | undefined; fit: StageFit; focused: boolean };

/**
 * What the stage hears about. `arrival` carries records new since the last poll (an emote plays
 * once on arrival); `seen` is each participant newly observed in post's seen set for Trey's latest
 * send (the READY hop); `sent` is a confirmed Trey send (the power-up when signed); `input` is any
 * key, global keys included, or paste (the blink window and the attract screen's idle timer);
 * `pick` is a pane's picked message changing (`id` undefined when the pick clears).
 */
export type StageEvent =
  | { kind: 'arrival'; channel: string; records: readonly DisplayRecord[] }
  | { kind: 'seen'; channel: string; id: string; participant: string }
  | { kind: 'sent'; channel: string; id: string; mode: 'casual' | 'signed' }
  | { kind: 'input' }
  | { kind: 'focus'; focused: boolean }
  | { kind: 'pick'; channel: string | undefined; id: string | undefined };

export type Stage = {
  /** Draw one pane's strip into `area` (its height follows `pane.fit`). */
  draw(g: Grid, area: Rect, pane: StagePane, s: AppState): void;
  /** Rows the strip takes for a fit: the core uses this to lay out each pane. */
  height(fit: StageFit): number;
  event?(e: StageEvent, s: AppState): void;
  /**
   * Keybinding layers 2 and 3: the attract screen consumes any key; a flourish in progress skips to
   * its end state and returns 'pass' so the key continues down the table.
   */
  key?(k: Key, s: AppState): KeyResult;
  /** Drawn last, over the whole screen (the attract screen), when it has something to show. */
  drawOver?(g: Grid, area: Rect, s: AppState): void;
  /**
   * A click on a hit region the stage registered, any id starting `stage:` (`stage:attract`).
   * Without this method the click reaches `key` as a key named `click`, which a stage treats as
   * any other key (the attract screen dismisses).
   */
  hit?(action: { id: string; data?: unknown }, s: AppState): void;
};

let stage: Stage | undefined;

/** The stage strip. One per app; until one registers, the core draws resting sprites. */
export function registerStage(s: Stage): void {
  if (stage !== undefined) throw new Error('a stage is already registered');
  stage = s;
}

/**
 * A key a feature owns. `chord` bindings are offered at layer 6 (app chords) before the core's
 * own chords; `pick` bindings at layer 7 while a message is picked.
 */
export type KeyBinding = {
  id: string;
  layer: 'chord' | 'pick';
  key(k: Key, s: AppState): KeyResult;
};

const bindings = new Map<string, KeyBinding>();

export function registerKeyBinding(b: KeyBinding): void {
  if (bindings.has(b.id)) throw new Error(`key binding ${b.id} is already registered`);
  bindings.set(b.id, b);
}

/**
 * Called after post's state moves (a poll found something). Errors and rejections are shown in the
 * status line; a call still running is not started again until it finishes.
 */
export type PollObserver = {
  id: string;
  observe(s: AppState): void | Promise<void>;
};

const pollObservers = new Map<string, PollObserver>();

export function registerPollObserver(o: PollObserver): void {
  if (pollObservers.has(o.id)) throw new Error(`poll observer ${o.id} is already registered`);
  pollObservers.set(o.id, o);
}

/**
 * Offered a bracketed paste outside an overlay, in registration order, before the composer takes it.
 * Resolving `true` means the handler took the paste; `false` passes it on.
 */
export type PasteHandler = {
  id: string;
  paste(text: string, s: AppState): Promise<boolean>;
};

const pasteHandlers = new Map<string, PasteHandler>();

export function registerPasteHandler(h: PasteHandler): void {
  if (pasteHandlers.has(h.id)) throw new Error(`paste handler ${h.id} is already registered`);
  pasteHandlers.set(h.id, h);
}

/**
 * A request for post's emote path (`post chat --emote`): no signature, no recovery record, no reply
 * target, never wakes agents. The body is what the command typed (`/emote wave @nova`).
 */
export type EmoteSendRequest = SendRequest & { emote: { name: string; at?: string } };

export function isEmoteRequest(req: SendRequest): req is EmoteSendRequest {
  const e = (req as Partial<EmoteSendRequest>).emote;
  return typeof e === 'object' && e !== null && typeof e.name === 'string';
}

// ── Readers, for the app ───────────────────────────────────────────────────────────────────────

export function overlay(id: string): Overlay | undefined {
  return overlays.get(id);
}

export function overlayIds(): string[] {
  return [...overlays.keys()];
}

/** The command a first token names (`vote`, not `/vote`), by name or alias. */
export function command(token: string): SlashCommand | undefined {
  return commands.get(token);
}

/** Every command once, in registration order (the help overlay lists them). */
export function allCommands(): SlashCommand[] {
  return [...new Set(commands.values())];
}

export function rendererFor(r: DisplayRecord): MessageRenderer | undefined {
  for (let i = renderers.length - 1; i >= 0; i--) {
    const candidate = renderers[i];
    if (candidate === undefined || candidate.kind !== r.kind) continue;
    if (candidate.match === undefined || candidate.match(r)) return candidate;
  }
  return undefined;
}

export function currentStage(): Stage | undefined {
  return stage;
}

export function keyBindings(layer: KeyBinding['layer']): KeyBinding[] {
  return [...bindings.values()].filter((b) => b.layer === layer);
}

export function allPollObservers(): PollObserver[] {
  return [...pollObservers.values()];
}

export function allPasteHandlers(): PasteHandler[] {
  return [...pasteHandlers.values()];
}
