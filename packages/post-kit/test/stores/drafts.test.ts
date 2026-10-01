/**
 * Drafts: byte compatibility with porch-tui's `DraftStore` (run for real from porch-tui's
 * virtualenv against temporary directories), the baseline-merge conflict rule, the filesystem
 * safety checks, and the exclusive `flock` both apps share.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DraftConflictError,
  type DraftIdentity,
  DraftSpace,
  Drafts,
  DraftsInvalidError,
  DraftsReadOnlyError,
  draftNamespace,
  LOCK_TIMEOUT_MESSAGE,
  MAX_CHANNELS,
  MAX_TEXT_BYTES,
} from '../../src/stores/drafts.ts';
import { loadFlock } from '../../src/stores/flock.ts';
import { cleanTemps, porchPython, pyJson, runPy, startPy, tempDir } from './pyharness.ts';

afterAll(cleanTemps);

let identity: DraftIdentity;
beforeEach(() => {
  const root = tempDir();
  const ownerRoomDir = join(root, 'room');
  mkdirSync(ownerRoomDir);
  identity = { ownerRoom: 'mara', ownerRoomDir, mailRoot: join(root, 'mail') };
});

const draftFile = (id: DraftIdentity) => new DraftSpace(id).path;

/** Drive porch-tui's real DraftStore: a list of `load` / `save` operations, results as JSON. */
const PY_DRAFTS = `
from pathlib import Path
from porch3.config import build_config
from porch3 import drafts as D
D.LOCK_TIMEOUT_S = INPUT.get('timeout', 3.0)
cfg = build_config(owner_room=INPUT['room'], owner_room_dir=Path(INPUT['dir']), mail_root=Path(INPUT['mail']))
store = D.DraftStore(cfg)
out = {'name': store.path.name, 'results': []}
for op in INPUT['ops']:
    try:
        if op[0] == 'load':
            out['results'].append(['loaded', list(store.load().items())])
        else:
            store.save(dict(op[1]))
            out['results'].append(['saved'])
    except D.DraftConflictError:
        out['results'].append(['conflict'])
    except TimeoutError as exc:
        out['results'].append(['timeout', str(exc)])
    except ValueError as exc:
        out['results'].append(['invalid', str(exc)])
print(json.dumps(out))
`;
type PyDraftOp = ['load'] | ['save', [string, string][]];
type PyDraftResult = { name: string; results: (string | [string, string][])[][] };
function pyDrafts(id: DraftIdentity, ops: PyDraftOp[], timeout = 3.0): PyDraftResult {
  return pyJson<PyDraftResult>(
    PY_DRAFTS,
    { room: id.ownerRoom, dir: id.ownerRoomDir, mail: id.mailRoot, ops, timeout },
    { porch: true },
  );
}

const needsPorch = describe.skipIf(porchPython === null);

describe('namespace and bytes', () => {
  it('hashes the identity exactly as Python json.dumps(ensure_ascii=True) does', () => {
    const id = { ownerRoom: 'mara', ownerRoomDir: '/r/mara', mailRoot: '/m' };
    const expected = createHash('sha256')
      .update('["mara", "/r/mara", "/m"]')
      .digest('hex')
      .slice(0, 32);
    expect(draftNamespace(id)).toBe(expected);
    // The vector itself, pinned so a change to the hash input is visible in review.
    expect(expected).toBe('61757da1f3bcb1089f97648383ae6211');
    const py = runPy(
      `import hashlib\nprint(hashlib.sha256(json.dumps(["mara", "/r/mara", "/m"], ensure_ascii=True).encode()).hexdigest()[:32])`,
    );
    expect(py.stdout.trim()).toBe(expected);
  });

  it('escapes non-ASCII identities the way Python does before hashing', () => {
    const id = { ownerRoom: 'märä🦊', ownerRoomDir: '/r/é', mailRoot: '/m/\u007f' };
    const py = runPy(
      `import hashlib\nprint(hashlib.sha256(json.dumps(INPUT, ensure_ascii=True).encode()).hexdigest()[:32])`,
      [id.ownerRoom, id.ownerRoomDir, id.mailRoot],
    );
    expect(draftNamespace(id)).toBe(py.stdout.trim());
  });

  it('writes the exact bytes porch-tui writes', async () => {
    const drafts = Drafts.for(identity);
    await drafts.load();
    await drafts.save({ commons: ' first\nsecond \n', work: 'draft' });
    expect(readFileSync(draftFile(identity), 'utf8')).toBe(
      '{"commons": " first\\nsecond \\n", "work": "draft"}\n',
    );
    const mode = statSync(draftFile(identity)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

needsPorch('round trip through porch-tui', () => {
  const awkward: [string, string][] = [
    ['commons', ' first\nsecond \n'],
    ['émoji', 'fox 🦊 and ZWJ 👩‍👩‍👧 and CJK 漢字'],
    ['ctl', 'tab\tnul\u0000del\u007f esc\u001b quote" backslash\\ bidi‮'],
    ['123', 'an integer-like channel name keeps its place'],
    ['work', ''],
  ];

  it('uses the same file name', () => {
    expect(pyDrafts(identity, []).name).toBe(new DraftSpace(identity).jsonName);
  });

  it('reads what Python wrote, and Python reads what TypeScript wrote, byte for byte', async () => {
    // porch-tui applies a save's changes in Python set order, so new channels land in the file in
    // hash order; the order that matters is the file's, as Python itself reads it back.
    const py = pyDrafts(identity, [['load'], ['save', awkward], ['load']]);
    const fileOrder = (py.results[2] as [string, [string, string][]])[1];
    expect(new Map(fileOrder)).toEqual(new Map(awkward));
    const pythonBytes = readFileSync(draftFile(identity));

    const drafts = Drafts.for(identity);
    const loaded = await drafts.load();
    expect([...loaded]).toEqual(fileOrder);

    // Rewrite through TypeScript with one change, then undo it: the bytes return to Python's.
    await drafts.save(new Map([...loaded, ['extra', 'x']]));
    const withExtra = pyDrafts(identity, [['load']]).results[0] as [string, [string, string][]];
    expect(withExtra[1]).toEqual([...fileOrder, ['extra', 'x']]);
    await drafts.save(new Map(awkward));
    expect(readFileSync(draftFile(identity)).equals(pythonBytes)).toBe(true);
  });

  it('merges a Python edit to another channel and refuses a Python edit to the same one', async () => {
    const drafts = Drafts.for(identity);
    await drafts.save({ a: '1', b: '1' });
    // Python loads, edits b, saves.
    pyDrafts(identity, [
      ['load'],
      [
        'save',
        [
          ['a', '1'],
          ['b', 'python'],
        ],
      ],
    ]);
    // TypeScript still holds the old baseline and edits a: merged.
    await drafts.save({ a: 'ts', b: '1' });
    expect(JSON.parse(readFileSync(draftFile(identity), 'utf8'))).toEqual({ a: 'ts', b: 'python' });
    // Now TypeScript edits b from its stale baseline: conflict, file unchanged.
    const before = readFileSync(draftFile(identity));
    await expect(drafts.save({ a: 'ts', b: 'mine' })).rejects.toBeInstanceOf(DraftConflictError);
    expect(readFileSync(draftFile(identity)).equals(before)).toBe(true);
    // And the other way: Python's stale baseline on a channel TypeScript changed.
    const py = pyDrafts(identity, [
      ['load'],
      [
        'save',
        [
          ['a', 'ts'],
          ['b', 'python'],
          ['c', 'new'],
        ],
      ],
    ]);
    expect(py.results[1]).toEqual(['saved']);
  });
});

describe('the baseline-merge conflict rule', () => {
  type Case = {
    name: string;
    base: Record<string, string>;
    foreign: Record<string, string>;
    wanted: Record<string, string>;
    result: Record<string, string> | 'conflict';
  };
  const cases: Case[] = [
    {
      name: 'an unrelated foreign change merges',
      base: { a: '1', b: '1' },
      foreign: { a: '1', b: '2' },
      wanted: { a: 'x', b: '1' },
      result: { a: 'x', b: '2' },
    },
    {
      name: 'a foreign change to the same channel conflicts',
      base: { a: '1' },
      foreign: { a: '2' },
      wanted: { a: 'x' },
      result: 'conflict',
    },
    {
      name: 'a foreign change to the value we want is fine',
      base: { a: '1' },
      foreign: { a: 'x' },
      wanted: { a: 'x' },
      result: { a: 'x' },
    },
    {
      name: 'deleting a channel changed elsewhere conflicts',
      base: { a: '1', b: '1' },
      foreign: { a: '2', b: '1' },
      wanted: { b: '1' },
      result: 'conflict',
    },
    {
      name: 'deleting an untouched channel deletes it',
      base: { a: '1', b: '1' },
      foreign: { a: '1', b: '2' },
      wanted: { b: '1' },
      result: { b: '2' },
    },
    {
      name: 'adding a channel another session also added differently conflicts',
      base: {},
      foreign: { a: 'theirs' },
      wanted: { a: 'mine' },
      result: 'conflict',
    },
    {
      name: 'a foreign deletion of a channel we changed conflicts',
      base: { a: '1' },
      foreign: {},
      wanted: { a: 'x' },
      result: 'conflict',
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const mine = Drafts.for(identity);
      const theirs = Drafts.for(identity);
      await mine.save(c.base);
      await theirs.load();
      await theirs.save(c.foreign);
      if (c.result === 'conflict') {
        await expect(mine.save(c.wanted)).rejects.toBeInstanceOf(DraftConflictError);
        expect(JSON.parse(readFileSync(draftFile(identity), 'utf8'))).toEqual(c.foreign);
      } else {
        await mine.save(c.wanted);
        expect(JSON.parse(readFileSync(draftFile(identity), 'utf8'))).toEqual(c.result);
      }
    });
  }

  it('does not rewrite the file when nothing changed', async () => {
    const drafts = Drafts.for(identity);
    await drafts.save({ a: '1' });
    const before = statSync(draftFile(identity));
    await drafts.save({ a: '1' });
    const after = statSync(draftFile(identity));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('leaves no temporary files behind', async () => {
    const drafts = Drafts.for(identity);
    await drafts.save({ a: '1' });
    await drafts.save({ a: '2' });
    const names = readdirSync(new DraftSpace(identity).directory);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('caps and validation', () => {
  it('refuses more than MAX_CHANNELS channels', async () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_CHANNELS + 1 }, (_, k) => [`c${k}`, 'x']),
    );
    await expect(Drafts.for(identity).save(many)).rejects.toBeInstanceOf(DraftsInvalidError);
  });

  it('refuses text over MAX_TEXT_BYTES in UTF-8', async () => {
    const big = '🦊'.repeat(MAX_TEXT_BYTES / 4 + 1);
    await expect(Drafts.for(identity).save({ a: big })).rejects.toBeInstanceOf(DraftsInvalidError);
    await Drafts.for(identity).save({ a: '🦊'.repeat(MAX_TEXT_BYTES / 4) });
  });

  it.each([
    [''],
    ['.'],
    ['..'],
    ['a/b'],
    ['a\\b'],
    ['bell\u0007'],
    ['c1\u0085'],
    ['x'.repeat(256)],
  ])('refuses the channel name %j', async (name) => {
    await expect(Drafts.for(identity).save({ [name]: 'x' })).rejects.toBeInstanceOf(
      DraftsInvalidError,
    );
  });

  it('refuses a lone surrogate rather than writing U+FFFD', async () => {
    await expect(Drafts.for(identity).save({ a: 'bad \ud800' })).rejects.toBeInstanceOf(
      DraftsInvalidError,
    );
  });

  it.each([
    ['not JSON', '{'],
    ['a list', '[]'],
    ['a non-string draft', '{"a": 1}'],
    ['a bad channel', '{"../x": "y"}'],
    ['a lone surrogate escape', '{"a": "\\ud800"}'],
  ])('treats a draft file holding %s as invalid and keeps it', async (_name, body) => {
    const space = new DraftSpace(identity);
    await space.locked(() => undefined); // creates the directory
    writeFileSync(space.path, body, { mode: 0o600 });
    await expect(Drafts.for(identity).load()).rejects.toBeInstanceOf(DraftsInvalidError);
    expect(readFileSync(space.path, 'utf8')).toBe(body);
  });
});

describe('filesystem safety', () => {
  it('refuses a drafts directory that is a symlink', async () => {
    const elsewhere = tempDir();
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, join(identity.ownerRoomDir, '.porch-drafts'));
    await expect(Drafts.for(identity).save({ a: '1' })).rejects.toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a symlink anywhere on the path', async () => {
    const real = tempDir();
    mkdirSync(join(real, 'room'));
    const link = join(tempDir(), 'link');
    symlinkSync(real, link);
    const id = { ...identity, ownerRoomDir: join(link, 'room') };
    await expect(Drafts.for(id).save({ a: '1' })).rejects.toThrow();
    expect(readdirSync(join(real, 'room'))).toEqual([]);
  });

  it('refuses a drafts directory other users can reach', async () => {
    const dir = join(identity.ownerRoomDir, '.porch-drafts');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    await expect(Drafts.for(identity).save({ a: '1' })).rejects.toThrow(/0700|owned/);
  });

  it('refuses a draft file readable by others, or with a second hard link', async () => {
    const drafts = Drafts.for(identity);
    await drafts.save({ a: '1' });
    const path = draftFile(identity);
    chmodSync(path, 0o644);
    await expect(Drafts.for(identity).load()).rejects.toThrow(/owner-only/);
    chmodSync(path, 0o600);
    linkSync(path, join(tempDir(), 'second-link'));
    await expect(Drafts.for(identity).load()).rejects.toThrow(/owner-only/);
  });

  it('refuses a draft file or lock file that is a symlink', async () => {
    const space = new DraftSpace(identity);
    await space.locked(() => undefined);
    const target = join(tempDir(), 'target');
    writeFileSync(target, '{}', { mode: 0o600 });
    symlinkSync(target, space.path);
    await expect(Drafts.for(identity).load()).rejects.toThrow();

    const id2 = { ...identity, ownerRoom: 'other' };
    const space2 = new DraftSpace(id2);
    symlinkSync(target, join(space2.directory, space2.lockName));
    await expect(Drafts.for(id2).load()).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });
});

describe('the exclusive lock', () => {
  it('works through the FFI on this machine', () => {
    const flock = loadFlock();
    expect(flock.ok ? 'available' : flock.reason).toBe('available');
  });

  it('excludes a second holder in this process', async () => {
    const a = new DraftSpace(identity);
    const b = new DraftSpace(identity, { lockTimeoutMs: 150 });
    await a.locked(async () => {
      await expect(b.locked(() => 'got it')).rejects.toThrow(LOCK_TIMEOUT_MESSAGE);
    });
    await expect(b.locked(() => 'got it')).resolves.toBe('got it');
  });

  needsPorch('against porch-tui', () => {
    it('a Python holder blocks TypeScript saves until it lets go', async () => {
      const held = await startPy(
        `import json, sys
from pathlib import Path
from porch3.config import build_config
from porch3.drafts import DraftStore
cfg = build_config(owner_room=${JSON.stringify(identity.ownerRoom)}, owner_room_dir=Path(${JSON.stringify(identity.ownerRoomDir)}), mail_root=Path(${JSON.stringify(identity.mailRoot)}))
with DraftStore(cfg)._locked():
    print('holding', flush=True)
    sys.stdin.readline()
`,
        { porch: true },
      );
      expect(held.ready).toBe('holding');
      const drafts = Drafts.for(identity, { lockTimeoutMs: 300 });
      try {
        await expect(drafts.save({ a: '1' })).rejects.toThrow(LOCK_TIMEOUT_MESSAGE);
      } finally {
        expect((await held.finish()).status).toBe(0);
      }
      await drafts.save({ a: '1' });
      expect(JSON.parse(readFileSync(draftFile(identity), 'utf8'))).toEqual({ a: '1' });
    });

    it('a TypeScript holder makes porch-tui time out, and it writes nothing', async () => {
      await Drafts.for(identity).save({ a: 'ts' });
      const before = readFileSync(draftFile(identity));
      const result = await new DraftSpace(identity).locked(() =>
        pyDrafts(identity, [['load']], 0.3),
      );
      expect(result.results[0]).toEqual(['timeout', 'another Porch process is writing drafts']);
      expect(readFileSync(draftFile(identity)).equals(before)).toBe(true);
      // Released: Python gets through.
      expect(pyDrafts(identity, [['load']], 0.3).results[0]?.[0]).toBe('loaded');
    });
  });
});

describe('without flock', () => {
  const unavailable = { ok: false as const, reason: 'no libc flock (test)' };

  it('stays read-only: loads, refuses to save, and never creates the lock file', async () => {
    await Drafts.for(identity).save({ a: 'saved earlier' });
    const space = new DraftSpace(identity);
    const lockPath = join(space.directory, space.lockName);
    const before = readFileSync(space.path);

    const drafts = Drafts.for(identity, { flock: unavailable });
    expect(drafts.readOnlyReason).toBe('no libc flock (test)');
    expect([...(await drafts.load())]).toEqual([['a', 'saved earlier']]);
    await expect(drafts.save({ a: 'new' })).rejects.toBeInstanceOf(DraftsReadOnlyError);
    expect(readFileSync(space.path).equals(before)).toBe(true);

    const fresh = { ...identity, ownerRoom: 'fresh' };
    await expect(Drafts.for(fresh, { flock: unavailable }).save({ a: '1' })).rejects.toBeInstanceOf(
      DraftsReadOnlyError,
    );
    const freshSpace = new DraftSpace(fresh);
    expect(() => statSync(join(freshSpace.directory, freshSpace.lockName))).toThrow();
    expect(lockPath).toContain('.lock');
  });
});
