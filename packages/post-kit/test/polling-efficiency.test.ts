/**
 * T3a review finding 12, carried into T6: one `post channels` per poll cycle shared by every open
 * view and the seen-by poll; a limit on exact re-reads of incomplete bodies; first verdicts of a
 * channel opening delivered as one update; a limit on concurrent verifications.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RawRecord, toDisplay, type Verdict } from '../src/records.ts';
import { PostStore } from '../src/store.ts';
import { VerificationScheduler } from '../src/verification-scheduler.ts';
import { raw, sandbox } from './helpers.ts';

const sandboxes: ReturnType<typeof sandbox>[] = [];
const stores: PostStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  for (const s of sandboxes.splice(0)) s.cleanup();
  vi.useRealTimers();
});

function summary(name: string, messages = 1) {
  return {
    name,
    unread: 0,
    messages,
    members: ['mara', 'crew'],
    participants: ['porch-self', 'p-a'],
    description: undefined,
    archived: false,
  };
}

function setup(opts: Partial<ConstructorParameters<typeof PostStore>[0]> = {}) {
  const s = sandbox();
  sandboxes.push(s);
  const counts = { alpha: 1, beta: 1, gamma: 1 };
  const client = {
    owner: { ...s.cfg, participant: 'porch-self', signingBlocked: undefined },
    history: vi.fn(async (channel: string) => ({
      ok: true as const,
      value: [raw('100', { channel, storageChannel: channel })],
    })),
    since: vi.fn(async () => ({ ok: true as const, value: [] as RawRecord[] })),
    channels: vi.fn(async () => ({
      ok: true as const,
      value: Object.entries(counts).map(([name, n]) => summary(name, n)),
    })),
    markRead: vi.fn(async () => ({ ok: true as const, value: { advanced: true } })),
    seenBy: vi.fn(async () => ({ ok: true as const, value: ['porch-self'] })),
    send: vi.fn(async () => ({ kind: 'confirmed' as const, id: 'sent' })),
    message: vi.fn(async (channel: string, id: string) => ({
      ok: true as const,
      value: raw(id, { channel, storageChannel: channel }),
    })),
  };
  const store = new PostStore({ client, markReadOnView: false, pollMs: 1000, ...opts });
  stores.push(store);
  return { store, client, counts };
}

describe('one listing per poll cycle', () => {
  it('every open view and the seen-by poll share a single post channels call per cycle', async () => {
    vi.useFakeTimers();
    const { store, client } = setup({ pollMs: 2000 });
    await store.open('alpha');
    await store.open('beta');
    store.trackConfirmed('alpha', 'sent');
    client.channels.mockClear();
    client.since.mockClear();
    client.seenBy.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    // One cycle: one listing, both channels read, one seen-by observation and no listing of its own.
    expect(client.channels).toHaveBeenCalledTimes(1);
    expect(client.since).toHaveBeenCalledTimes(2);
    expect(client.seenBy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000 * 4);
    expect(client.channels).toHaveBeenCalledTimes(5);
  });

  it('a background lane is read when post says its count moved, or every fifth cycle', async () => {
    vi.useFakeTimers();
    const { store, client, counts } = setup();
    await store.open('alpha');
    await store.open('gamma', { background: true });
    client.since.mockClear();
    client.history.mockClear();
    const reads = (channel: string) =>
      [...client.since.mock.calls, ...client.history.mock.calls].filter(([c]) => c === channel)
        .length;
    await vi.advanceTimersByTimeAsync(1000 * 3);
    expect(reads('alpha')).toBe(3);
    expect(reads('gamma')).toBe(0);
    counts.gamma = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads('gamma')).toBe(1);
    // Cycle five reads it whatever the count says.
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads('gamma')).toBe(2);
    store.setBackground('gamma', false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads('gamma')).toBe(3);
  });

  it('closing every channel stops the cycle', async () => {
    vi.useFakeTimers();
    const { store, client } = setup();
    await store.open('alpha');
    store.close('alpha');
    client.channels.mockClear();
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.channels).not.toHaveBeenCalled();
  });
});

describe('bounded work', () => {
  it('re-reads of incomplete bodies run at most two at a time', async () => {
    const { store, client } = setup();
    const ids = Array.from({ length: 12 }, (_, i) => String(200 + i));
    client.history.mockResolvedValue({
      ok: true,
      value: ids.map((id) =>
        raw(id, { channel: 'alpha', storageChannel: 'alpha', bodyComplete: false }),
      ),
    });
    let active = 0;
    let most = 0;
    client.message.mockImplementation(async (channel: string, id: string) => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, value: raw(id, { channel, storageChannel: channel }) };
    });
    await store.open('alpha');
    expect(client.message).toHaveBeenCalledTimes(12);
    expect(most).toBe(2);
    expect(store.getState().views.alpha?.records.every((r) => r.bodyComplete)).toBe(true);
  });

  it('verifications run at most four at a time', async () => {
    const s = sandbox();
    sandboxes.push(s);
    let active = 0;
    let most = 0;
    const check = vi.fn(async (): Promise<Verdict> => {
      active += 1;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { state: 'verified', reason: 'ok' };
    });
    const batches: number[] = [];
    const scheduler = new VerificationScheduler(s.cfg, vi.fn(), check, {
      batch: (changes) => batches.push(changes.length),
    });
    scheduler.window(Array.from({ length: 20 }, (_, i) => raw(String(300 + i))));
    await vi.waitFor(() => expect(batches).toEqual([20]));
    expect(check).toHaveBeenCalledTimes(20);
    expect(most).toBe(4);
    scheduler.dispose();
  });

  it('a channel opening delivers its first verdicts as one update', async () => {
    const { store, client } = setup({
      verify: async (r) =>
        r.id === '120'
          ? { state: 'failed', reason: 'mismatch' }
          : { state: 'verified', reason: 'ok' },
    });
    client.history.mockResolvedValue({
      ok: true,
      value: Array.from({ length: 50 }, (_, i) =>
        raw(String(100 + i), { channel: 'alpha', storageChannel: 'alpha' }),
      ),
    });
    const updates = vi.fn();
    store.subscribe(updates);
    await store.open('alpha');
    updates.mockClear();
    await vi.waitFor(() =>
      expect(Object.keys(store.getState().views.alpha?.verdicts ?? {})).toHaveLength(50),
    );
    expect(updates).toHaveBeenCalledTimes(1);
    expect(store.getState().views.alpha?.verdicts['120']?.state).toBe('failed');
  });
});

describe('no false impersonation flash (finding 13)', () => {
  it("Trey's casual message is decided unsigned before verification runs, never 'claims'", () => {
    const s = sandbox();
    sandboxes.push(s);
    const casual = raw('400', { from: 'mara', body: `${s.cfg.marker} morning crew` });
    const shown = toDisplay(casual, { anchor: s.cfg });
    expect(shown.verdict.state).toBe('unsigned');
    expect(shown.sender.text).toBe(s.cfg.label);
    expect(shown.sender.isOwner).toBe(true);
    expect(shown.text).toBe('morning crew');
    // A claim, by contrast, is never attributed until it verifies.
    const claimed = raw('401', {
      from: 'mara',
      signature: { present: true, raw: { version: 2, tag: '20260930T230000Z' } },
    });
    expect(toDisplay(claimed, { anchor: s.cfg }).sender.text).toBe(`claims ${s.cfg.label}`);
  });
});
