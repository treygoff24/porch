import { afterAll, describe, expect, it, vi } from 'vitest';
import { classifySend, SendTransaction, shouldClearDraft } from '../src/send.ts';
import type { SignedSidecar } from '../src/signing.ts';
import { jsonOutcome, sandbox } from './helpers.ts';

describe('single send transaction and outcome table', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  const owner = { ...s.cfg, participant: 'porch-abcdef', signingBlocked: undefined };
  const receipt = {
    ok: true,
    message: { id: 'landed', from: 'mara', channel: 'commons' },
    crossed: {
      unseen: 2,
      addressed_to_you: 1,
      messages: [{ id: 'crossed', from: 'agent', channel: 'commons', sent: 'now', body: 'hi' }],
    },
  };
  const request = {
    channel: 'commons',
    body: 'words \r\n',
    mode: 'casual' as const,
    draftRevision: 3,
  };
  const rows = [
    ['confirmed', jsonOutcome(receipt)],
    [
      'committed',
      {
        code: 70,
        stdout: '',
        stderr: JSON.stringify({ ok: false, error: { code: 'delivered_output_failure' } }),
      },
    ],
    ['committed', jsonOutcome({ ok: false, error: { code: 'delivered_unarchived' } }, 70)],
    ['uncertain', { code: null, stdout: '', stderr: '', failed: 'timeout' as const }],
    ['uncertain', { code: 0, stdout: 'not JSON', stderr: '' }],
    ['uncertain', jsonOutcome({ ok: false, error: { code: 'invalid_argument' } })],
    [
      'uncertain',
      jsonOutcome({ ok: true, message: { id: 'wrong', from: 'agent', channel: 'commons' } }),
    ],
    [
      'uncertain',
      jsonOutcome({ ok: true, message: { id: 'wrong', from: 'mara', channel: 'elsewhere' } }),
    ],
    ['uncertain', jsonOutcome({ ok: true, message: { id: '', from: 'mara', channel: 'commons' } })],
    ['uncertain', jsonOutcome({ ok: false, error: { code: 9 } }, 65)],
    [
      'refused',
      jsonOutcome({ ok: false, error: { code: 'invalid_argument', message: 'refused' } }, 65),
    ],
    ['refused', { code: null, stdout: '', stderr: '', failed: 'spawn' as const }],
  ] as const;
  for (const [kind, output] of rows)
    it(`${kind}: ${JSON.stringify(output).slice(0, 90)}`, async () => {
      const recovery = { record: vi.fn(async () => 'saved'), remove: vi.fn(async () => {}) };
      const discard = vi.fn(async () => {});
      const sidecar: SignedSidecar = {
        signature_ref: { version: 2, tag: 'tag' },
        payload: 'payload',
        signature: 'sig',
        discard,
      };
      const post = vi.fn(async () => output);
      const transaction = new SendTransaction({ owner, recovery, post, sign: async () => sidecar });
      const outcome = await transaction.send({ ...request, mode: 'signed' });
      expect(outcome.kind).toBe(kind);
      expect(recovery.remove).toHaveBeenCalledTimes(kind === 'uncertain' ? 0 : 1);
      expect(discard).toHaveBeenCalledTimes(kind === 'refused' ? 1 : 0);
      expect(shouldClearDraft(outcome, 3, 3)).toBe(kind !== 'refused');
      expect(shouldClearDraft(outcome, 3, 4)).toBe(kind === 'uncertain' || kind === 'committed');
      expect(transaction.ownMessageIds.has('landed')).toBe(kind === 'confirmed');
      if (outcome.kind === 'confirmed') expect(outcome.crossed?.messages[0]?.body).toBe('hi');
    });
  it('writes recovery before signing/post; frozen channel, text, reply and revision survive caller mutation', async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const recovery = {
      record: vi.fn(async () => {
        await blocker;
        return 'saved';
      }),
      remove: vi.fn(async () => {}),
    };
    const post = vi.fn(async (_args: string[], _input?: string) => jsonOutcome(receipt));
    const transaction = new SendTransaction({ owner, recovery, post });
    const input = { ...request, replyTo: 'parent' };
    const pending = transaction.send(input);
    input.channel = 'elsewhere';
    input.body = 'new typing';
    input.replyTo = 'new-parent';
    input.draftRevision = 4;
    expect(post).not.toHaveBeenCalled();
    expect((await transaction.send(request)).kind).toBe('refused');
    release();
    expect((await pending).kind).toBe('confirmed');
    expect(post.mock.calls[0]).toEqual([
      expect.arrayContaining(['chat', 'commons', '--re', 'parent']),
      '🦊 words \r\n',
    ]);
  });
  it('recovery failure and capacity never dispatch or sign', async () => {
    const post = vi.fn();
    const sign = vi.fn();
    const transaction = new SendTransaction({
      owner,
      recovery: {
        record: async () => {
          throw new Error('capacity');
        },
        remove: vi.fn(),
      },
      post,
      sign,
    });
    expect(await transaction.send({ ...request, mode: 'signed' })).toMatchObject({
      kind: 'refused',
      code: 'recovery_failed',
    });
    expect(post).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it('sign failure never falls back casual, removes recovery and keeps draft', async () => {
    const post = vi.fn();
    const remove = vi.fn(async () => {});
    const transaction = new SendTransaction({
      owner,
      recovery: { record: async () => 'saved', remove },
      post,
      sign: async () => {
        throw new Error('agent dark');
      },
    });
    const outcome = await transaction.send({ ...request, mode: 'signed' });
    expect(outcome.kind).toBe('refused');
    expect(post).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('saved');
    expect(shouldClearDraft(outcome, 3, 3)).toBe(false);
  });
  it('failed recovery removal is a sticky notice, never a retry', async () => {
    const post = vi.fn(async (_args: string[], _input?: string) => jsonOutcome(receipt));
    const transaction = new SendTransaction({
      owner,
      recovery: {
        record: async () => 'saved',
        remove: async () => {
          throw new Error('IO');
        },
      },
      post,
    });
    expect((await transaction.send(request)).kind).toBe('confirmed');
    expect(post).toHaveBeenCalledTimes(1);
    expect(transaction.notices.join(' ')).toContain('evidence kept');
  });
  it('signed 32 KiB boundary adds oversize only above it, never anyway; casual stays casual', async () => {
    const post = vi.fn(async (_args: string[], _input?: string) => jsonOutcome(receipt));
    const sign = vi.fn(async () => ({
      signature_ref: { version: 2 as const, tag: 'tag' },
      payload: '',
      signature: '',
      discard: async () => {},
    }));
    const transaction = new SendTransaction({
      owner,
      recovery: { record: async () => 'saved', remove: async () => {} },
      post,
      sign,
    });
    for (const size of [32768, 32769])
      await transaction.send({ ...request, body: 'x'.repeat(size), mode: 'signed' });
    expect(post.mock.calls[0]?.[0]).not.toContain('--oversize');
    expect(post.mock.calls[1]?.[0]).toContain('--oversize');
    for (const call of post.mock.calls) expect(call[0]).not.toContain('--anyway');
    await transaction.send(request);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[2]?.[1]).toBe('🦊 words \r\n');
  });
  it('notes before JSON are tolerated, malformed errors and nonzero successes are uncertain', () => {
    expect(
      classifySend(
        { code: 0, stdout: `post: note\n${JSON.stringify(receipt)}`, stderr: '' },
        'commons',
        'mara',
        'saved',
      ).kind,
    ).toBe('confirmed');
    expect(classifySend(jsonOutcome(receipt, 1), 'commons', 'mara', 'saved').kind).toBe(
      'uncertain',
    );
  });
  it('owner disagreement refuses signing even with an armed signer', async () => {
    const sign = vi.fn();
    const post = vi.fn();
    const transaction = new SendTransaction({
      owner: { ...owner, signingBlocked: 'marker mismatch' },
      recovery: { record: async () => 'saved', remove: async () => {} },
      post,
      sign,
    });
    expect((await transaction.send({ ...request, mode: 'signed' })).kind).toBe('refused');
    expect(sign).not.toHaveBeenCalled();
  });
});
