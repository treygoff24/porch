/**
 * Recovery records follow the drafts store's ruling: without `/proc/self/fd` (macOS today) nothing
 * may be written through a held directory, so recording and removing are refused while listing and
 * restoring still work (coordinator ruling, 2026-09-30). As in the stores' no-/proc test, the store
 * runs in a child process inside a user and mount namespace whose `/proc` is an empty tmpfs, and the
 * same script run with `/proc` in place writes, so the refusal is down to `/proc` alone.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SendRecord } from '../src/recovery.ts';

const canHideProc =
  spawnSync('unshare', ['-rm', 'sh', '-c', 'mount -t tmpfs none /proc && test ! -e /proc/self/fd'])
    .status === 0;

const ID = '00000000000000000001-0123456789abcdef0123456789abcdef';

const SCRIPT = `const [src, room, fresh, mail, id] = process.argv.slice(2);
const { SendRecord } = await import(src + '/recovery.ts');
const { WRITES_UNAVAILABLE } = await import(src + '/stores/dirfd.ts');
const attempt = async (fn) => {
  try {
    await fn();
    return 'written';
  } catch (err) {
    return err.name + ': ' + err.message;
  }
};
const store = new SendRecord({ ownerRoom: 'mara', ownerRoomDir: room, mailRoot: mail });
const out = { writesUnavailable: WRITES_UNAVAILABLE, readOnlyReason: store.readOnlyReason };
out.listed = (await store.list()).map((r) => [r.id, r.channel, r.text]);
out.restored = (await store.restore(id)).text;
out.record = await attempt(() => store.record('commons', 'new words'));
out.remove = await attempt(() => store.remove(id));
const other = new SendRecord({ ownerRoom: 'mara', ownerRoomDir: fresh, mailRoot: mail });
out.freshListed = await other.list();
console.log(JSON.stringify(out));
`;

type Out = {
  writesUnavailable: string | null;
  readOnlyReason: string | null;
  listed: [string, string, string][];
  restored: string;
  record: string;
  remove: string;
  freshListed: unknown[];
};

let home: string;
let room: string;
let fresh: string;
let mail: string;
let script: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'porch-kit-recovery-noproc-'));
  room = join(home, 'room');
  fresh = join(home, 'fresh');
  mail = join(home, 'mail');
  for (const dir of [room, fresh, mail]) mkdirSync(dir, { mode: 0o700 });
  script = join(home, 'recovery.mts');
  writeFileSync(script, SCRIPT);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const pkg = resolve(import.meta.dirname, '..');
const src = join(pkg, 'src');
function run(withoutProc: boolean): Out {
  // tsx, as the package's other child processes use: Node's own type stripping refuses the
  // parameter properties in the modules recovery imports.
  const args = ['--import', 'tsx/esm', script, src, room, fresh, mail, ID];
  const options = { encoding: 'utf8' as const, cwd: pkg };
  const child = withoutProc
    ? spawnSync(
        'unshare',
        [
          '-rm',
          'sh',
          '-c',
          'mount -t tmpfs none /proc && exec "$@"',
          'sh',
          process.execPath,
          ...args,
        ],
        options,
      )
    : spawnSync(process.execPath, args, options);
  const last = child.stdout.trim().split('\n').at(-1) ?? '';
  if (child.status !== 0 || last === '') throw new Error(`child failed:\n${child.stderr}`);
  return JSON.parse(last) as Out;
}

describe.skipIf(!canHideProc)('send recovery without /proc/self/fd', () => {
  it('refuses to record or remove, and still lists and restores', async () => {
    const identity = { ownerRoom: 'mara', ownerRoomDir: room, mailRoot: mail };
    const store = new SendRecord(identity, () => ID);
    await store.record('commons', 'kept words');
    const listing = readdirSync(store.directory).sort();
    expect(listing).toContain(`${store.namespace}.recovery.${ID}.json`);

    const out = run(true);
    expect(out.writesUnavailable).toMatch(/no \/proc\/self\/fd/);
    expect(out.readOnlyReason).toBe(out.writesUnavailable);
    expect(out.listed).toEqual([[ID, 'commons', 'kept words']]);
    expect(out.restored).toBe('kept words');
    expect(out.record).toMatch(/^DraftsReadOnlyError: drafts are read-only: .*no \/proc\/self\/fd/);
    expect(out.remove).toMatch(/^DraftsReadOnlyError: drafts are read-only: .*no \/proc\/self\/fd/);
    expect(out.freshListed).toEqual([]);

    // Nothing changed on disk: no record, no staging file, no drafts directory where none was.
    expect(readdirSync(store.directory).sort()).toEqual(listing);
    expect(existsSync(join(fresh, '.porch-drafts'))).toBe(false);

    // The same script with /proc in place records and removes, so the refusal above is down to /proc.
    const control = run(false);
    expect(control.writesUnavailable).toBeNull();
    expect(control.record).toBe('written');
    expect(control.remove).toBe('written');
    const after = await store.list();
    expect(after.map((r) => r.text)).toEqual(['new words']);
  });
});
