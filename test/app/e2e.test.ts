/**
 * End to end against the installed post: the real `bin/porch-next` under a pty, armed with the
 * throwaway test key, on a sandboxed mail root with an agent room bound as Bolt. Porch receives
 * (a message from before it started and one that arrives while it runs), sends casual, marks read
 * with Ctrl+U, sends signed, and replies; then post's own history and unread count, read without
 * Porch, and post-kit's verifier say what actually happened.
 */
import { readFileSync } from 'node:fs';
import { verify } from '@estate/post-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanTmps, frameShows, liveWorld, underApp, type World } from './support.ts';

const CTRL_S = '\x13';
const CTRL_U = '\x15';
const CTRL_Q = '\x11';
const CTRL_UP = '\x1b[1;5A';

/** Type `text`, then Enter as its own keystroke (a single write would read as a paste). */
const typed = (text: string) => [{ send: text }, { wait: 250 }, { send: '\r' }];

describe('Porch on the installed post', () => {
  let world: World | undefined;
  afterAll(() => {
    world?.cleanup();
    cleanTmps();
  });

  it('receives, sends casual, marks read, sends signed and verified, and replies', async () => {
    world = await liveWorld(['commons']);
    const w = world;
    await w.say('commons', 'before you opened Porch');
    // Precondition: post counts something unread for Trey.
    expect(await w.unread('commons')).toBeGreaterThan(0);

    // Bolt speaks again once Porch is up; the script waits for it to arrive on screen.
    let dumpPath = '';
    let spoke = false;
    const watcher = setInterval(() => {
      if (spoke || dumpPath === '') return;
      let shown = '';
      try {
        shown = readFileSync(dumpPath, 'utf8');
      } catch {
        return;
      }
      if (shown.includes('before you opened Porch') && shown.includes('⚿ ARMED')) {
        spoke = true;
        void w.say('commons', 'while you were watching');
      }
    }, 100);

    const run = await underApp(w, (dump) => {
      dumpPath = dump;
      return [
        { waitFor: 'Arm signing', ms: 20_000 },
        { send: 'y\r' },
        { waitFor: 'Passphrase', ms: 20_000 },
        { send: '\r' },
        frameShows(dump, 'while you were watching'),
        { file: 'received', path: dump },
        ...typed('casual hello'),
        frameShows(dump, '✓ sent'),
        { send: CTRL_U },
        frameShows(dump, 'marked read'),
        { send: CTRL_S },
        frameShows(dump, 'SIGNED ●'),
        ...typed('signed hello'),
        frameShows(dump, '✓ SIGNED'),
        { file: 'signed', path: dump },
        { send: CTRL_UP },
        { wait: 200 },
        { send: 'r' },
        frameShows(dump, 'replying to'),
        ...typed('a reply'),
        frameShows(dump, '↳ re '),
        { file: 'replied', path: dump },
        { send: CTRL_Q },
        { wait: 3000 },
      ];
    });
    clearInterval(watcher);

    expect(run.timedOut).toBe(false);
    expect(run.exit).toBe(0);
    expect(run.files.received ?? '').toContain('before you opened Porch');
    expect(run.files.received ?? '').toContain('while you were watching');
    expect(run.files.signed ?? '').toContain('✓ SIGNED');
    expect(run.files.replied ?? '').toContain('↳ re ');

    // What post holds, read without Porch.
    const history = await w.history('commons');
    const mine = history.filter((r) => r.from === 'mara');
    // A casual send carries Trey's marker; a signed one is authenticated by its signature instead.
    const casual = mine.find((r) => r.body.trim() === `${w.cfg.marker} casual hello`);
    const signed = mine.find((r) => r.body.trim() === 'signed hello');
    const reply = mine.find((r) => r.body.trim() === 'a reply');
    if (casual === undefined || signed === undefined || reply === undefined)
      throw new Error(`missing sends in ${JSON.stringify(mine.map((r) => r.body))}`);
    expect(casual.signature.present).toBe(false);
    expect(signed.signature.present).toBe(true);
    expect((await verify(signed, w.owner.owner, { env: w.env })).state).toBe('verified');
    // The reply names the message Ctrl+↑ picked: the newest one, Trey's signed send.
    expect(reply.re).toBe(signed.id);
    expect(reply.signature.present).toBe(true);
    // Ctrl+U advanced post's read marker through Bolt's messages.
    expect(await w.unread('commons')).toBe(0);
  }, 150_000);
});
