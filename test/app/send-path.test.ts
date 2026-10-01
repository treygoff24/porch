/**
 * Every sending path goes through the send transaction (T6 ruling). Two halves:
 *
 * - The source: `post chat --send` is spelled in exactly one file, post-kit's transaction, and no
 *   app or host code can start a process at all (post-kit's client is its only way to post), and
 *   boot hands the model the transaction as its one `send`.
 * - The model: the composer, a slash command's `ctx.send` and pick-mode commands all arrive at that
 *   one `send`, one request per send.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerCommand } from '../../src/app/registry.ts';
import { key, makeApp, press, settle, type } from './harness.ts';
import { busyWorld } from './worlds.ts';

const root = join(import.meta.dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|mts|js|mjs)$/.test(e.name))
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort();
}

const shipped = () => [
  ...sources(join(root, 'src')),
  ...readdirSync(join(root, 'packages')).flatMap((p) => sources(join(root, 'packages', p, 'src'))),
];

describe('the source has one sending path', () => {
  it('spells `--send` only in post-kit’s send transaction', () => {
    const files = shipped();
    expect(files.length).toBeGreaterThan(50);
    const spelling = files.filter((f) => /--send\b/.test(readFileSync(join(root, f), 'utf8')));
    expect(spelling).toEqual(['packages/post-kit/src/send.ts']);
  });

  it('starts no process from the app, the host or the stage (post-kit runs post)', () => {
    const files = sources(join(root, 'src'));
    expect(files.some((f) => f.startsWith('src/app/'))).toBe(true);
    const spawning = files.filter((f) =>
      /child_process|\brunProcess\b|\bspawn\(|\bexecFile\b|\bexecSync\b/.test(
        readFileSync(join(root, f), 'utf8'),
      ),
    );
    // Clipboard and image tools run from one allowlisted runner; post only through post-kit.
    expect(spawning).toEqual(['src/app/features/runtime.ts']);
  });

  it('runs only clipboard and image tools outside post-kit, never post', async () => {
    const { execute } = await import('../../src/app/features/runtime.ts');
    for (const file of ['post', '/usr/local/bin/post', 'sh', 'env'])
      await expect(execute(file, ['chat'])).rejects.toThrow('not a tool Porch runs');
  });

  it('boot hands the model the transaction as its only word send, and post’s emote path', () => {
    const boot = readFileSync(join(root, 'src/app/boot.ts'), 'utf8');
    const sends = [...boot.matchAll(/\bsend: ([^\n]+)/g)].map((m) => m[1]);
    expect(sends).toEqual(['(req) => client.transaction.send(req),']);
    // Emotes are not words: post's own `--emote` path, unsigned, no recovery, never wakes agents.
    const emotes = [...boot.matchAll(/\bsendEmote: ([^\n]+)/g)].map((m) => m[1]);
    expect(emotes).toEqual(['(channel, name, at) => client.emote(channel, name, at),']);
  });
});

describe('the model has one sending path', () => {
  it('the composer, a command’s ctx.send and pick mode all reach the one send', async () => {
    registerCommand({
      name: 'testsend',
      usage: '/testsend <words>',
      needsChannel: true,
      run: async (args, ctx) => {
        await ctx.send({
          channel: ctx.state.current ?? '',
          body: args,
          mode: 'casual',
          draftRevision: ctx.state.composer.revision,
        });
      },
    });
    const app = await makeApp(busyWorld());
    type(app, 'from the composer');
    press(app, key('return'));
    await settle();
    type(app, '/testsend from a command');
    press(app, key('return'));
    await settle();
    await app.m.invoke('testsend', 'from pick mode');
    await settle();
    expect(app.sends.map((s) => s.body)).toEqual([
      'from the composer',
      'from a command',
      'from pick mode',
    ]);
  });

  it('refuses a second send while one is in flight, and keeps the draft', async () => {
    let release: () => void = () => {};
    const app = await makeApp(
      busyWorld({
        outcome: () =>
          new Promise((resolve) => {
            release = () => resolve({ kind: 'confirmed', id: 'x-1' });
          }),
      }),
    );
    type(app, 'first');
    press(app, key('return'));
    await settle();
    type(app, ' second');
    press(app, key('return'));
    await settle();
    expect(app.sends.map((s) => s.body)).toEqual(['first']);
    expect(app.m.notice?.text).toContain('already in flight');
    release();
    await settle();
  });
});
