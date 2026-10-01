/**
 * A registered command's send through post-kit's real send transaction, on the installed post in a
 * sandbox: the request carries the composer's real revision (the transaction rejects anything else),
 * post stores the message, and the command's text leaves the composer. A refused one keeps it. The
 * emote route goes to post's own emote path and stores an emote, not a chat message.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SendOutcome, SendRequest } from '@estate/post-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { registerCommand } from '../../src/app/registry.ts';
import { key, makeApp, press, settle, summary, type } from './harness.ts';
import { liveWorld, type World } from './support.ts';

const root = join(import.meta.dirname, '..', '..');

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
  name: 'shoutto',
  usage: '/shoutto <channel> <words>',
  needsChannel: true,
  run: async (args, ctx) => {
    const [channel = '', ...words] = args.split(' ');
    await ctx.send({
      channel,
      body: words.join(' ').toUpperCase(),
      mode: 'casual',
      draftRevision: ctx.state.composer.revision,
    });
  },
});

registerCommand({
  name: 'wave',
  usage: '/wave',
  needsChannel: true,
  run: async (_args, ctx) => {
    await ctx.send({
      channel: ctx.state.current ?? '',
      body: '/wave',
      mode: 'casual',
      draftRevision: ctx.state.composer.revision,
      emote: { name: 'wave' },
    } as Parameters<typeof ctx.send>[0]);
  },
});

describe('a command’s send on the installed post', () => {
  let world: World | undefined;
  afterAll(() => world?.cleanup());

  async function liveApp() {
    world ??= await liveWorld(['commons']);
    const w = world;
    return makeApp({
      channels: [summary('commons', { unread: 0 })],
      records: { commons: [] },
      send: (req) => w.owner.transaction.send(req),
      sendEmote: (channel, name, at) => w.owner.emote(channel, name, at),
    });
  }

  it('goes through the transaction with a real revision; post stores it; the text clears', async () => {
    const app = await liveApp();
    const w = world as World;
    type(app, '/shout live from a command');
    press(app, key('return'));
    for (let i = 0; i < 40 && app.m.sending; i++) await new Promise((r) => setTimeout(r, 100));
    await settle();
    expect(app.m.notice?.text).toBe('sent');
    const history = await w.history('commons');
    // The transaction puts Trey's marker in front; the words are the command's.
    const sent = history.filter(
      (r) => r.from === w.cfg.ownerRoom && r.body.endsWith('LIVE FROM A COMMAND'),
    );
    expect(sent.length).toBe(1);
    expect(app.m.composer().text).toBe('');
  }, 60_000);

  it('a send post refuses keeps the command’s text', async () => {
    const app = await liveApp();
    const w = world as World;
    const before = (await w.history('commons')).length;
    // A channel Trey has not joined: post refuses, nothing is stored.
    type(app, '/shoutto nowhere-joined words');
    press(app, key('return'));
    for (let i = 0; i < 40 && app.m.sending; i++) await new Promise((r) => setTimeout(r, 100));
    await settle();
    expect(app.m.notice?.text).toMatch(/^not sent: /);
    expect(app.m.composer().text).toBe('/shoutto nowhere-joined words');
    expect((await w.history('commons')).length).toBe(before);
  }, 60_000);

  it('an emote goes to post’s emote path and is stored as an emote', async () => {
    world ??= await liveWorld(['commons']);
    const w = world;
    // Post plays emotes only for a participant with a stored avatar.
    const pack: unknown = JSON.parse(
      readFileSync(join(root, 'contract/avatars/valid/trey.json'), 'utf8'),
    );
    expect((await w.owner.setAvatar(pack)).ok).toBe(true);
    const outcomes: SendOutcome[] = [];
    const transaction: SendRequest[] = [];
    const app = await makeApp({
      channels: [summary('commons', { unread: 0 })],
      records: { commons: [] },
      send: (req) => {
        transaction.push(req);
        return w.owner.transaction.send(req);
      },
      sendEmote: async (channel, name, at) => {
        const o = await w.owner.emote(channel, name, at);
        outcomes.push(o);
        return o;
      },
    });
    type(app, '/wave');
    press(app, key('return'));
    for (let i = 0; i < 40 && outcomes.length === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    await settle();
    const o = outcomes[0];
    if (o?.kind !== 'confirmed') throw new Error(JSON.stringify(o));
    expect(transaction).toEqual([]);
    const stored = await w.owner.message('commons', o.id);
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.value.file).toBe('emote');
    expect(stored.value.signature.present).toBe(false);
    expect(app.m.composer().text).toBe('');
  }, 60_000);
});
