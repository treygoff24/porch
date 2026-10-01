/**
 * Sending in a channel Trey has not joined (Trey's live test, 2026-10-01): post refuses a send from
 * a participant that is not a member, so the app joins first, once, and a failed attempt shows one
 * banner. Post's listing marks a non-member with a null unread count (`lobby` in busyWorld).
 */
import type { Result, SendOutcome } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import { type EmoteSendRequest, registerCommand } from '../../src/app/registry.ts';
import { frame, key, lines, makeApp, press, settle, summary, type } from './harness.ts';
import { busyWorld } from './worlds.ts';

registerCommand({
  name: 'jwave',
  usage: '/jwave',
  needsChannel: true,
  run: async (_args, ctx) => {
    const req: EmoteSendRequest = {
      channel: ctx.state.current ?? '',
      body: '/jwave',
      mode: 'casual',
      draftRevision: ctx.state.composer.revision,
      emote: { name: 'wave' },
    };
    await ctx.send(req);
  },
});

/** The app with Trey in #lobby, which post lists with a null unread count (not a member). */
async function inLobby(opts: ReturnType<typeof world>) {
  const app = await makeApp(opts);
  await app.m.openChannel('lobby');
  await settle();
  expect(app.m.current).toBe('lobby');
  return app;
}

const joined: Result<void> = { ok: true, value: undefined };
const refusedJoin: Result<void> = {
  ok: false,
  error: { code: 'not_a_member', message: 'post said no', retryable: false },
};

function world(calls: string[], join: () => Promise<Result<void>>) {
  return busyWorld({
    join: async (channel) => {
      calls.push(`join ${channel}`);
      return join();
    },
    outcome: (req): SendOutcome => {
      calls.push(`send ${req.channel}`);
      return { kind: 'confirmed', id: 'x-1' };
    },
    sendEmote: async (channel) => {
      calls.push(`emote ${channel}`);
      return { kind: 'confirmed', id: 'e-1' };
    },
  });
}

describe('sending where Trey has not joined', () => {
  it('joins, then sends', async () => {
    const calls: string[] = [];
    const app = await inLobby(world(calls, async () => joined));
    type(app, 'hello lobby');
    press(app, key('return'));
    await settle();
    expect(calls).toEqual(['join lobby', 'send lobby']);
    expect(app.m.notice?.text).toBe('sent');
  });

  it('joins, then sends an emote', async () => {
    const calls: string[] = [];
    const app = await inLobby(world(calls, async () => joined));
    type(app, '/jwave');
    press(app, key('return'));
    await settle();
    expect(calls).toEqual(['join lobby', 'emote lobby']);
  });

  it('does not join a channel Trey is already in', async () => {
    const calls: string[] = [];
    const app = await makeApp(world(calls, async () => joined));
    type(app, 'hi');
    press(app, key('return'));
    await settle();
    expect(calls).toEqual(['send commons']);
  });

  it('does not join a channel post does not list (joining would create it)', async () => {
    const calls: string[] = [];
    const app = await makeApp({
      ...world(calls, async () => joined),
      channels: [summary('commons')],
      launch: 'commons',
    });
    await app.m.sendRequest({ channel: 'typo', body: 'x', mode: 'casual', draftRevision: 0 });
    expect(calls).toEqual(['send typo']);
  });

  it('a failed join sends nothing, keeps the draft and says so once on screen', async () => {
    const calls: string[] = [];
    const app = await inLobby(world(calls, async () => refusedJoin));
    type(app, 'hello lobby');
    press(app, key('return'));
    await settle();
    expect(calls).toEqual(['join lobby']);
    expect(app.m.notice?.text).toBe('not sent: could not join #lobby: post said no');
    expect(app.m.composer().text).toBe('hello lobby');
    const shown = lines(frame(app, 120, 40)).join('\n');
    expect(shown.split('post said no')).toHaveLength(2);
  });

  it('a failed send that is also the channel’s read error shows once', async () => {
    const calls: string[] = [];
    const app = await inLobby(world(calls, async () => refusedJoin));
    const msg = 'could not join #lobby: post said no';
    const view = app.source.state.views.lobby;
    app.source.state = {
      ...app.source.state,
      views: {
        ...app.source.state.views,
        lobby: { ...(view ?? { records: [], verdicts: {} }), error: msg },
      },
    };
    app.m.status(`not sent: ${msg}`, 'warning', true);
    const shown = lines(frame(app, 140, 40)).join('\n');
    expect(shown.split(msg)).toHaveLength(2);
  });

  it('says the channel is not joined in the status line, in words', async () => {
    const app = await inLobby(world([], async () => joined));
    expect(lines(frame(app, 120, 40)).join('\n')).toContain('not joined');
    const member = await makeApp(world([], async () => joined));
    expect(lines(frame(member, 120, 40)).join('\n')).not.toContain('not joined');
  });
});
