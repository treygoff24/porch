/**
 * The app holds one `DraftSpace` for drafts and send recovery (T6 ruling). These go through the
 * client's default construction (no injected recovery), with a runner standing in for post, and a
 * real `flock` on the real drafts directory: a drafts save holding the lock past the 3 s lock
 * timeout must delay a send, not fail it.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { OwnerPost } from '../src/client.ts';
import type { RunSpec } from '../src/run.ts';
import { DraftSpace, LOCK_TIMEOUT_MS } from '../src/stores/drafts.ts';
import { jsonOutcome, sandbox } from './helpers.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOLD_MS = LOCK_TIMEOUT_MS + 500;

describe('send recovery on the shared drafts space', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  const sends: string[][] = [];
  const run = vi.fn(async (_exe: string, spec: RunSpec) => {
    const [verb, sub] = spec.args;
    if (verb === 'owner')
      return jsonOutcome({
        ok: true,
        state: 'configured',
        owner: {
          room: 'mara',
          marker: s.cfg.marker,
          label: s.cfg.label,
          principal: s.cfg.principal,
          namespace: s.cfg.namespace,
          sidecar_dir: s.cfg.sidecarDir,
          allowed_signers: s.cfg.allowedSigners,
        },
      });
    if (verb === 'participant')
      return jsonOutcome({
        ok: true,
        status: 'bound',
        id: 'porch-abcdef',
        participant: { id: 'porch-abcdef', workspace: 'mara', harness: 'porch' },
      });
    if (verb === 'profile' && sub === 'show') return jsonOutcome({ ok: true, room: 'mara' });
    if (spec.args.includes('--send')) {
      sends.push(spec.args);
      return jsonOutcome({
        ok: true,
        message: { id: `sent-${sends.length}`, from: 'mara', channel: 'commons' },
      });
    }
    return jsonOutcome({ ok: true });
  });

  it('a send waits behind a drafts save on the same space and still goes out', async () => {
    const space = new DraftSpace(s.cfg);
    const r = await OwnerPost.connect({ config: s.cfg, env: s.env, run, space });
    if (!r.ok) throw new Error(r.error.message);
    let released = false;
    const hold = space.locked(async () => {
      await delay(HOLD_MS);
      released = true;
    });
    await delay(50);
    const started = performance.now();
    const outcome = await r.value.send('commons', 'hello crew');
    expect(outcome).toMatchObject({ kind: 'confirmed', id: 'sent-1' });
    // It went out only after the save let go of the lock, and the recovery record is gone again.
    expect(released).toBe(true);
    expect(performance.now() - started).toBeGreaterThan(LOCK_TIMEOUT_MS);
    await hold;
    const { SendRecord } = await import('../src/recovery.ts');
    expect(await new SendRecord(space).list()).toEqual([]);
  }, 20000);

  it('the hazard is real: a space of its own times out while another holds the lock', async () => {
    const holder = new DraftSpace(s.cfg);
    const r = await OwnerPost.connect({ config: s.cfg, env: s.env, run });
    if (!r.ok) throw new Error(r.error.message);
    const hold = holder.locked(() => delay(HOLD_MS));
    await delay(50);
    const before = sends.length;
    const outcome = await r.value.send('commons', 'hello again');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'recovery_failed' });
    expect(sends.length).toBe(before);
    await hold;
  }, 20000);
});
