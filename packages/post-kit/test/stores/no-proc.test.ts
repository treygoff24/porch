/**
 * Without `/proc/self/fd` (macOS today) the stores cannot write through a held directory, so they
 * refuse every write and keep reading (coordinator ruling, 2026-09-30). The no-/proc case is real:
 * the stores run in a child process inside a user and mount namespace whose `/proc` is an empty
 * tmpfs. The same script run with `/proc` in place writes, so the refusal is down to `/proc` alone.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { propose } from '../../src/stores/decision-records.ts';
import { DraftSpace, Drafts } from '../../src/stores/drafts.ts';
import { cleanTemps, tempDir } from './pyharness.ts';

afterAll(cleanTemps);

const hideProc = spawnSync('unshare', [
  '-rm',
  'sh',
  '-c',
  'mount -t tmpfs none /proc && test ! -e /proc/self/fd',
]);
const canHideProc = hideProc.status === 0;

const SCRIPT = `const [src, room, mail] = process.argv.slice(2);
const stores = await import(src + '/stores/index.ts');
const { WRITES_UNAVAILABLE } = await import(src + '/stores/dirfd.ts');
const out = { writesUnavailable: WRITES_UNAVAILABLE };
const attempt = async (fn) => {
  try {
    await fn();
    return 'written';
  } catch (err) {
    return err.name + ': ' + err.message;
  }
};
const drafts = stores.Drafts.for({ ownerRoom: 'mara', ownerRoomDir: room, mailRoot: mail });
out.readOnlyReason = drafts.readOnlyReason;
out.loaded = [...(await drafts.load())];
out.save = await attempt(() => drafts.save({ a: 'changed', b: 'new' }));
const fresh = stores.Drafts.for({ ownerRoom: 'fresh', ownerRoomDir: room, mailRoot: mail });
out.freshLoaded = [...(await fresh.load())];
const log = room + '/decision-records.jsonl';
out.replayed = stores.replay(log).map((ev) => ev.get('dr'));
out.propose = await attempt(() =>
  stores.propose({ title: 't', project: 'p', channel: 'c', anchorMessageId: 'm' }, log),
);
console.log(JSON.stringify(out));
`;

let room: string;
let mail: string;
let script: string;
beforeEach(() => {
  const home = tempDir('porch-t3b-noproc-');
  room = join(home, 'room');
  mail = join(home, 'mail');
  spawnSync('mkdir', ['-p', room, mail]);
  script = join(home, 'stores.mts');
  writeFileSync(script, SCRIPT);
});

const src = resolve(import.meta.dirname, '../../src');
type Out = {
  writesUnavailable: string | null;
  readOnlyReason: string | null;
  loaded: [string, string][];
  save: string;
  freshLoaded: [string, string][];
  replayed: string[];
  propose: string;
};
function run(withoutProc: boolean): Out {
  const args = [script, src, room, mail];
  const child = withoutProc
    ? spawnSync(
        'unshare',
        ['-rm', 'sh', '-c', 'mount -t tmpfs none /proc && exec node "$@"', 'sh', ...args],
        { encoding: 'utf8' },
      )
    : spawnSync('node', args, { encoding: 'utf8' });
  const last = child.stdout.trim().split('\n').at(-1) ?? '';
  if (child.status !== 0 || last === '') throw new Error(`child failed:\n${child.stderr}`);
  return JSON.parse(last) as Out;
}

describe.skipIf(!canHideProc)('without /proc/self/fd', () => {
  it('drafts and decision records refuse every write, and still read', async () => {
    const identity = { ownerRoom: 'mara', ownerRoomDir: room, mailRoot: mail };
    await Drafts.for(identity).save({ a: 'saved earlier' });
    await propose(
      { title: 't', project: 'p', channel: 'c', anchorMessageId: 'm' },
      join(room, 'decision-records.jsonl'),
    );
    const space = new DraftSpace(identity);
    const draftsBefore = readFileSync(space.path);
    const listing = readdirSync(space.directory).sort();
    const logPath = join(room, 'decision-records.jsonl');
    const logBefore = readFileSync(logPath);

    const out = run(true);
    expect(out.writesUnavailable).toMatch(/no \/proc\/self\/fd/);
    expect(out.readOnlyReason).toBe(out.writesUnavailable);
    expect(out.loaded).toEqual([['a', 'saved earlier']]);
    expect(out.save).toMatch(/^DraftsReadOnlyError: drafts are read-only: .*no \/proc\/self\/fd/);
    expect(out.freshLoaded).toEqual([]);
    expect(out.replayed).toEqual(['dr-1']);
    expect(out.propose).toMatch(
      /^DecisionLogError: the decision log is read-only: .*\/proc\/self\/fd/,
    );

    // Nothing changed on disk: no draft write, no temp file, no new namespace, no log line.
    expect(readFileSync(space.path).equals(draftsBefore)).toBe(true);
    expect(readdirSync(space.directory).sort()).toEqual(listing);
    expect(readFileSync(logPath).equals(logBefore)).toBe(true);

    // The same script with /proc in place writes both, so the refusal above is down to /proc.
    const control = run(false);
    expect(control.writesUnavailable).toBeNull();
    expect(control.save).toBe('written');
    expect(control.propose).toBe('written');
    expect(statSync(space.path).size).toBeGreaterThan(draftsBefore.length);
  });
});
