/**
 * Trey's own send is read back at once: `refreshChannel` is a read that begins after the call, not
 * the next poll tick, and one already in flight does not satisfy it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostStore } from '../src/store.ts';
import { raw, sandbox } from './helpers.ts';

describe('refreshChannel', () => {
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
      channels: vi.fn(async () => ({ ok: true as const, value: [] })),
      markRead: vi.fn(async () => ({ ok: true as const, value: { advanced: true } })),
      seenBy: vi.fn(async () => ({ ok: true as const, value: [] as string[] })),
      send: vi.fn(async () => ({ kind: 'confirmed' as const, id: 'sent' })),
      message: vi.fn(async () => ({ ok: true as const, value: raw('100') })),
    };
    // The poll tick is far away: only an explicit read can bring the record in time.
    const store = new PostStore({ client, markReadOnView: false, pollMs: 1_000_000_000 });
    stores.push(store);
    return { store, client };
  }

  it('reads the channel now and the new record is in the view when it resolves', async () => {
    const { store, client } = setup();
    await store.open('commons');
    client.since.mockResolvedValue({ ok: true, value: [raw('101')] });
    await store.refreshChannel('commons');
    expect(store.getState().views.commons?.records.map((r) => r.id)).toEqual(['100', '101']);
    expect(client.since).toHaveBeenLastCalledWith('commons', '100');
  });

  it('a read already running began too early: it is followed by another that resolves the call', async () => {
    const { store, client } = setup();
    await store.open('commons');
    const first: { release: (v: { ok: true; value: ReturnType<typeof raw>[] }) => void } = {
      release: () => {},
    };
    client.since.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first.release = resolve;
        }),
    );
    const running = store.poll('commons');
    let done = false;
    const refreshed = store.refreshChannel('commons').then(() => {
      done = true;
    });
    // The record landed after the running read began, so that read cannot have it.
    client.since.mockResolvedValue({ ok: true, value: [raw('101')] });
    first.release({ ok: true, value: [] });
    await running;
    await refreshed;
    expect(done).toBe(true);
    expect(client.since).toHaveBeenCalledTimes(2);
    expect(store.getState().views.commons?.records.map((r) => r.id)).toEqual(['100', '101']);
  });

  it('resolves at once for a channel that is not open', async () => {
    const { store, client } = setup();
    await store.refreshChannel('elsewhere');
    expect(client.since).not.toHaveBeenCalled();
    expect(client.history).not.toHaveBeenCalled();
  });

  it('resolves when the channel closes under a waiting call', async () => {
    const { store, client } = setup();
    await store.open('commons');
    const gate: { release: (v: { ok: true; value: ReturnType<typeof raw>[] }) => void } = {
      release: () => {},
    };
    client.since.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          gate.release = resolve;
        }),
    );
    const running = store.poll('commons');
    const waiting = store.refreshChannel('commons');
    store.close('commons');
    gate.release({ ok: true, value: [] });
    await running;
    await waiting;
  });
});
