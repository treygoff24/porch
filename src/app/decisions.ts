/**
 * Which channels hold a decision record waiting on Trey (a lane "needs you" for one; plan T6,
 * "The score bar").
 *
 * The decision log (`decision-records.jsonl` in the owner room) is replayed and projected with
 * post-kit's own rules: a proposal waits until a signed owner action decides it, and an action
 * counts only when its message verifies as Trey's. The answer is cached; a call checks the log's
 * size and mtime and, when either moved, projects again in the background and asks for a frame
 * when done. Nothing polls on a timer.
 */
import { statSync } from 'node:fs';
import {
  type ActionVerdict,
  DecisionAuthority,
  type DrEvent,
  type OwnerAnchor,
  project,
  type RawRecord,
  type Result,
  replay,
  type Verdict,
  verify,
} from '@estate/post-kit';

export type DecisionDeps = {
  /** The log's path (`drLogPath(cfg)`). */
  path: string;
  anchor: OwnerAnchor;
  /** Exact retrieval of one message (`OwnerPost.message`). */
  message(channel: string, id: string): Promise<Result<RawRecord>>;
  verify?: (raw: RawRecord, anchor: OwnerAnchor) => Promise<Verdict>;
  /** Called when a new answer is ready. */
  changed(): void;
};

export class DecisionWatch {
  private waiting: ReadonlySet<string> = new Set();
  private seen = '';
  private running = false;
  private again = false;
  private events: readonly DrEvent[] = [];
  private readonly authority: DecisionAuthority;

  constructor(private readonly deps: DecisionDeps) {
    this.authority = new DecisionAuthority({
      lookup: (mid) => this.lookup(mid),
      ownerRoom: deps.anchor.ownerRoom,
      marker: deps.anchor.marker,
    });
  }

  /** Channels with a decision awaiting Trey, as last projected; starts a refresh when stale. */
  channels(): ReadonlySet<string> {
    const stamp = stampOf(this.deps.path);
    if (stamp !== this.seen) {
      this.seen = stamp;
      void this.refresh();
    }
    return this.waiting;
  }

  /** Project the log now (also used at boot, so the first frame can know). */
  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        this.events = replay(this.deps.path);
        const records = await project(this.events, this.authority);
        const next = new Set<string>();
        for (const r of records.values())
          if (r.state === 'needs_operator_decision' && typeof r.channel === 'string')
            next.add(r.channel);
        if (!sameSet(next, this.waiting)) {
          this.waiting = next;
          this.deps.changed();
        }
      } while (this.again);
    } catch {
      // An unreadable log changes nothing on screen; the next change to the file tries again.
    } finally {
      this.running = false;
    }
  }

  /** An actor message, fetched from the channel its event names and verified as Trey's. */
  private async lookup(mid: string): Promise<ActionVerdict> {
    const channel = this.channelOf(mid);
    if (channel === undefined) return { kind: 'unknown' };
    const r = await this.deps.message(channel, mid);
    if (!r.ok) return { kind: 'unknown' };
    const raw = r.value;
    const verdict = await (this.deps.verify ?? verify)(raw, this.deps.anchor);
    if (verdict.state === 'unknown') return { kind: 'unknown' };
    if (verdict.state !== 'verified') return { kind: 'failed' };
    return {
      kind: 'verified',
      body: new TextEncoder().encode(raw.body),
      signatureRefPresent: raw.signature.present,
      from: raw.from,
    };
  }

  private channelOf(mid: string): string | undefined {
    const byDr = new Map<string, string>();
    for (const ev of this.events) {
      const dr = ev.get('dr');
      const channel = ev.get('channel');
      if (typeof dr === 'string' && typeof channel === 'string') byDr.set(dr, channel);
    }
    for (const ev of this.events) {
      if (ev.get('actor_message_id') !== mid) continue;
      const channel = ev.get('channel');
      if (typeof channel === 'string') return channel;
      const dr = ev.get('dr');
      if (typeof dr === 'string' && byDr.has(dr)) return byDr.get(dr);
    }
    return undefined;
  }
}

function stampOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return 'absent';
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
