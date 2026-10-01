import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runVerifyCli, signatureAge } from '../src/verify-cli.ts';
import {
  goldenCases,
  initializePost,
  jsonOutcome,
  realPost,
  sandbox,
  writeMessage,
} from './helpers.ts';

describe('porch-verify exit protocol', () => {
  const s = sandbox();
  const vector = goldenCases[0]?.record;
  if (!vector) throw new Error('vector');
  const id = vector.id as string;
  beforeAll(async () => {
    await initializePost(s);
    writeMessage(s, vector);
  });
  afterAll(() => s.cleanup());
  const options = () => ({
    config: s.cfg,
    env: { ...s.env, PORCH_POST_BIN: realPost as string },
    stdout: () => {},
    stderr: () => {},
  });
  it('0 verified from held message bytes', async () => {
    expect(await runVerifyCli([id, '--channel', 'commons'], options())).toBe(0);
  });
  it('1 cryptographic/body failure', async () => {
    const bad = { ...vector, id: '20260930-230000-000002-abcdef', body: 'forged' };
    writeMessage(s, bad);
    expect(await runVerifyCli([bad.id, '--channel', 'commons'], options())).toBe(1);
  });
  it('2 usage, invalid id, config and trust-anchor mismatch', async () => {
    for (const args of [
      [],
      ['bad'],
      ['--stdin', id],
      ['--stdin', '--channel', 'commons'],
      [id, '--channel', '../etc'],
    ])
      expect(await runVerifyCli(args, options())).toBe(2);
    expect(
      await runVerifyCli([id], {
        env: options().env,
        stdout: () => {},
        stderr: () => {},
        loadConfig: async () => {
          throw new Error('no config');
        },
      }),
    ).toBe(2);
    expect(
      await runVerifyCli([id], {
        ...options(),
        run: async () => jsonOutcome({ state: 'configured', owner: { room: 'other' } }),
      }),
    ).toBe(2);
  });
  it('3 not found or duplicate; neither is a verdict', async () => {
    expect(await runVerifyCli(['20260930-230000-000003-abcdef'], options())).toBe(3);
    writeMessage(s, { ...vector, channel: 'other' }, 'other');
    expect(await runVerifyCli([id], options())).toBe(3);
    expect(await runVerifyCli([id, '--channel', 'commons'], options())).toBe(0);
  });
  it('4 missing tool, IO/unsafe file and missing evidence are environment failures', async () => {
    expect(
      await runVerifyCli([id], {
        ...options(),
        run: async () => ({ code: null, stdout: '', stderr: '', failed: 'missing' }),
      }),
    ).toBe(4);
    const messages = join(s.cfg.mailRoot, 'channels', 'unsafe', 'messages');
    mkdirSync(messages, { recursive: true });
    symlinkSync(
      join(s.cfg.mailRoot, 'channels', 'commons', 'messages', `${id}.msg`),
      join(messages, `${id}.msg`),
    );
    expect(await runVerifyCli([id, '--channel', 'unsafe'], options())).toBe(4);
    const absent = {
      ...vector,
      id: '20260930-230000-000004-abcdef',
      signature_ref: { version: 2, tag: 'absent' },
    };
    writeMessage(s, absent);
    expect(await runVerifyCli([absent.id, '--channel', 'commons'], options())).toBe(4);
  });
  it('stdin is legacy-only: v1 verifies, v2 unsigned body fails', async () => {
    const legacy = goldenCases.find((v) => v.name === 'signed-v1')?.record.body as string;
    expect(
      await runVerifyCli(['--stdin'], { ...options(), stdin: async () => Buffer.from(legacy) }),
    ).toBe(0);
    expect(
      await runVerifyCli(['--stdin'], {
        ...options(),
        stdin: async () => Buffer.from(`\ufeff${legacy}`),
      }),
    ).toBe(1);
    expect(
      await runVerifyCli(['--stdin'], {
        ...options(),
        stdin: async () => Buffer.from(vector.body as string),
      }),
    ).toBe(1);
  });
  it('actual executable preserves the exit codes', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, '..', 'bin', 'porch-verify')],
      { env: { ...s.env, PORCH_POST_BIN: realPost as string }, encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
  it('keeps Python’s freshness and replay warnings in the verification output', () => {
    const now = Date.parse('2026-09-30T23:00:00Z');
    expect(signatureAge('20260930T225000Z', now)).toBe('10m ago');
    expect(signatureAge('20260930T210000Z', now)).toContain('CHECK: is this current?');
    expect(signatureAge('20260927T230000Z', now)).toContain('STALE: possible replay');
    expect(signatureAge('20260930T230000Zabcdef', now)).toContain('age unparseable');
    expect(signatureAge('20260230T230000Z', now)).toContain('age unparseable');
  });
});
