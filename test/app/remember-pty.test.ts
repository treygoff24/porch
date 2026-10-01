/**
 * Remembering the layout and the last channel across two real runs: `bin/porch-next` under a pty on
 * the installed post, both runs sharing one state directory (as one account's runs do). The first
 * run switches to #ops and to the single layout and quits; the second, started with no channel,
 * opens #ops in the single layout, and an explicit channel still wins.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAYOUT_FILE } from '../../src/app/remember.ts';
import { markAttractSeen } from '../../src/app/stage/attract.ts';
import { snapshot } from '../setup/pty.ts';
import { cleanTmps, frameShows, liveWorld, underApp, type World } from './support.ts';

const CTRL_Q = '\x11';
const F2 = '\x1bOQ';
const ALT_2 = '\x1b2';

describe('the layout and last channel survive a restart, under a terminal', () => {
  let world: World | undefined;
  let state = '';
  beforeAll(async () => {
    world = await liveWorld(['commons', 'ops']);
    state = join(world.root, 'remember-state');
    mkdirSync(state, { recursive: true, mode: 0o700 });
    markAttractSeen(state);
  }, 60_000);
  afterAll(() => {
    world?.cleanup();
    cleanTmps();
  });

  const wide = { cols: 160, rows: 44, env: () => ({ PORCH_STATE_DIR: state }) };
  const run = (steps: (dump: string) => object[], args: string[] = []) =>
    underApp(
      world as World,
      (dump) =>
        [
          { waitFor: 'Arm signing', ms: 20_000 },
          { send: '\r' },
          frameShows(dump, 'TYPE TO TALK'),
          ...steps(dump),
        ] as never,
      { cols: wide.cols, rows: wide.rows, env: wide.env(), args },
    );

  it('writes the layout at exit, and the next run opens it', async () => {
    const first = await run((dump) => [
      frameShows(dump, '◫ split · F2'),
      { send: ALT_2 },
      frameShows(dump, '▶ #ops'),
      { send: F2 },
      frameShows(dump, '▣ single · F2'),
      snapshot(dump, 'first'),
      { send: CTRL_Q },
    ]);
    expect(first.timedOut).toBe(false);
    expect(first.exit).toBe(0);
    const saved = JSON.parse(readFileSync(join(state, LAYOUT_FILE), 'utf8'));
    expect(saved).toMatchObject({ version: 1, split: false, focused: 0 });
    expect(saved.panes[0]).toBe('ops');

    // (A wait that times out does not fail the run, so each screen is read back and checked.)
    expect(first.files.first).toContain('▣ single · F2');
    const second = await run((dump) => [
      frameShows(dump, '▣ single · F2'),
      snapshot(dump, 'screen'),
      { send: CTRL_Q },
    ]);
    expect(second.exit).toBe(0);
    expect(second.files.screen).toContain('▣ single · F2');
    expect(second.files.screen).toContain('▶ #ops');

    // An explicit channel wins over the remembered one.
    const third = await run(
      (dump) => [frameShows(dump, '▶ #commons'), snapshot(dump, 'screen'), { send: CTRL_Q }],
      ['commons'],
    );
    expect(third.files.screen).toContain('▶ #commons');
    expect(third.files.screen).toContain('▣ single · F2');
  }, 180_000);
});
