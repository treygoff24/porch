import type { OwnerPost } from './client.ts';
import { mergeRecords } from './derive.ts';
import { type Limit, limit } from './limit.ts';
import { displayText, newestEligible, type RawRecord, type Verdict } from './records.ts';
import type { Result } from './run.ts';
import type { SendOutcome } from './send.ts';
import { type VerdictChange, VerificationScheduler } from './verification-scheduler.ts';
import type { ChannelSummary } from './wire.ts';

export type ChannelView = {
  records: readonly RawRecord[];
  verdicts: Readonly<Record<string, Verdict>>;
  acknowledged?: string;
  error?: string;
};
export type PostState = {
  channels: readonly ChannelSummary[];
  views: Readonly<Record<string, ChannelView>>;
};
type Track = {
  id: string;
  start: number;
  seen: Set<string>;
  busy: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
type Client = Pick<
  OwnerPost,
  'owner' | 'history' | 'since' | 'channels' | 'markRead' | 'seenBy' | 'send' | 'message'
>;
/** At most this many exact re-reads of incomplete bodies run at once, across every channel. */
export const REFETCH_CONCURRENCY = 2;
/** A background channel is read every this many cycles, or sooner when its message count moves. */
export const BACKGROUND_EVERY = 5;

/**
 * Post state for the app. One poll cycle every `pollMs` makes one `post channels` call, shared by
 * every open view and by the seen-by poll, then reads each open channel that needs it: a foreground
 * channel every cycle, a background one (a score-bar lane nobody is looking at) when post's message
 * count for it moved, or every {@link BACKGROUND_EVERY} cycles. Reads never acknowledge.
 */
export class PostStore {
  private state: PostState = { channels: [], views: {} };
  private listeners = new Set<() => void>();
  private seenListeners = new Set<(channel: string, id: string, participant: string) => void>();
  private openChannels = new Map<
    string,
    {
      polls: number;
      reconcilePending: boolean;
      /** A read was asked for after the running one began (`refreshChannel`): read again. */
      rerunPending: boolean;
      /** Callers of `refreshChannel` waiting for the read that starts after theirs. */
      waiters: (() => void)[];
      busy: boolean;
      background: boolean;
    }
  >();
  private tracks = new Map<string, Track>();
  private disposed = false;
  private cycleTimer: ReturnType<typeof setTimeout> | undefined;
  private cycles = 0;
  private readonly refetch: Limit;
  private readonly verifier: VerificationScheduler;
  constructor(
    private readonly opts: {
      client: Client;
      markReadOnView: false;
      pollMs?: number;
      now?: () => number;
      /** For tests: the verifier (default: post-kit's `verify`). */
      verify?: ConstructorParameters<typeof VerificationScheduler>[2];
      verifyConcurrency?: number;
      refetchConcurrency?: number;
    },
  ) {
    if (opts.markReadOnView !== false) throw new Error('Porch requires explicit acknowledgment');
    this.refetch = limit(opts.refetchConcurrency ?? REFETCH_CONCURRENCY);
    this.verifier = new VerificationScheduler(
      opts.client.owner,
      (raw, verdict) => this.applyVerdicts([{ raw, verdict }]),
      opts.verify,
      {
        batch: (changes) => this.applyVerdicts(changes),
        ...(opts.verifyConcurrency === undefined ? {} : { concurrency: opts.verifyConcurrency }),
      },
    );
  }
  /** Verdicts for open channels, applied together: one state change and one notification. */
  private applyVerdicts(changes: readonly VerdictChange[]): void {
    if (this.disposed) return;
    const views = { ...this.state.views };
    let touched = false;
    for (const { raw, verdict } of changes) {
      const view = views[raw.storageChannel];
      if (view === undefined || !this.openChannels.has(raw.storageChannel)) continue;
      views[raw.storageChannel] = { ...view, verdicts: { ...view.verdicts, [raw.id]: verdict } };
      touched = true;
    }
    if (!touched) return;
    this.state = { ...this.state, views };
    this.emit();
  }
  getState = (): PostState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  onSeen(listener: (channel: string, id: string, participant: string) => void): () => void {
    this.seenListeners.add(listener);
    return () => this.seenListeners.delete(listener);
  }
  private emit(): void {
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  private setView(channel: string, view: ChannelView): void {
    if (this.disposed) return;
    this.state = { ...this.state, views: { ...this.state.views, [channel]: view } };
    this.emit();
  }
  async refreshChannels(): Promise<void> {
    const r = await this.opts.client.channels();
    if (!this.disposed && r.ok && JSON.stringify(r.value) !== JSON.stringify(this.state.channels)) {
      this.state = { ...this.state, channels: r.value };
      this.emit();
    }
  }
  /** Arm the next poll cycle, unless one is armed or nothing is open. */
  private schedule(): void {
    if (this.cycleTimer !== undefined || this.disposed || this.openChannels.size === 0) return;
    this.cycleTimer = setTimeout(() => {
      void this.cycle().finally(() => {
        this.cycleTimer = undefined;
        this.schedule();
      });
    }, this.opts.pollMs ?? 2000);
    this.cycleTimer.unref?.();
  }
  /** One cycle: one `post channels`, then the channel reads that are due. */
  async cycle(): Promise<void> {
    if (this.disposed) return;
    this.cycles += 1;
    const counts = (list: readonly ChannelSummary[]) =>
      new Map(list.map((c) => [c.name, c.messages]));
    const before = counts(this.state.channels);
    try {
      await this.refreshChannels();
    } catch {
      // A failed listing still lets the open channels be read.
    }
    const after = counts(this.state.channels);
    await Promise.all(
      [...this.openChannels].map(([channel, entry]) =>
        !entry.background ||
        this.cycles % BACKGROUND_EVERY === 0 ||
        before.get(channel) !== after.get(channel)
          ? this.poll(channel)
          : undefined,
      ),
    );
  }
  /**
   * Start reading `channel`. A background channel (a lane off screen) is read less often; opening
   * it again in the foreground, or `setBackground(channel, false)`, brings it back to every cycle.
   */
  async open(channel: string, opts: { background?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    this.close(channel);
    this.openChannels.set(channel, {
      polls: 0,
      reconcilePending: false,
      rerunPending: false,
      waiters: [],
      busy: false,
      background: opts.background ?? false,
    });
    this.setView(channel, this.state.views[channel] ?? { records: [], verdicts: {} });
    await Promise.all([this.refreshChannels(), this.poll(channel, true)]);
    this.schedule();
  }
  setBackground(channel: string, background: boolean): void {
    const entry = this.openChannels.get(channel);
    if (entry !== undefined) entry.background = background;
  }
  isOpen(channel: string): boolean {
    return this.openChannels.has(channel);
  }
  viewChannel(channel: string): Promise<void> {
    return this.open(channel);
  }
  watchTabs(channels: readonly string[]): void {
    for (const channel of this.openChannels.keys())
      if (!channels.includes(channel)) this.close(channel);
    for (const channel of channels) if (!this.openChannels.has(channel)) void this.open(channel);
  }
  close(channel: string): void {
    this.openChannels.delete(channel);
    this.stopTrack(channel);
    this.updateVerification();
    if (this.openChannels.size === 0) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = undefined;
    }
  }
  private updateVerification(): void {
    this.verifier.window(
      [...this.openChannels.keys()].flatMap((channel) => this.state.views[channel]?.records ?? []),
    );
  }
  /**
   * Read `channel` now, for a record the caller knows exists (the receipt of Trey's own send): a
   * read that began after this call, not the next poll tick. A read already in flight may have
   * started before the record landed, so it is followed by another, and this resolves when that
   * one has been applied. Resolves at once for a channel that is not open.
   */
  refreshChannel(channel: string): Promise<void> {
    return this.poll(channel, false, true);
  }
  async poll(channel: string, reconcile = false, fresh = false): Promise<void> {
    const entry = this.openChannels.get(channel);
    if (entry === undefined || this.disposed) return;
    if (entry.busy) {
      entry.reconcilePending ||= reconcile;
      if (!fresh) return;
      entry.rerunPending = true;
      return new Promise<void>((resolve) => entry.waiters.push(resolve));
    }
    entry.busy = true;
    try {
      const current = this.state.views[channel]?.records ?? [];
      const newest = current.at(-1)?.id;
      const calls: Promise<Result<RawRecord[]>>[] = [];
      if (newest !== undefined) calls.push(this.opts.client.since(channel, newest));
      if (newest === undefined || reconcile || ++entry.polls % 5 === 0)
        calls.push(this.opts.client.history(channel, 200));
      const replies = await Promise.all(calls);
      if (this.openChannels.get(channel) !== entry || this.disposed) return;
      const view = this.state.views[channel] ?? { records: [], verdicts: {} };
      // A channel Trey has not joined cannot be read as him (post: `not_a_member`). That is a state
      // the app shows as "not joined", not a failure of the read.
      const bad = replies.find((r) => !r.ok && r.error.code !== 'not_a_member');
      let records = mergeRecords(
        view.records,
        replies.flatMap((r) => (r.ok ? r.value : [])),
      );
      // Exact retrieval is independent of render/verification. An incomplete slice stays unknown.
      // Re-reads share one store-wide limit, so a window of large messages cannot fan out.
      records = await Promise.all(
        records.map(async (raw) => {
          if (raw.bodyComplete) return raw;
          try {
            const complete = await this.refetch(() => this.opts.client.message(channel, raw.id));
            return complete.ok ? complete.value : raw;
          } catch {
            return raw;
          }
        }),
      );
      if (this.openChannels.get(channel) !== entry || this.disposed) return;
      const changed =
        records.length !== view.records.length || records.some((r, i) => r !== view.records[i]);
      const { error: before, ...rest } = view;
      const failed = bad !== undefined && !bad.ok ? bad.error.message : undefined;
      // A read that works clears the error an earlier one left (joining a channel ends its
      // `not_a_member`), instead of showing it until the process restarts.
      if (changed || before !== failed) {
        this.setView(channel, {
          ...rest,
          records,
          ...(failed === undefined ? {} : { error: failed }),
        });
        this.updateVerification();
      }
    } catch (err) {
      if (this.openChannels.get(channel) === entry && !this.disposed) {
        const view = this.state.views[channel] ?? { records: [], verdicts: {} };
        this.setView(channel, {
          ...view,
          error: displayText(err instanceof Error ? err.message : 'Post read failed'),
        });
      }
    } finally {
      entry.busy = false;
      const waiters = entry.waiters.splice(0);
      const again = entry.reconcilePending || entry.rerunPending;
      const reconcileAgain = entry.reconcilePending;
      entry.rerunPending = false;
      entry.reconcilePending = false;
      try {
        if (again && this.openChannels.get(channel) === entry && !this.disposed)
          await this.poll(channel, reconcileAgain);
      } finally {
        for (const resolve of waiters) resolve();
      }
    }
  }
  async regainFocus(): Promise<void> {
    await Promise.all([
      this.refreshChannels().catch(() => undefined),
      ...[...this.openChannels.keys()].map((channel) => this.poll(channel, true)),
    ]);
  }
  /** The visible list is supplied by the UI. Emote-only views never move a cursor. */
  async acknowledge(
    channel: string,
    visible: readonly RawRecord[],
  ): Promise<Result<{ advanced: boolean }>> {
    const target = newestEligible(visible, {
      room: this.opts.client.owner.ownerRoom,
      participant: this.opts.client.owner.participant,
    });
    if (target === undefined)
      return {
        ok: false,
        error: { code: 'nothing_to_mark', message: 'nothing here to mark read', retryable: false },
      };
    const r = await this.opts.client.markRead(channel, target.id);
    const view = this.state.views[channel];
    if (r.ok && view !== undefined) this.setView(channel, { ...view, acknowledged: target.id });
    return r;
  }
  async send(
    channel: string,
    text: string,
    opts: Parameters<OwnerPost['send']>[2] = {},
  ): Promise<SendOutcome> {
    const result = await this.opts.client.send(channel, text, opts);
    if (result.kind === 'confirmed') this.trackConfirmed(channel, result.id);
    return result;
  }
  trackConfirmed(channel: string, id: string): void {
    this.stopTrack(channel);
    if (!this.openChannels.has(channel) || this.disposed) return;
    const track: Track = { id, start: this.now(), seen: new Set(), busy: false };
    this.tracks.set(channel, track);
    // First observation at 2s, then one request at a time.
    this.scheduleSeen(channel, track);
  }
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
  private scheduleSeen(channel: string, track: Track): void {
    track.timer = setTimeout(() => void this.pollSeen(channel, track), 2000);
    track.timer.unref?.();
  }
  private async pollSeen(channel: string, track: Track): Promise<void> {
    if (this.tracks.get(channel) !== track || track.busy || this.disposed) return;
    if (this.now() - track.start >= 600000) {
      this.stopTrack(channel);
      return;
    }
    track.busy = true;
    try {
      // Members come from the poll cycle's listing; the seen-by poll makes no listing of its own.
      const r = await this.opts.client.seenBy(channel, track.id);
      if (this.tracks.get(channel) !== track || this.disposed) return;
      if (this.now() - track.start >= 600000) {
        this.stopTrack(channel);
        return;
      }
      if (r.ok)
        for (const participant of r.value)
          if (!track.seen.has(participant)) {
            track.seen.add(participant);
            if (participant !== this.opts.client.owner.participant)
              for (const listener of this.seenListeners) listener(channel, track.id, participant);
          }
      const members = this.state.channels.find((c) => c.name === channel)?.participants;
      if (members?.every((id) => id === this.opts.client.owner.participant || track.seen.has(id))) {
        this.stopTrack(channel);
        return;
      }
    } catch {
      // A failed observation is retried on the next bounded tick, never an unhandled rejection.
    } finally {
      track.busy = false;
      if (this.tracks.get(channel) === track && !this.disposed) this.scheduleSeen(channel, track);
    }
  }
  private stopTrack(channel: string): void {
    clearTimeout(this.tracks.get(channel)?.timer);
    this.tracks.delete(channel);
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.cycleTimer);
    this.cycleTimer = undefined;
    for (const channel of this.openChannels.keys()) this.close(channel);
    this.verifier.dispose();
    this.listeners.clear();
    this.seenListeners.clear();
  }
}
