import { type Limit, limit } from './limit.ts';
import type { OwnerAnchor } from './owner.ts';
import type { RawRecord, Verdict } from './records.ts';
import { verify } from './verify.ts';

const DELAYS = [2000, 4000, 8000, 16000, 32000, 60000];
/** At most this many verifications (each may spawn `ssh-keygen`) run at once. */
export const VERIFY_CONCURRENCY = 4;
type Entry = {
  raw: RawRecord;
  verdict: Verdict | undefined;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
  active: boolean;
};
export type VerdictChange = { raw: RawRecord; verdict: Verdict };
/**
 * Unknown retries run independently of painting and never become a cached failure.
 *
 * The first verdicts of the records one `window()` call adds are delivered together, once every one
 * of them is known, through `batch` when given (a channel opening with 200 records is one update,
 * not 200). Later changes, from retries, arrive one at a time through `changed`.
 */
export class VerificationScheduler {
  private entries = new Map<string, Entry>();
  private readonly gate: Limit;
  constructor(
    private readonly anchor: OwnerAnchor,
    private readonly changed: (raw: RawRecord, verdict: Verdict) => void,
    private readonly check = verify,
    private readonly opts: {
      batch?: (changes: readonly VerdictChange[]) => void;
      concurrency?: number;
    } = {},
  ) {
    this.gate = limit(opts.concurrency ?? VERIFY_CONCURRENCY);
  }
  private key(raw: RawRecord): string {
    return `${raw.storageChannel}/${raw.id}`;
  }
  window(records: readonly RawRecord[]): void {
    const keep = new Set(records.map((r) => this.key(r)));
    for (const [key, entry] of this.entries)
      if (!keep.has(key)) {
        entry.active = false;
        clearTimeout(entry.timer);
        this.entries.delete(key);
      }
    const fresh: Entry[] = [];
    for (const raw of records) {
      const key = this.key(raw);
      const old = this.entries.get(key);
      if (old?.raw === raw) continue;
      if (old !== undefined) {
        old.active = false;
        clearTimeout(old.timer);
      }
      const entry: Entry = { raw, verdict: undefined, retries: 0, active: true };
      this.entries.set(key, entry);
      fresh.push(entry);
    }
    if (fresh.length === 0) return;
    const batch = this.opts.batch;
    if (batch === undefined) {
      for (const entry of fresh) void this.run(entry);
      return;
    }
    void Promise.all(fresh.map((entry) => this.run(entry, true))).then((changes) => {
      // A retry may have moved an entry on while slower first checks ran: send what is current.
      const live = changes.flatMap((c) =>
        c?.active && c.verdict !== undefined ? [{ raw: c.raw, verdict: c.verdict }] : [],
      );
      if (live.length > 0) batch(live);
    });
  }
  /** One check; on the first run of a batched window a changed entry is returned, not emitted. */
  private async run(entry: Entry, first = false): Promise<Entry | undefined> {
    let verdict: Verdict;
    try {
      verdict = await this.gate(() => this.check(entry.raw, this.anchor));
    } catch {
      verdict = { state: 'unknown', reason: 'verification environment failed' };
    }
    if (!entry.active) return undefined;
    const isChange = entry.verdict?.state !== verdict.state;
    entry.verdict = verdict;
    if (verdict.state === 'unknown') {
      entry.timer = setTimeout(
        () => void this.run(entry),
        DELAYS[Math.min(entry.retries++, DELAYS.length - 1)],
      );
      entry.timer.unref?.();
    }
    if (!isChange) return undefined;
    if (first) return entry;
    this.changed(entry.raw, verdict);
    return undefined;
  }
  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.active = false;
      clearTimeout(entry.timer);
    }
    this.entries.clear();
  }
}
