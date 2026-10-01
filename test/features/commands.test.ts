import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sentWhen } from '../../src/app/derive.ts';
import { Decisions } from '../../src/app/features/decisions.ts';
import { featureRuntime } from '../../src/app/features/index.ts';
import { pollRenderer, voteCommand } from '../../src/app/features/polls.ts';
import { Recovery, recoveryHint, writtenAt } from '../../src/app/features/recovery.ts';
import { type Execute, FeatureRuntime, saveTranscript } from '../../src/app/features/runtime.ts';
import { command } from '../../src/app/registry.ts';
import { Grid } from '../../src/grid/grid.ts';
import { context, record, state, withClient } from './helpers.ts';

describe('feature commands', () => {
  it('clipboard fallback sends only body bytes to fake commands or the OSC 52 sink', async () => {
    const execute = vi.fn<Execute>(async () => {
      throw new Error('missing');
    });
    const sink = vi.fn();
    const rt = new FeatureRuntime({
      platform: 'darwin',
      env: { WAYLAND_DISPLAY: 'fake', DISPLAY: 'fake' },
      execute,
      osc52: sink,
    });
    expect(await rt.copy('words\n')).toBe('terminal clipboard requested');
    expect(execute.mock.calls.map((c) => c[0])).toEqual(['pbcopy', 'wl-copy', 'xclip']);
    expect(sink).toHaveBeenCalledWith('words\n');
    execute.mockResolvedValue(Buffer.alloc(0));
    expect(await rt.copy('second')).toBe('copied');
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it('invalid copy selection never touches the clipboard', async () => {
    const copy = vi.spyOn(featureRuntime, 'copy');
    const ctx = context(state([record()]));
    await command('copy')?.run('0', ctx);
    expect(copy).not.toHaveBeenCalled();
    expect(ctx.status).toHaveBeenCalledWith(expect.stringContaining('positive'));
    copy.mockRestore();
  });
  it('copy strips bracketed-paste termination, C0/C1 and bidi controls but retains newline/tab', async () => {
    const r = record('words\x1b[201~\n\tcommand\x00\x85\u202e\u2066');
    const s = withClient(state([r]), {
      message: vi.fn(async () => ({ ok: true as const, value: r.raw })),
    });
    const sink = vi.spyOn(featureRuntime, 'copy').mockResolvedValue('copied');
    try {
      await command('copy')?.run('', context(s));
      expect(sink).toHaveBeenCalledWith('words[201~\n\tcommand');
    } finally {
      sink.mockRestore();
    }
  });
  it('exports exact raw bodies with private permissions and safe filenames', () => {
    const r = record('raw\r\n').raw;
    const path = saveTranscript([r], '../unsafe/name');
    expect(path).not.toContain('/unsafe/');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(`--- agent   ${r.sent}   ${r.id}\nraw\r\n\n`);
  });
  it('latest participant ballot wins, casual and signed owner votes count, poll frames show voter heads', async () => {
    const poll = record('📊 POLL p1: Ship?\na) Yes\nb) No');
    const owner = record('🦊 🗳️ p1: a', {
      from: 'mara',
      fromParticipant: 'p-mara',
      id: '20260930-230001-000001-abcdef',
    });
    const later = record('🗳️ p1: b', {
      from: 'mara',
      fromParticipant: 'p-mara',
      id: '20260930-230002-000001-abcdef',
      signature: { present: true, raw: { version: 2, tag: 'tag' } },
    });
    const ctx = context(
      state([
        poll,
        owner,
        { ...later, verdict: { state: 'verified', reason: 'test signed owner' } },
      ]),
    );
    await voteCommand.run('p1 a', ctx);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: '🗳️ p1: a', mode: 'casual' }),
    );
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ] as const) {
      const g = new Grid(cols, rows, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
      pollRenderer().draw(g, { x: 0, y: 0, w: cols, h: rows }, poll, ctx.state);
      expect(g.toText()).toContain('b) No (1)');
      expect(g.toText()).toContain('a) Yes (0)');
      expect(g.toText()).toContain('▀');
    }
    vi.mocked(ctx.send).mockClear();
    await voteCommand.run('missing a', ctx);
    await voteCommand.run('p1 z', ctx);
    expect(ctx.send).not.toHaveBeenCalled();
  });
  it.each(['accept', 'reject', 'supersede'])(
    'refuses casual %s before any store write or send',
    async (verb) => {
      const commands = new Decisions().commands();
      const ctx = context();
      await commands.find((c) => c.name === verb)?.run('dr-1', ctx);
      expect(ctx.status).toHaveBeenCalledWith(expect.stringContaining('SIGNED'));
      expect(ctx.send).not.toHaveBeenCalled();
    },
  );
  it('recovery hints need matching owner bytes, channel reply and exactly one candidate', () => {
    const rec = {
      id:
        (BigInt(Date.parse('2026-09-30T23:00:00Z')) * 1000000n).toString().padStart(20, '0') +
        '-test',
      channel: 'commons',
      text: 'hello',
      reply_to: null,
    };
    const s = state();
    const landed = record('🦊 hello', { from: 'mara' }).raw;
    expect(recoveryHint(rec, [{ ...landed, sent: '2026-09-30T22:00:00Z' }], s)).toBe('not found');
    expect(recoveryHint(rec, [landed], s)).toBe(
      `likely landed in #commons at ${sentWhen(landed.sent)}`,
    );
    expect(recoveryHint(rec, [landed], s)).not.toContain(landed.id);
    expect(writtenAt(rec)).toBe(sentWhen('2026-09-30T23:00:00Z'));
    expect(recoveryHint(rec, [landed, { ...landed, id: 'another' }], s)).toBe(
      'ambiguous (2 matches)',
    );
    expect(recoveryHint(rec, [record('hello').raw], s)).toBe('not found');
    expect(recoveryHint({ ...rec, reply_to: 'parent' }, [landed], s)).toBe('not found');
  });
  it('registered emotes go through context.send with a distinct request; no direct post write', async () => {
    const ctx = context();
    await command('emote')?.run('wave', ctx);
    expect(ctx.send).not.toHaveBeenCalled();
    const { defaultAvatar } = await import('@estate/pixel');
    const s = {
      ...ctx.state,
      avatars: new Map([[ctx.state.owner.participant, defaultAvatar('mara')]]),
    };
    const ready = context(s);
    await command('emote')?.run('wave @bolt', ready);
    expect(ready.send).not.toHaveBeenCalled();
    Object.assign(ready.send, { emotes: true });
    await command('emote')?.run('wave @bolt', ready);
    expect(ready.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: '', emote: { name: 'wave', at: 'bolt' }, mode: 'casual' }),
    );
  });
  it('recovery overlay has narrow, readable empty states and consumes keys', () => {
    const recovery = new Recovery();
    const s = state();
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ] as const) {
      const g = new Grid(cols, rows, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
      recovery.overlay().draw(g, { x: 0, y: 0, w: cols, h: rows }, s);
      expect(g.toText()).toContain('Nothing here is sent.');
      expect(g.toText()).toContain('nothing to recover');
    }
    expect(recovery.overlay().key({ name: 'x', ctrl: false, alt: false, shift: false }, s)).toBe(
      'handled',
    );
  });
});
