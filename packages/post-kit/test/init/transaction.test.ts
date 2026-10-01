/**
 * The init transaction's rollback undoes only what is still exactly this run's, and leaves anything
 * changed underneath it alone, saying so. All files live in temporary directories.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { InitTransaction } from '../../src/init/transaction.ts';
import { loadFlock } from '../../src/stores/flock.ts';
import { cleanTemps, tempDir } from '../stores/pyharness.ts';

afterAll(cleanTemps);

const flock = loadFlock();
const OTHER = 'other@porch namespaces="other-porch" ssh-ed25519 AAAAother\n';
const MINE = 'mara@porch namespaces="mara-porch" ssh-ed25519 AAAAmine\n';

let dir: string;
let signers: string;
beforeEach(() => {
  dir = tempDir('porch-t3b-txn-');
  signers = join(dir, 'allowed_signers');
});

/** Create `path` the way init does and record it in `txn`. */
function create(txn: InitTransaction, path: string, bytes: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, bytes);
    txn.recordCreated(path, fd, Buffer.from(bytes));
  } finally {
    closeSync(fd);
  }
}

describe.skipIf(!flock.ok)('the init transaction', () => {
  it('removes its own files and restores allowed_signers when nothing else changed them', async () => {
    writeFileSync(signers, OTHER);
    chmodSync(signers, 0o644);
    const txn = await InitTransaction.begin(signers, flock);
    const key = join(dir, 'key');
    create(txn, key, 'secret');
    txn.appendSigners(Buffer.from(MINE));
    expect(readFileSync(signers, 'utf8')).toBe(OTHER + MINE);
    expect(statSync(signers).mode & 0o777).toBe(0o600);

    expect(txn.rollback()).toEqual([]);
    expect(existsSync(key)).toBe(false);
    expect(readFileSync(signers, 'utf8')).toBe(OTHER);
    expect(statSync(signers).mode & 0o777).toBe(0o644);
  });

  it('leaves alone, and reports, every file changed after it wrote it', async () => {
    writeFileSync(signers, OTHER, { mode: 0o600 });
    const txn = await InitTransaction.begin(signers, flock);
    const key = join(dir, 'key');
    const pub = join(dir, 'key.pub');
    create(txn, key, 'secret');
    create(txn, pub, 'public');
    txn.appendSigners(Buffer.from(MINE));

    // A writer that ignores the lock (a person, or a tool) changes all three underneath it.
    const third = 'third@porch namespaces="t" ssh-ed25519 AAAAthird\n';
    appendFileSync(signers, third);
    unlinkSync(key);
    writeFileSync(key, 'secret'); // same bytes, but another inode: not this run's file
    writeFileSync(pub, 'replaced in place');

    const problems = txn.rollback();
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/left .*allowed_signers alone: its contents changed/);
    expect(problems.join('\n')).toMatch(/left .*key alone: it was replaced/);
    expect(problems.join('\n')).toMatch(/left .*key\.pub alone: its contents changed/);
    expect(readFileSync(signers, 'utf8')).toBe(OTHER + MINE + third);
    expect(readFileSync(key, 'utf8')).toBe('secret');
    expect(readFileSync(pub, 'utf8')).toBe('replaced in place');
  });

  it('removes an allowed_signers it created only while it holds exactly its own line', async () => {
    const first = await InitTransaction.begin(signers, flock);
    expect(first.createdSigners).toBe(true);
    first.appendSigners(Buffer.from(MINE));
    expect(first.rollback()).toEqual([]);
    expect(existsSync(signers)).toBe(false);

    const second = await InitTransaction.begin(signers, flock);
    second.appendSigners(Buffer.from(MINE));
    appendFileSync(signers, OTHER);
    expect(second.rollback()).toEqual([
      `left ${signers} alone: its contents changed while init ran`,
    ]);
    expect(readFileSync(signers, 'utf8')).toBe(MINE + OTHER);
  });

  it('waits for the lock, and reopens when the file it waited on was removed', async () => {
    const first = await InitTransaction.begin(signers, flock);
    first.appendSigners(Buffer.from(MINE));
    let settled = false;
    const waiting = InitTransaction.begin(signers, flock).then((t) => {
      settled = true;
      return t;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    expect(first.rollback()).toEqual([]); // removes the file it created, then releases the lock
    const second = await waiting;
    expect(second.createdSigners).toBe(true);
    expect(second.original.length).toBe(0);
    second.appendSigners(Buffer.from(OTHER));
    second.commit();
    expect(readFileSync(signers, 'utf8')).toBe(OTHER);
  });

  it('refuses to append when the file grew after it was read under the lock', async () => {
    writeFileSync(signers, OTHER, { mode: 0o600 });
    const txn = await InitTransaction.begin(signers, flock);
    appendFileSync(signers, 'late@porch namespaces="l" ssh-ed25519 AAAAlate\n');
    expect(() => txn.appendSigners(Buffer.from(MINE))).toThrow(/changed while init held its lock/);
    expect(txn.rollback()).toEqual([]);
    expect(readFileSync(signers, 'utf8')).not.toContain(MINE);
  });
});
