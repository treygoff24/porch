import { afterEach, describe, expect, it, vi } from 'vitest';
import { dividerCount, dividerFor, mergeRecords } from '../src/derive.ts';
import { isAttentionEligible, newestEligible, newRecords } from '../src/records.ts';
import { PostStore } from '../src/store.ts';
import { raw, sandbox } from './helpers.ts';

describe('one attention predicate', () => {
  const self = { room: 'mara', participant: 'porch-self' };
  const message = raw('100');
  const emote = raw('101', { file: 'emote', event: 'emote' });
  it('ordinary messages, joins and profiles count; emotes, opaque events and own records do not', () => {
    for (const r of [message, raw('join', { event: 'join' }), raw('profile', { event: 'profile' })])
      expect(isAttentionEligible(r, self)).toBe(true);
    for (const r of [
      emote,
      raw('compat', { event: 'emote' }),
      raw('event', { event: 'signal' }),
      raw('own', { from: 'mara', fromParticipant: 'porch-self' }),
      raw('participant', { fromParticipant: 'porch-self' }),
    ])
      expect(isAttentionEligible(r, self)).toBe(false);
  });
  it('an unread message followed by emotes anchors and counts only the message', () => {
    const divider = dividerFor([message, emote], 1, self);
    expect(divider?.before).toBe('100');
    expect(newestEligible([message, emote], self)?.id).toBe('100');
    if (!divider) throw new Error('divider');
    expect(
      dividerCount(divider, [message, emote, raw('102', { file: 'emote', event: 'emote' })], self),
    ).toBe(1);
    expect(newRecords([message, emote], '099', self)).toHaveLength(1);
  });
  it('an emote-only viewport has no acknowledge target, divider or new count', () => {
    expect(newestEligible([emote], self)).toBeUndefined();
    expect(dividerFor([emote], 1, self)).toBeUndefined();
    expect(newRecords([emote], '099', self)).toHaveLength(0);
  });
  it('a late eligible arrival newer than the acknowledged position counts, even below newest known id', () => {
    const records = mergeRecords([message], [raw('099'), emote]);
    expect(records.map((r) => r.id)).toEqual(['099', '100', '101']);
    expect(newRecords(records, '098', self).map((r) => r.id)).toEqual(['099', '100']);
    expect(newRecords(records, '099', self).map((r) => r.id)).toEqual(['100']);
  });
  it('duplicates merge by id, complete bytes are retained and msg wins over emote', () => {
    const old = raw('100');
    expect(mergeRecords([old], [raw('100')])[0]).toBe(old);
    expect(mergeRecords([old], [raw('100', { bodyComplete: false })])[0]).toBe(old);
    expect(mergeRecords([old], [raw('100', { file: 'emote', event: 'emote' })])[0]).toBe(old);
  });
});

describe('polling policy', () => {
  const sandboxes: ReturnType<typeof sandbox>[] = [];
  const stores: PostStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
    for (const s of sandboxes.splice(0)) s.cleanup();
    vi.useRealTimers();
  });
  function setup() {
    const s = sandbox();
    sandboxes.push(s);
    const client = {
      owner: { ...s.cfg, participant: 'porch-self', signingBlocked: undefined },
      history: vi.fn(async () => ({ ok: true as const, value: [raw('100')] })),
      since: vi.fn(async () => ({ ok: true as const, value: [] as ReturnType<typeof raw>[] })),
      channels: vi.fn(async () => ({
        ok: true as const,
        value: [
          {
            name: 'commons',
            unread: 1,
            messages: 1,
            members: ['mara', 'crew'],
            participants: ['porch-self', 'p-a', 'p-b'],
            description: undefined,
            archived: false,
          },
        ],
      })),
      markRead: vi.fn(async () => ({ ok: true as const, value: { advanced: true } })),
      seenBy: vi.fn(async () => ({ ok: true as const, value: ['porch-self', 'p-a'] })),
      send: vi.fn(async () => ({ kind: 'confirmed' as const, id: 'sent' })),
      message: vi.fn(async () => ({ ok: true as const, value: raw('100') })),
    };
    const store = new PostStore({ client, markReadOnView: false, pollMs: 1000000000 });
    stores.push(store);
    return { store, client };
  }
  it('open, fifth poll and focus reconcile history; all other polls use since and never mark read', async () => {
    const { store, client } = setup();
    await store.open('commons');
    expect(client.history).toHaveBeenCalledTimes(1);
    client.history.mockResolvedValue({ ok: true, value: [raw('099'), raw('100')] });
    for (let i = 0; i < 4; i++) await store.poll('commons');
    expect(client.history).toHaveBeenCalledTimes(1);
    await store.poll('commons');
    expect(client.history).toHaveBeenCalledTimes(2);
    expect(store.getState().views.commons?.records.map((r) => r.id)).toEqual(['099', '100']);
    expect(client.since).toHaveBeenCalledWith('commons', '100');
    await store.regainFocus();
    expect(client.history).toHaveBeenCalledTimes(3);
    expect(client.markRead).not.toHaveBeenCalled();
  });
  it('emote-only acknowledge is a no-op; newest eligible visible message is the target', async () => {
    const { store, client } = setup();
    await store.open('commons');
    const emote = raw('999', { file: 'emote', event: 'emote' });
    expect((await store.acknowledge('commons', [emote])).ok).toBe(false);
    expect(client.markRead).not.toHaveBeenCalled();
    await store.acknowledge('commons', [raw('101'), emote, raw('100')]);
    expect(client.markRead).toHaveBeenCalledWith('commons', '101');
  });
  it('bridged own-room records and other local participants can be acknowledged, only local self is excluded', async () => {
    const { store, client } = setup();
    await store.open('commons');
    const self = { room: 'mara', participant: 'porch-self' };
    const bridged = raw('102', { from: 'mara', fromParticipant: 'porch-self', fromHost: 'mac' });
    const other = raw('101', { from: 'mara', fromParticipant: 'p-other' });
    const local = raw('103', { from: 'mara', fromParticipant: 'porch-self' });
    expect(newRecords([bridged, other, local], '100', self).map((r) => r.id)).toEqual([
      '102',
      '101',
    ]);
    await store.acknowledge('commons', [other, bridged, local]);
    expect(client.markRead).toHaveBeenCalledWith('commons', '102');
  });
  it('a failed exact read preserves that record and lets the other incomplete record complete', async () => {
    const { store, client } = setup();
    client.history.mockResolvedValue({
      ok: true,
      value: [raw('100', { bodyComplete: false }), raw('101', { bodyComplete: false })],
    });
    client.message.mockImplementation(async (_channel?: string, id?: string) => {
      if (id === '100') throw new Error('unreadable record');
      return { ok: true, value: raw('101') };
    });
    await store.open('commons');
    expect(store.getState().views.commons?.records.map((r) => [r.id, r.bodyComplete])).toEqual([
      ['100', false],
      ['101', true],
    ]);
  });
  it('scheduled read failures become a channel error and the next poll still runs', async () => {
    vi.useFakeTimers();
    const { store, client } = setup();
    await store.open('commons');
    client.since.mockRejectedValueOnce(new Error('post unavailable\x1b'));
    await vi.advanceTimersByTimeAsync(1000000000);
    expect(store.getState().views.commons?.error).toBe('post unavailable');
    await vi.advanceTimersByTimeAsync(1000000000);
    expect(client.since).toHaveBeenCalledTimes(2);
  });
  it('a channel Trey has not joined reads as empty with no error; joining then reads it', async () => {
    const { store, client } = setup();
    const notMember = {
      ok: false as const,
      error: { code: 'not_a_member', message: 'not a member', retryable: false },
    };
    client.history.mockResolvedValue(notMember as never);
    await store.open('commons');
    expect(store.getState().views.commons?.error).toBeUndefined();
    expect(store.getState().views.commons?.records).toEqual([]);
    client.history.mockResolvedValue({ ok: true, value: [raw('100')] } as never);
    await store.poll('commons', true);
    expect(store.getState().views.commons?.records.map((r) => r.id)).toEqual(['100']);
  });
  it('a read that works clears the error an earlier read left, with no new records', async () => {
    vi.useFakeTimers();
    const { store, client } = setup();
    await store.open('commons');
    client.since.mockRejectedValueOnce(new Error('post unavailable'));
    await vi.advanceTimersByTimeAsync(1000000000);
    expect(store.getState().views.commons?.error).toBe('post unavailable');
    await vi.advanceTimersByTimeAsync(1000000000);
    expect(store.getState().views.commons?.error).toBeUndefined();
  });
  it('one message poll in flight and a closed channel cannot receive its late response', async () => {
    const { store, client } = setup();
    await store.open('commons');
    let release: (value: { ok: true; value: ReturnType<typeof raw>[] }) => void = () => {};
    client.since.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = store.poll('commons');
    await store.poll('commons');
    expect(client.since).toHaveBeenCalledTimes(1);
    store.close('commons');
    release({ ok: true, value: [raw('999')] });
    await pending;
    expect(store.getState().views.commons?.records.map((r) => r.id)).toEqual(['100']);
  });
  it('focus reconciliation is queued when a message poll is already running', async () => {
    const { store, client } = setup();
    await store.open('commons');
    let release: (value: { ok: true; value: ReturnType<typeof raw>[] }) => void = () => {};
    client.since.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = store.poll('commons');
    await store.regainFocus();
    expect(client.history).toHaveBeenCalledTimes(1);
    release({ ok: true, value: [] });
    await pending;
    expect(client.history).toHaveBeenCalledTimes(2);
  });
  it('seen receipts emit new participants once and stop when everyone has seen', async () => {
    vi.useFakeTimers();
    const { store, client } = setup();
    await store.open('commons');
    const seen = vi.fn();
    store.onSeen(seen);
    store.trackConfirmed('commons', 'sent');
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.seenBy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toHaveBeenCalledWith('commons', 'sent', 'p-a');
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toHaveBeenCalledTimes(1);
    client.seenBy.mockResolvedValue({ ok: true, value: ['p-a', 'p-b', 'porch-self'] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toHaveBeenCalledTimes(2);
    const calls = client.seenBy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.seenBy).toHaveBeenCalledTimes(calls);
  });
  it('one seen request in flight, superseded and closed tracks suppress stale observations', async () => {
    vi.useFakeTimers();
    const { store, client } = setup();
    await store.open('commons');
    const seen = vi.fn();
    store.onSeen(seen);
    let release: (value: { ok: true; value: string[] }) => void = () => {};
    client.seenBy.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    store.trackConfirmed('commons', 'old');
    await vi.advanceTimersByTimeAsync(8000);
    expect(client.seenBy).toHaveBeenCalledTimes(1);
    store.trackConfirmed('commons', 'new');
    release({ ok: true, value: ['p-a'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.seenBy).toHaveBeenCalledWith('commons', 'new');
    store.close('commons');
    release({ ok: true, value: ['p-b'] });
    await vi.advanceTimersByTimeAsync(10000);
    expect(seen).not.toHaveBeenCalled();
  });
  it('ten-minute horizon stops seen polling', async () => {
    vi.useFakeTimers();
    const { store, client } = setup();
    await store.open('commons');
    store.trackConfirmed('commons', 'sent');
    await vi.advanceTimersByTimeAsync(600000);
    const calls = client.seenBy.mock.calls.length;
    expect(calls).toBe(299);
    await vi.advanceTimersByTimeAsync(10000);
    expect(client.seenBy).toHaveBeenCalledTimes(calls);
  });
  it('a seen response that crosses the ten-minute horizon cannot emit new receipts', async () => {
    vi.useFakeTimers();
    const { store, client } = setup();
    await store.open('commons');
    const seen = vi.fn();
    store.onSeen(seen);
    let release: (value: { ok: true; value: string[] }) => void = () => {};
    client.seenBy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const started = Date.now();
    store.trackConfirmed('commons', 'sent');
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.seenBy).toHaveBeenCalledTimes(1);
    vi.setSystemTime(started + 600001);
    release({ ok: true, value: ['p-b'] });
    await vi.advanceTimersByTimeAsync(10000);
    expect(seen).not.toHaveBeenCalled();
    expect(client.seenBy).toHaveBeenCalledTimes(1);
  });
  it('incomplete reads trigger exact retrieval; opening never silently acknowledges', async () => {
    const { store, client } = setup();
    client.history.mockResolvedValue({ ok: true, value: [raw('100', { bodyComplete: false })] });
    await store.open('commons');
    expect(client.message).toHaveBeenCalledWith('commons', '100');
    expect(store.getState().views.commons?.records[0]?.bodyComplete).toBe(true);
    expect(client.markRead).not.toHaveBeenCalled();
  });
});
