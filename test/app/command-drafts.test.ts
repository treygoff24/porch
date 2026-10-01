/**
 * A slash command's text and the plug-in seams that touch the draft or the send admission.
 *
 * - A registered command that sends: its text leaves the composer while it runs and comes back
 *   when post refuses the send or the command fails, unless Trey typed something newer meanwhile.
 *   An uncertain send clears it (the send's recovery record holds what went out), as for the
 *   composer.
 * - The emote route: `ctx.send.emotes` is advertised only with an emote path, an emote request
 *   goes to that path (never the send transaction) behind the same one-at-a-time admission.
 * - `actions.appendImagePath`, poll observers and paste handlers.
 */
import type { SendOutcome, SendRequest } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import {
  type EmoteSendRequest,
  registerCommand,
  registerPasteHandler,
  registerPollObserver,
} from '../../src/app/registry.ts';
import { key, makeApp, press, record, settle, summary, type } from './harness.ts';
import { busyWorld } from './worlds.ts';

registerCommand({
  name: 'shout',
  usage: '/shout <words>',
  needsChannel: true,
  run: async (args, ctx) => {
    await ctx.send({
      channel: ctx.state.current ?? '',
      body: args.toUpperCase(),
      mode: 'casual',
      draftRevision: ctx.state.composer.revision,
    });
  },
});

registerCommand({
  name: 'broken',
  usage: '/broken',
  needsChannel: true,
  run: async () => {
    throw new Error('it broke');
  },
});

let emoteSend: ((req: SendRequest) => Promise<SendOutcome>) & { emotes?: true };
registerCommand({
  name: 'wave',
  usage: '/wave',
  needsChannel: true,
  run: async (_args, ctx) => {
    emoteSend = ctx.send;
    const req: EmoteSendRequest = {
      channel: ctx.state.current ?? '',
      body: '/wave',
      mode: 'casual',
      draftRevision: ctx.state.composer.revision,
      emote: { name: 'wave' },
    };
    await ctx.send(req);
  },
});

/** A send that waits until the test lets it answer. */
function gated(answer: SendOutcome) {
  let release: () => void = () => {};
  const outcome = () =>
    new Promise<SendOutcome>((resolve) => {
      release = () => resolve(answer);
    });
  return { outcome, release: () => release() };
}

describe('a sending command’s text', () => {
  it('comes back when post refuses the send', async () => {
    const app = await makeApp(
      busyWorld({
        outcome: () => ({ kind: 'refused', code: 'post_refused', message: 'post said no' }),
      }),
    );
    type(app, '/shout hello there');
    press(app, key('return'));
    await settle();
    expect(app.sends.map((s) => s.body)).toEqual(['HELLO THERE']);
    expect(app.m.composer().text).toBe('/shout hello there');
    expect(app.m.notice?.text).toContain('not sent: post said no');
  });

  it('clears on an uncertain send: the recovery record holds what went out', async () => {
    const app = await makeApp(
      busyWorld({
        outcome: () => ({ kind: 'uncertain', reason: 'post did not answer', recordId: 'rec-1' }),
      }),
    );
    type(app, '/shout hello there');
    press(app, key('return'));
    await settle();
    expect(app.sends.length).toBe(1);
    expect(app.m.composer().text).toBe('');
    expect(app.m.notice?.text).toContain('send uncertain');
  });

  it('clears on a confirmed send', async () => {
    const app = await makeApp(busyWorld());
    type(app, '/shout hello there');
    press(app, key('return'));
    await settle();
    expect(app.sends.length).toBe(1);
    expect(app.m.composer().text).toBe('');
  });

  it('sends with the revision the composer has while the command runs', async () => {
    const app = await makeApp(busyWorld());
    type(app, '/shout hi');
    press(app, key('return'));
    await settle();
    const sent = app.sends[0];
    expect(sent?.draftRevision).toBeGreaterThan(0);
    expect(Number.isInteger(sent?.draftRevision)).toBe(true);
  });

  it('stays gone when Trey typed something newer while a refused send was in flight', async () => {
    const g = gated({ kind: 'refused', code: 'post_refused', message: 'post said no' });
    const app = await makeApp(busyWorld({ outcome: g.outcome }));
    type(app, '/shout hello');
    press(app, key('return'));
    await settle();
    expect(app.m.sending).toBe(true);
    type(app, 'newer words');
    g.release();
    await settle();
    expect(app.m.composer().text).toBe('newer words');
  });

  it('comes back when the command fails', async () => {
    const app = await makeApp(busyWorld());
    type(app, '/broken now');
    press(app, key('return'));
    await settle();
    expect(app.m.composer().text).toBe('/broken now');
    expect(app.m.notice?.text).toContain('/broken failed: it broke');
  });

  it('a command that sends nothing still clears (/help)', async () => {
    const app = await makeApp(busyWorld());
    type(app, '/help');
    press(app, key('return'));
    await settle();
    expect(app.m.composer().text).toBe('');
  });
});

describe('the emote route', () => {
  it('is not advertised without an emote path, and an emote request is refused unsent', async () => {
    const app = await makeApp(busyWorld());
    type(app, '/wave');
    press(app, key('return'));
    await settle();
    expect(emoteSend.emotes).toBeUndefined();
    expect(app.sends).toEqual([]);
    expect(app.m.notice?.text).toContain('emotes cannot be sent from here');
  });

  it('goes to the emote path, never the send transaction, and clears the command', async () => {
    const emotes: { channel: string; name: string; at: string | undefined }[] = [];
    const app = await makeApp(
      busyWorld({
        sendEmote: async (channel, name, at) => {
          emotes.push({ channel, name, at });
          return { kind: 'confirmed', id: 'emote-1' };
        },
      }),
    );
    type(app, '/wave');
    press(app, key('return'));
    await settle();
    expect(emoteSend.emotes).toBe(true);
    expect(emotes).toEqual([{ channel: 'commons', name: 'wave', at: undefined }]);
    expect(app.sends).toEqual([]);
    expect(app.m.composer().text).toBe('');
  });

  it('waits its turn behind a send in flight (the same admission)', async () => {
    const g = gated({ kind: 'confirmed', id: 'x-1' });
    const emotes: string[] = [];
    const app = await makeApp(
      busyWorld({
        outcome: g.outcome,
        sendEmote: async (_c, name) => {
          emotes.push(name);
          return { kind: 'confirmed', id: 'emote-1' };
        },
      }),
    );
    type(app, 'words first');
    press(app, key('return'));
    await settle();
    expect(app.m.sending).toBe(true);
    await app.m.invoke('wave', '');
    expect(emotes).toEqual([]);
    expect(app.m.notice?.text).toContain('already in flight');
    g.release();
    await settle();
  });
});

describe('plug-in seams', () => {
  it('appendImagePath adds to that channel’s draft, keeping its words and the focus', async () => {
    const app = await makeApp(busyWorld());
    type(app, 'look at');
    await app.m.openChannel('ops');
    type(app, 'elsewhere');
    app.m.state().actions.appendImagePath('commons', '/tmp/spool/a.png');
    expect(app.m.current).toBe('ops');
    expect(app.m.composer('ops').text).toBe('elsewhere');
    expect(app.m.composer('commons').text).toBe('look at /tmp/spool/a.png');
    // The actions object is one object for the app's life (features key caches by it).
    expect(app.m.state().actions).toBe(app.m.actions);
  });

  it('runs poll observers after post moves, once at a time, and shows their failures', async () => {
    let calls = 0;
    let finish: () => void = () => {};
    registerPollObserver({
      id: 'decisions',
      observe: () => {
        calls += 1;
        if (calls === 1)
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        throw new Error('decision log unreadable');
      },
    });
    const app = await makeApp({
      channels: [summary('commons')],
      records: { commons: [record({ minutes: 1, body: 'one' })] },
    });
    const before = calls;
    expect(before).toBeGreaterThan(0);
    // Still running: another poll does not start a second call.
    app.source.setRecords('commons', [record({ minutes: 1, body: 'one' })]);
    expect(calls).toBe(before);
    finish();
    await settle();
    app.source.setRecords('commons', [record({ minutes: 1, body: 'one' })]);
    await settle();
    expect(calls).toBe(before + 1);
    expect(app.m.notice?.text).toContain('decisions: decision log unreadable');
  });

  it('offers a paste to the handlers first; false falls through to the composer', async () => {
    const taken: string[] = [];
    registerPasteHandler({
      id: 'images',
      paste: async (text) => {
        if (!text.endsWith('.png')) return false;
        taken.push(text);
        return true;
      },
    });
    const app = await makeApp(busyWorld());
    await app.m.paste('/tmp/a.png');
    expect(taken).toEqual(['/tmp/a.png']);
    expect(app.m.composer().text).toBe('');
    await app.m.paste('plain words');
    expect(app.m.composer().text).toBe('plain words');
  });
});
