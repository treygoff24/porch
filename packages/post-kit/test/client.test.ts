import { afterAll, describe, expect, it, vi } from 'vitest';
import { OwnerPost } from '../src/client.ts';
import { parseMessages } from '../src/records.ts';
import { interpret, type RunSpec, runProcess } from '../src/run.ts';
import { jsonOutcome, sandbox } from './helpers.ts';

describe('OwnerPost obligations ported from Loom', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  const binding = {
    ok: true,
    status: 'bound',
    id: 'porch-abcdef',
    participant: { id: 'porch-abcdef', workspace: 'mara', harness: 'porch' },
  };
  const anchor = {
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
  };
  function runner() {
    return vi.fn(async (_exe: string, spec: RunSpec) => {
      if (spec.args[0] === 'owner') return jsonOutcome(anchor);
      if (spec.args[0] === 'participant') return jsonOutcome(binding);
      if (spec.args[0] === 'profile' && spec.args[1] === 'show')
        return jsonOutcome({ ok: true, room: 'mara' });
      if (spec.args[0] === 'channels')
        return jsonOutcome({
          ok: true,
          channels: [
            {
              name: 'commons',
              unread: null,
              members: ['mara'],
              participants: ['porch-abcdef'],
              archived: true,
              future: true,
            },
          ],
        });
      if (spec.args.includes('--message'))
        return jsonOutcome({
          ok: true,
          message: { id: 'id', from: 'mara', channel: 'commons', sent: 'now', signature_ref: null },
          body_slice: 'byte-exact\r\n',
          range: { start: 0, end_exclusive: 12 },
          total_body_bytes: 12,
          body_complete: true,
        });
      if (spec.args.includes('--seen-by'))
        return jsonOutcome({ ok: true, seen_by: ['p-a', 'p-b'] });
      if (spec.args.includes('--history') || spec.args.includes('--since'))
        return jsonOutcome({
          ok: true,
          messages: [
            {
              id: 'id',
              from: 'mara',
              channel: 'commons',
              sent: 'now',
              body: 'raw\r\n',
              signature_ref: null,
              signed_verified: true,
              unknown: { kept: true },
            },
          ],
        });
      if (spec.args[0] === 'watch') return { code: 0, stdout: '', stderr: '' };
      if (spec.args[0] === 'who') return jsonOutcome({ ok: true, participants: [] });
      if (spec.args[0] === 'profile' && spec.args[1] === 'list')
        return jsonOutcome({
          ok: true,
          profiles: [{ participant: 'p-a', name: 'Agent', avatar: { format: 1 } }],
        });
      return jsonOutcome({ ok: true, advanced: true });
    });
  }
  it('connect binds the stable owner key; every call scrubs inherited identity and credential variables', async () => {
    const run = runner();
    const r = await OwnerPost.connect({
      config: s.cfg,
      env: {
        ...s.env,
        POST_PARTICIPANT: 'wrong',
        POST_FROM: 'wrong',
        CODEX_NEW_ID: 'wrong',
        ANTHROPIC_AUTH_TOKEN: 'test-canary',
        HERDR_PANE_ID: 'wrong',
        SSH_AUTH_SOCK: '/wrong',
      },
      run,
    });
    if (!r.ok) throw new Error(r.error.message);
    expect(run.mock.calls[1]?.[1].args).toEqual([
      'participant',
      'bind',
      '--harness',
      'porch',
      '--key',
      'mara',
      '--workspace',
      'mara',
      '--json',
    ]);
    await r.value.channels();
    for (const [, spec] of run.mock.calls) {
      expect(spec.cwd).toBe(s.cfg.ownerRoomDir);
      expect(spec.env.POST_MAIL_ROOT).toBe(s.cfg.mailRoot);
      for (const key of [
        'POST_FROM',
        'CODEX_NEW_ID',
        'ANTHROPIC_AUTH_TOKEN',
        'HERDR_PANE_ID',
        'SSH_AUTH_SOCK',
      ])
        expect(spec.env[key]).toBeUndefined();
    }
    expect(run.mock.calls.at(-1)?.[1].env.POST_PARTICIPANT).toBe('porch-abcdef');
  });
  it('read shapes preserve raw body, malformed locator and unknown fields; no implicit markRead', async () => {
    const run = runner();
    const r = await OwnerPost.connect({ config: s.cfg, env: s.env, run });
    if (!r.ok) throw new Error('connect');
    const history = await r.value.history('commons', 200);
    if (!history.ok) throw new Error('history');
    expect(history.value[0]?.body).toBe('raw\r\n');
    expect(history.value[0]?.signature).toEqual({ present: true, raw: null });
    expect(history.value[0]?.envelope.unknown).toEqual({ kept: true });
    const exact = await r.value.message('commons', 'id');
    if (!exact.ok) throw new Error('message');
    expect(exact.value.bodyComplete).toBe(true);
    expect(exact.value.body).toBe('byte-exact\r\n');
    expect(run.mock.calls.at(-1)?.[1].args).toEqual([
      'chat',
      'commons',
      '--message',
      'id',
      '--max-bytes',
      '1048576',
      '--json',
    ]);
    expect(run.mock.calls.some(([, spec]) => spec.args.includes('--discard-through'))).toBe(false);
  });
  it('rebinds a lost participant once, then reissues the failed read', async () => {
    const base = runner();
    let reads = 0;
    const run = vi.fn(async (exe: string, spec: RunSpec) => {
      if (spec.args[0] === 'channels' && reads++ === 0)
        return jsonOutcome({ ok: false, error: { code: 'participant_missing' } }, 65);
      return base(exe, spec);
    });
    const r = await OwnerPost.connect({ config: s.cfg, env: s.env, run });
    if (!r.ok) throw new Error('connect');
    expect((await r.value.channels()).ok).toBe(true);
    expect(run.mock.calls.filter(([, spec]) => spec.args[0] === 'participant')).toHaveLength(2);
    expect(reads).toBe(2);
  });
  it('owner-room disagreement and pinned foreign store stop before binding', async () => {
    const run = vi.fn(async () =>
      jsonOutcome({ ...anchor, owner: { ...anchor.owner, room: 'other' } }),
    );
    expect((await OwnerPost.connect({ config: s.cfg, env: s.env, run })).ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockClear();
    expect(
      (
        await OwnerPost.connect({
          config: s.cfg,
          env: { ...s.env, POST_MAIL_ROOT: '/different' },
          run,
        })
      ).ok,
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it('new CLI methods use exact verbs; archive comes from channels output', async () => {
    const run = runner();
    const r = await OwnerPost.connect({ config: s.cfg, env: s.env, run });
    if (!r.ok) throw new Error('connect');
    expect(await r.value.seenBy('commons', 'id')).toEqual({ ok: true, value: ['p-a', 'p-b'] });
    const avatars = await r.value.avatars();
    expect(avatars.ok && avatars.value.get('p-a')).toEqual({ format: 1 });
    await r.value.setAvatar({ format: 1 });
    expect(run.mock.calls.at(-1)?.[1].args).toEqual([
      'profile',
      'avatar',
      'set',
      '--file',
      '-',
      '--json',
    ]);
    await r.value.archive('commons');
    expect(run.mock.calls.at(-1)?.[1].args).toEqual(['chat', 'commons', '--archive', '--json']);
    await r.value.unarchive('commons');
    expect(run.mock.calls.at(-1)?.[1].args).toEqual(['chat', 'commons', '--unarchive', '--json']);
    const listing = await r.value.channels();
    expect(listing.ok && listing.value[0]?.archived).toBe(true);
  });
  it('T2 emote receipt without from confirms; malformed receipts remain uncertain without recovery wording', async () => {
    const base = runner();
    let message: Record<string, unknown> = {
      id: 'emote-id',
      channel: 'commons',
      sent: 'now',
      event: 'emote',
      emote: { name: 'wave' },
    };
    const run = async (exe: string, spec: RunSpec) =>
      spec.args.includes('--emote') ? jsonOutcome({ ok: true, message }) : base(exe, spec);
    const r = await OwnerPost.connect({ config: s.cfg, env: s.env, run });
    if (!r.ok) throw new Error('connect');
    expect(await r.value.emote('commons', 'wave')).toMatchObject({
      kind: 'confirmed',
      id: 'emote-id',
    });
    const receipt = { ...message };
    for (const mutation of [
      { from: 'foreign' },
      { event: 'join' },
      { channel: 'elsewhere' },
      { id: '' },
    ]) {
      message = { ...receipt, ...mutation };
      const result = await r.value.emote('commons', 'wave');
      expect(result.kind).toBe('uncertain');
      if (result.kind === 'uncertain') {
        expect(result.reason).toContain('emote');
        expect(result.reason).not.toContain('recovery');
      }
    }
  });
  it('slice completion requires offset zero and the entire raw byte range', () => {
    const base = {
      ok: true,
      message: { id: 'id', from: 'mara', channel: 'commons', sent: 'now', signature_ref: null },
      body_slice: 'part',
      total_body_bytes: 10,
      body_complete: false,
    };
    expect(
      parseMessages({ ...base, range: { start: 0, end_exclusive: 4 } }, 'commons')?.[0]
        ?.bodyComplete,
    ).toBe(false);
    expect(
      parseMessages(
        { ...base, body_complete: true, range: { start: 6, end_exclusive: 10 } },
        'commons',
      )?.[0]?.bodyComplete,
    ).toBe(false);
  });
});

describe('bounded process runner', () => {
  it('missing program and read aborts are explicit environment failures', async () => {
    expect(
      (await runProcess('/nonexistent-porch-test-bin', { args: [], env: {}, timeoutMs: 1000 }))
        .failed,
    ).toBe('missing');
    const signal = AbortSignal.abort();
    expect(
      (await runProcess(process.execPath, { args: [], env: {}, timeoutMs: 1000, signal })).failed,
    ).toBe('aborted');
  });
  it('timeout kills only the process group it created; overflow does not become valid output', async () => {
    const timed = await runProcess(process.execPath, {
      args: ['-e', 'setInterval(()=>{},100)'],
      env: {},
      timeoutMs: 50,
      killGraceMs: 30,
    });
    expect(timed.failed).toBe('timeout');
    const overflow = await runProcess(process.execPath, {
      args: ['-e', 'process.stdout.write("x".repeat(10000))'],
      env: {},
      timeoutMs: 1000,
      maxBytes: 100,
      killGraceMs: 30,
    });
    expect(overflow.failed).toBe('overflow');
  });
  it('post explicit refusals retain their error and undecodable output is bad_output', () => {
    expect(
      interpret(
        jsonOutcome(
          { ok: false, error: { code: 'refused', message: 'refused', retryable: false } },
          65,
        ),
        'test',
      ),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(interpret({ code: 0, stdout: 'bad', stderr: '' }, 'test')).toMatchObject({
      ok: false,
      error: { code: 'bad_output' },
    });
  });
});
