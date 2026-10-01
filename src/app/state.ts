/**
 * What the app shows, as the registries hand it to overlays, commands, message renderers and the
 * stage (build plan I6 names `AppState`; this file defines it). One immutable snapshot is built per
 * change; a frame and every handler read only that snapshot. Nothing here mutates: a plug-in that
 * wants something to happen asks through `actions` (the screen) or `post` (post and the stores).
 *
 * Every sending path goes through the send transaction (I4): commands get it as
 * `CommandContext.send`. `post.client` is here for reads and the non-word verbs I4 gives the client
 * (archive, unarchive, emote, seen-by, exact retrieval); its own `send` is the same transaction.
 */
import type { AvatarPack } from '@estate/pixel';
import type {
  ChannelSummary,
  Crossed,
  DisplayRecord,
  OwnerPost,
  PorchConfig,
  PrivateAgent,
  SendRecord,
} from '@estate/post-kit';
import type { Burst } from '../host/animation-clock.ts';
import type { Mention } from './mentions.ts';

/** Phone under 60 columns, laptop 60–139, wide 140 and over (plan T6, "Layouts"). */
export type LayoutKind = 'phone' | 'laptop' | 'wide';

/** `PORCH_MOTION`: full, reduced (end states only) or off (no motion at all). Ruling 4. */
export type MotionMode = 'full' | 'reduced' | 'off';

/** How a lane's activity is moving: attention-eligible messages, last 10 minutes vs the 10 before. */
export type Trend = 'up' | 'flat' | 'down';

/** One channel as the app knows it. */
export type ChannelState = {
  readonly name: string;
  /** Post's listing for it (unread count, members, archived); undefined until listed. */
  readonly summary: ChannelSummary | undefined;
  /** The loaded window, oldest first, each with its current verdict. */
  readonly records: readonly DisplayRecord[];
  /**
   * Trey's own sends in this channel that are not in `records` yet: drawn after the newest record,
   * dimmed, with `sending…`. Absent when there are none. Never an input to anything but the
   * stream: no unread count, acknowledgment, pick, stage event or feature reads it.
   */
  readonly pending?: readonly DisplayRecord[];
  /** The newest id Trey acknowledged this session, if any. */
  readonly acknowledged: string | undefined;
  /** The first unread attention-eligible record, where the divider is drawn. */
  readonly divider: string | undefined;
  /** "↓ N new": unread attention-eligible records, post's count plus late arrivals. */
  readonly newCount: number;
  /** Post reports it unread and an unread eligible message calls on Trey (or a decision waits). */
  readonly needsYou: boolean;
  readonly trend: Trend;
  /**
   * What lies above the window: `older` records Ctrl+O can load, the channel's `beginning`, or
   * older records the window is too `full` to hold (search reaches them).
   */
  readonly top: 'older' | 'beginning' | 'full';
  /**
   * The pane shows a window held around a search hit older than the live window, in place of the
   * newest (Ctrl+G returns).
   */
  readonly detached: boolean;
  /** Why the last read failed, when it did. */
  readonly error: string | undefined;
};

/** One stream pane. Wide shows two side by side; phone and laptop show one. */
export type PaneState = {
  readonly channel: string | undefined;
  /** Rows scrolled up from the newest line; 0 follows the bottom. */
  readonly scroll: number;
  /** The picked record's id (pick mode), if any. */
  readonly pick: string | undefined;
};

/** The composer for the current channel. */
export type ComposerState = {
  readonly text: string;
  /** The caret, as a UTF-16 index into `text` that always sits on a grapheme boundary. */
  readonly caret: number;
  /** Bumped on every edit; a send freezes it so a late outcome never clears newer typing. */
  readonly revision: number;
  /** The record id the next send replies to. */
  readonly replyTo: string | undefined;
  /** The stretches of `text` that are a participant (`@Fern`), each with the id post resolves. */
  readonly mentions?: readonly Mention[];
};

/** The status line's message. Tone is always carried by the words too (NO_COLOR). */
export type Notice = {
  readonly text: string;
  readonly tone: 'info' | 'good' | 'caution' | 'warning';
  /** Stays until dismissed (Esc), instead of until the next notice. */
  readonly sticky: boolean;
};

/** Messages that crossed Trey's send while he typed, from that send's receipt (never a refusal). */
export type CrossedStrip = {
  readonly channel: string;
  readonly sentId: string;
  readonly crossed: Crossed;
};

/** The screen-level things a plug-in may ask for. Each takes effect in the next snapshot. */
export type AppActions = {
  /** Show `channel` in the focused pane (and make it current). */
  openChannel(channel: string): void;
  /** Open `channel` and pick record `id` in it, scrolled into view (a search hit). */
  jumpTo(channel: string, id: string): void;
  openOverlay(id: string): void;
  closeOverlay(): void;
  /** Replace the composer's text; the caret goes to the end. */
  setDraft(text: string): void;
  /** Insert at the caret (a pasted path, a mention). */
  insert(text: string): void;
  replyTo(id: string | undefined): void;
  pick(id: string | undefined): void;
  status(text: string, tone?: Notice['tone'], sticky?: boolean): void;
  /** A finite burst on the animation clock (ruling 4); the only way anything moves. */
  animate(ms: number): Burst;
  requestFrame(): void;
  quit(): void;
  /**
   * Add `path` to the end of `channel`'s draft (an attached image), keeping the words already there
   * and whatever channel has focus by then.
   */
  appendImagePath(channel: string, path: string): void;
};

/** Post and the porch-tui-compatible stores, for plug-ins that need them. */
export type AppServices = {
  readonly client: OwnerPost;
  /** Send recovery records, on the app's one shared `DraftSpace`. `restore()` never sends. */
  readonly recovery: SendRecord;
  /** Porch's config: owner identity, paths for decision records and polls. */
  readonly config: PorchConfig;
  /** The private signing agent when armed at launch. */
  readonly agent: PrivateAgent | undefined;
};

export type OwnerView = {
  readonly room: string;
  readonly participant: string;
  readonly label: string;
  readonly marker: string;
};

export type AppState = {
  readonly owner: OwnerView;
  /** Post's channel listing (one `post channels` per poll cycle), archived ones included. */
  readonly channels: readonly ChannelSummary[];
  /** Every channel the app has loaded, by name. */
  readonly views: ReadonlyMap<string, ChannelState>;
  /** The focused pane's channel. */
  readonly current: string | undefined;
  readonly panes: readonly PaneState[];
  readonly focusedPane: number;
  /** Wide's two-pane split is on (F2 or Ctrl+\ toggles it). */
  readonly split: boolean;
  readonly layout: LayoutKind;
  readonly cols: number;
  readonly rows: number;
  readonly composer: ComposerState;
  /** The mode of the next send. Casual by default, even when armed. */
  readonly mode: 'casual' | 'signed';
  /** A private agent holds the key (separate from whether this send is signed). */
  readonly armed: boolean;
  /** Why signing is refused (owner anchor disagreement), when it is. */
  readonly signingBlocked: string | undefined;
  /** A send is in flight. */
  readonly sending: boolean;
  readonly crossed: CrossedStrip | undefined;
  readonly overlay: string | undefined;
  readonly notice: Notice | undefined;
  /** Valid avatar packs by participant id; a missing one gets `defaultAvatar(id)`. */
  readonly avatars: ReadonlyMap<string, AvatarPack>;
  /** Display names by participant id, from post profiles. */
  readonly names: ReadonlyMap<string, string>;
  /**
   * For a channel: the gray text to draw after the name of each participant that shares its name
   * with another one there (their directory, then the tail of their id). A unique name has none.
   * Text another agent reported: draw it in gray and nothing else.
   */
  readonly hints: (channel: string | undefined) => ReadonlyMap<string, string>;
  readonly motion: MotionMode;
  /**
   * The terminal asked for no colour (`NO_COLOR`): the host draws in its monochrome pair, so art is
   * drawn as line work and lit regions (the current lane) are marked without a solid fill.
   * Undefined reads as colour.
   */
  readonly noColor?: boolean;
  /** The terminal reports focus. */
  readonly focused: boolean;
  /** The animation clock's time for this frame, in milliseconds. */
  readonly now: number;
  /** Ids of Trey's own confirmed sends this session (image trust, receipts). */
  readonly ownMessageIds: ReadonlySet<string>;
  readonly actions: AppActions;
  /** Undefined only in headless frame tests that run without post. */
  readonly post: AppServices | undefined;
};
