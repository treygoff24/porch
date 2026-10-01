/**
 * Quitting under a real terminal, with the real stores: `bin/porch-next` under a pty on the
 * installed post, its drafts in post-kit's `Drafts` and its rescues in post-kit's `SendRecord`, both
 * on the sandbox's one `DraftSpace`, read back here through the same classes.
 *
 * - Save: Ctrl+Q writes the draft, keeps another channel's saved draft, and Porch leaves.
 * - Rescue: another Porch changed the same channel's draft, so the save conflicts; the typing goes
 *   into a recovery record and Porch leaves.
 * - Refuse: the drafts directory cannot be written, so neither save nor rescue works; Porch stays
 *   and says why. Once it can be written again, Ctrl+Q saves and leaves.
 * - A signal takes the same save-then-rescue path.
 */
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DraftSpace, Drafts, SendRecord } from '@estate/post-kit';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanTmps, frameShows, liveWorld, underApp, type World } from './support.ts';

const CTRL_Q = '\x11';

describe('quitting under a terminal, with the real stores', () => {
  let world: World | undefined;
  const dir = () => join(world?.cfg.ownerRoomDir ?? '/nonexistent', '.porch-drafts');
  afterAll(() => {
    if (world !== undefined && existsSync(dir())) chmodSync(dir(), 0o700);
    world?.cleanup();
    cleanTmps();
  });
  beforeEach(async () => {
    world ??= await liveWorld(['commons', 'ops']);
    if (existsSync(dir())) chmodSync(dir(), 0o700);
    rmSync(dir(), { recursive: true, force: true });
    // Another channel's draft from an earlier session, which every quit below must keep.
    const seed = new Drafts(new DraftSpace(world.cfg));
    await seed.load();
    await seed.save(new Map([['ops', 'kept from before']]));
  });

  const space = () => new DraftSpace((world as World).cfg);
  const saved = async () => new Drafts(space()).load();
  const rescued = async () => (await new SendRecord(space()).list('commons')).map((r) => r.text);

  /** Start Porch, decline arming, wait for the screen; then `rest`. */
  const run = (rest: (dump: string) => object[], watch?: (dump: string) => void) =>
    underApp(world as World, (dump) => {
      watch?.(dump);
      return [
        { waitFor: 'Arm signing', ms: 20_000 },
        { send: '\r' },
        frameShows(dump, 'TYPE TO TALK'),
        ...rest(dump),
      ] as never;
    });

  it('saves the draft on Ctrl+Q and leaves', async () => {
    const r = await run(() => [{ send: 'half a thought' }, { wait: 300 }, { send: CTRL_Q }]);
    expect(r.timedOut).toBe(false);
    expect(r.exit).toBe(0);
    const d = await saved();
    expect(d.get('commons')).toBe('half a thought');
    expect(d.get('ops')).toBe('kept from before');
    expect(await rescued()).toEqual([]);
  }, 90_000);

  it('rescues the typing when another Porch changed the same draft, and leaves', async () => {
    // Another Porch writes #commons after this one loaded its drafts and before it saves.
    const other = new Drafts(space());
    await other.load();
    let wrote = false;
    let timer: NodeJS.Timeout | undefined;
    const r = await run(
      (dump) => [
        { waitFile: `${dump}.other`, contains: 'written', ms: 20_000 },
        { send: 'mine, not theirs' },
        { wait: 200 },
        { send: CTRL_Q },
      ],
      (dump) => {
        timer = setInterval(() => {
          if (wrote) return;
          let shown = '';
          try {
            shown = readFileSync(dump, 'utf8');
          } catch {
            return;
          }
          if (!shown.includes('TYPE TO TALK')) return;
          wrote = true;
          void other
            .save(
              new Map([
                ['commons', 'theirs'],
                ['ops', 'kept from before'],
              ]),
            )
            .then(() =>
              import('node:fs').then((fs) => fs.writeFileSync(`${dump}.other`, 'written')),
            );
        }, 50);
      },
    );
    clearInterval(timer);
    expect(wrote).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.exit).toBe(0);
    expect((await saved()).get('commons')).toBe('theirs');
    expect(await rescued()).toContain('mine, not theirs');
  }, 90_000);

  it('refuses to quit when nothing can be written, and says why; then saves once it can', async () => {
    let timer: NodeJS.Timeout | undefined;
    let refused = '';
    const r = await run(
      (dump) => [
        // Only once the watcher below has made the drafts directory unwritable.
        { waitFile: `${dump}.locked`, contains: 'yes', ms: 20_000 },
        { send: 'do not lose me' },
        { wait: 200 },
        { send: CTRL_Q },
        frameShows(dump, 'not quitting'),
        { file: 'refused', path: dump },
        // Writable again (the watcher below), then quit once more.
        { waitFile: `${dump}.fixed`, contains: 'yes', ms: 20_000 },
        { send: CTRL_Q },
      ],
      (dump) => {
        // Unwritable once the screen is up (Porch has loaded its drafts by then).
        let locked = false;
        timer = setInterval(() => {
          let shown = '';
          try {
            shown = readFileSync(dump, 'utf8');
          } catch {
            return;
          }
          if (!locked && shown.includes('TYPE TO TALK')) {
            locked = true;
            chmodSync(dir(), 0o500);
            void import('node:fs').then((fs) => fs.writeFileSync(`${dump}.locked`, 'yes'));
          }
          if (locked && refused === '' && shown.includes('not quitting')) {
            refused = shown;
            chmodSync(dir(), 0o700);
            void import('node:fs').then((fs) => fs.writeFileSync(`${dump}.fixed`, 'yes'));
          }
        }, 50);
      },
    );
    clearInterval(timer);
    expect(r.timedOut).toBe(false);
    // The watcher saw the refusal (its waits do not fail on their own when they time out).
    expect(refused).toContain('not quitting');
    // Porch stayed after the first Ctrl+Q: the refusal was on screen while it ran.
    expect(r.files.refused ?? '').toContain('not quitting: drafts could not be saved or rescued');
    expect(r.exit).toBe(0);
    expect((await saved()).get('commons')).toBe('do not lose me');
  }, 90_000);

  it('a signal takes the same path: a conflicting save is rescued', async () => {
    const other = new Drafts(space());
    await other.load();
    let wrote = false;
    let timer: NodeJS.Timeout | undefined;
    const r = await run(
      (dump) => [
        { waitFile: `${dump}.other`, contains: 'written', ms: 20_000 },
        { send: 'signalled words' },
        { wait: 200 },
        { signal: 'TERM' },
        { wait: 3000 },
      ],
      (dump) => {
        timer = setInterval(() => {
          if (wrote) return;
          let shown = '';
          try {
            shown = readFileSync(dump, 'utf8');
          } catch {
            return;
          }
          if (!shown.includes('TYPE TO TALK')) return;
          wrote = true;
          void other
            .save(
              new Map([
                ['commons', 'theirs'],
                ['ops', 'kept from before'],
              ]),
            )
            .then(() =>
              import('node:fs').then((fs) => fs.writeFileSync(`${dump}.other`, 'written')),
            );
        }, 50);
      },
    );
    clearInterval(timer);
    expect(r.timedOut).toBe(false);
    expect(r.signal).toBeNull();
    expect(r.exit).toBe(0);
    expect(await rescued()).toContain('signalled words');
  }, 90_000);
});
