import { symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { crossCheck } from '../src/owner.ts';
import { parseRaw, toDisplay } from '../src/records.ts';
import { MAX_SIGNED_BODY_BYTES, manifestBytes } from '../src/signing.ts';
import { VerificationScheduler } from '../src/verification-scheduler.ts';
import { verify } from '../src/verify.ts';
import { goldenCases, raw, sandbox } from './helpers.ts';

describe('held raw bytes and four verdicts', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  for (const vector of goldenCases)
    it(vector.name, async () => {
      const record = parseRaw(vector.record, 'commons');
      expect(record).toBeDefined();
      if (record === undefined) throw new Error('missing vector');
      expect((await verify(record, s.cfg)).state).toBe(vector.expected);
      expect(record.envelope.future_field).toEqual({ kept: true });
    });
  it('preserves CRLF, trailing whitespace, ESC and C1 in raw bytes, strips display controls', async () => {
    const record = parseRaw(goldenCases[0]?.record, 'commons');
    if (record === undefined) throw new Error('missing vector');
    const verdict = await verify(record, s.cfg);
    const display = toDisplay(record, { anchor: s.cfg, verdict });
    expect(record.body).toContain('\r\n');
    expect(record.body).toContain('\x1b');
    expect(record.body).toContain('\x85');
    expect(record.body.endsWith('\t \r\n')).toBe(true);
    expect(display.text).toContain('\t \n');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: assert terminal controls were removed
    expect(display.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
    expect(record.body).toBe(goldenCases[0]?.record.body);
  });
  it('replaces legacy syntax for every verdict; failed claims never become attribution', () => {
    const record = parseRaw(goldenCases.find((v) => v.name === 'signed-v1')?.record, 'commons');
    if (record === undefined) throw new Error('missing vector');
    for (const state of ['verified', 'failed', 'unknown', 'unsigned'] as const) {
      const display = toDisplay(record, { anchor: s.cfg, verdict: { state, reason: 'test' } });
      expect(display.text).not.toContain('[signed:');
      expect(display.text).toContain(`[${state}]`);
      expect(display.sender.isOwner).toBe(state === 'verified' || state === 'unsigned');
      if (state === 'failed') expect(display.sender.text).toBe('claims Mara');
    }
  });
  it('post signed_verified never overrides Porch verification', async () => {
    const record = parseRaw(
      { ...goldenCases[0]?.record, body: 'forged', signed_verified: true },
      'commons',
    );
    if (record === undefined) throw new Error('missing record');
    expect((await verify(record, s.cfg)).state).toBe('failed');
  });
  it('owner disagreement yields no verdict even when local cryptographic evidence is valid', async () => {
    const record = parseRaw(goldenCases[0]?.record, 'commons');
    if (record === undefined) throw new Error('vector');
    const run = vi.fn();
    expect((await verify(record, { ...s.cfg, signingBlocked: 'marker' }, { run })).state).toBe(
      'unknown',
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('unsigned and unavailable evidence remain distinct; missing or unsafe sidecars are unknown', async () => {
    expect((await verify(raw(), s.cfg)).state).toBe('unsigned');
    const record = parseRaw(
      { ...goldenCases[0]?.record, signature_ref: { version: 2, tag: 'missing' } },
      'commons',
    );
    if (record === undefined) throw new Error('missing record');
    expect((await verify(record, s.cfg)).state).toBe('unknown');
    const link = join(s.cfg.sidecarDir, 'sigs', 'missing.txt');
    symlinkSync(join(s.cfg.sidecarDir, 'sigs', '20260930T230000Z.txt'), link);
    expect((await verify(record, s.cfg)).state).toBe('unknown');
    unlinkSync(link);
  });
  it('agent discussion of signing is unsigned', async () => {
    const discussion = raw('discussion', { body: 'Use [signed:tag] for the signature trailer.' });
    expect((await verify(discussion, s.cfg)).state).toBe('unsigned');
    expect(toDisplay(discussion, { anchor: s.cfg }).verdict.state).toBe('unsigned');
  });
  it('owner casual text is attributed on its first display; a signature claim still awaits verification', () => {
    const casual = raw('casual', { from: s.cfg.ownerRoom, body: `${s.cfg.marker} casual` });
    expect(toDisplay(casual, { anchor: s.cfg })).toMatchObject({
      text: 'casual',
      verdict: { state: 'unsigned' },
      sender: { text: 'Mara', isOwner: true },
    });
    const claim = raw('claim', {
      from: s.cfg.ownerRoom,
      body: `${s.cfg.marker}🔏 payload [signed:tag]`,
    });
    expect(toDisplay(claim, { anchor: s.cfg })).toMatchObject({
      verdict: { state: 'unknown' },
      sender: { text: 'claims Mara', isOwner: false },
    });
  });
  it('environment failure retries as unknown; cryptographic refusal is failed', async () => {
    const record = parseRaw(goldenCases[0]?.record, 'commons');
    if (!record) throw new Error('vector');
    expect(
      (
        await verify(record, s.cfg, {
          run: async () => ({ code: null, stdout: '', stderr: '', failed: 'missing' }),
        })
      ).state,
    ).toBe('unknown');
    expect(
      (
        await verify(record, s.cfg, {
          run: async () => ({ code: 1, stdout: '', stderr: 'bad signature' }),
        })
      ).state,
    ).toBe('failed');
  });
  it('manifest count and hash bind whitespace, channel, and UTF-8 bytes', () => {
    const body = Buffer.from(
      '2066697273740d0a0d6c696e650ae280a8e280a90065cc81f09f91a9e2808df09f9a80f09fa68af09f948f205b7369676e65643a424149545d090a',
      'hex',
    ).toString('utf8');
    expect(manifestBytes('20260812T203000Zabc123', 'commons', body).toString()).toBe(
      'porch-signed-v2\ntag: 20260812T203000Zabc123\nchannel: commons\nbytes: 59\nsha256: 1fdee400fc1199ae6cb6d66e9625640bdb0b5631f18f31314da330a9803642e7\n',
    );
    expect(() => manifestBytes('bad/tag', 'commons', '')).toThrow();
    expect(() => manifestBytes('tag', '../commons', '')).toThrow();
    expect(() => manifestBytes('tag', '機械室', 'hello')).not.toThrow();
    expect(() => manifestBytes('tag', 'commons', '\ud800')).toThrow('UTF-8');
  });
  it('refuses over-cap body before crypto', async () => {
    const run = vi.fn();
    const record = parseRaw(
      { ...goldenCases[0]?.record, body: 'x'.repeat(MAX_SIGNED_BODY_BYTES + 1) },
      'commons',
    );
    if (!record) throw new Error('record');
    expect((await verify(record, s.cfg, { run })).state).toBe('failed');
    expect(run).not.toHaveBeenCalled();
  });
  it('lineage and participant labels are sanitized and retained', () => {
    const display = toDisplay(raw('id', { fromLineage: 'crew\x1b', fromParticipant: 'p\u202e' }), {
      anchor: s.cfg,
    });
    expect(display.sender.text).toBe('crew [p]');
  });
  it('records and locators cannot change after verification; malformed locators retain no legacy syntax', async () => {
    const legacy = goldenCases.find((v) => v.name === 'signed-v1')?.record;
    const record = parseRaw({ ...legacy, signature_ref: null }, 'commons');
    if (record === undefined) throw new Error('vector');
    expect(() => {
      record.body = 'forged';
    }).toThrow();
    const display = toDisplay(record, { anchor: s.cfg, verdict: await verify(record, s.cfg) });
    expect(display.text).not.toContain('[signed:');
    expect(display.text).not.toContain('🔏');
    expect(display.verdict.state).toBe('failed');
  });
});

describe('owner anchor agreement', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  const owner = {
    room: s.cfg.ownerRoom,
    marker: s.cfg.marker,
    label: s.cfg.label,
    principal: s.cfg.principal,
    namespace: s.cfg.namespace,
    sidecar_dir: s.cfg.sidecarDir,
    allowed_signers: s.cfg.allowedSigners,
  };
  for (const key of Object.keys(owner))
    it(`mismatch: ${key}`, () => {
      const result = crossCheck(s.cfg, {
        state: 'configured',
        owner: { ...owner, [key]: 'different' },
      });
      expect(result.kind).toBe(key === 'room' ? 'stop' : 'unsigned');
    });
  it('agree and missing anchor', () => {
    expect(crossCheck(s.cfg, { state: 'configured', owner }).kind).toBe('agree');
    expect(crossCheck(s.cfg, { state: 'legacy' }).kind).toBe('unsigned');
  });
});

describe('unknown verification retry schedule', () => {
  let s: ReturnType<typeof sandbox>;
  beforeAll(() => {
    s = sandbox();
  });
  afterAll(() => {
    s.cleanup();
    vi.useRealTimers();
  });
  it('2,4,8,16,32,60 seconds; only changed verdict emits; unloading cancels', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => ({ state: 'unknown' as const, reason: 'environment' }));
    const changed = vi.fn();
    const scheduler = new VerificationScheduler(s.cfg, changed, check);
    scheduler.window([raw()]);
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const calls = check.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(check).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(check).toHaveBeenCalledTimes(calls + 1);
    }
    expect(changed).toHaveBeenCalledTimes(1);
    scheduler.window([]);
    const calls = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(check).toHaveBeenCalledTimes(calls);
    scheduler.dispose();
    vi.useRealTimers();
  });
  it('unknown becomes verified without a render-triggered check', async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const check = vi
      .fn()
      .mockResolvedValueOnce({ state: 'unknown', reason: 'gone' })
      .mockResolvedValue({ state: 'verified', reason: 'back' });
    const scheduler = new VerificationScheduler(s.cfg, changed, check);
    const record = raw();
    scheduler.window([record]);
    await vi.advanceTimersByTimeAsync(0);
    scheduler.window([record]);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(check).toHaveBeenCalledTimes(2);
    scheduler.dispose();
    vi.useRealTimers();
  });
});
