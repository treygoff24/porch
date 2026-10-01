/**
 * A read-only recovery store lists and restores without the drafts lock, so a writer (porch-tui, or
 * porch-next on another system) can finish publishing a record mid-read: the record goes from two
 * links (published name and staging sibling) to one when the writer unlinks staging. These tests
 * make that unlink happen at the reader's two vulnerable points, on the real filesystem, by hooking
 * `node:fs` calls the reader makes: right after it first examines the record, and right after it
 * opens the staging sibling. The evidence must still be read; an unexplained link must still be
 * refused.
 */
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendRecord } from '../src/recovery.ts';
import { DraftSpace } from '../src/stores/drafts.ts';
import { sandbox } from './helpers.ts';

type Hooks = {
  afterOpen?: (path: string, fd: number) => void;
  afterFstat?: (fd: number) => void;
};
const hooks: Hooks = {};

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...args);
    hooks.afterOpen?.(String(args[0]), fd);
    return fd;
  }) as typeof fs.openSync;
  const fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
    const st = fs.fstatSync(...args);
    hooks.afterFstat?.(args[0]);
    return st;
  }) as typeof fs.fstatSync;
  const mocked = { ...fs, openSync, fstatSync };
  return { ...mocked, default: mocked };
});

const id = '00000000000000000001-0123456789abcdef0123456789abcdef';
const expected = { id, channel: 'commons', text: 'kept words', reply_to: null };

describe('unlocked recovery reads across a concurrent publish', () => {
  let s = sandbox();
  afterAll(() => s.cleanup());
  let reader: SendRecord;
  let record: string;
  let staging: string;
  let unlinked: boolean;
  beforeEach(async () => {
    s.cleanup();
    s = sandbox();
    // Write the record, then put it back in the writer's state just before its last step: the
    // published name and the staging sibling, two links to one inode.
    const writer = new SendRecord(s.cfg, () => id);
    await writer.record('commons', 'kept words');
    record = join(writer.directory, `${writer.namespace}.recovery.${id}.json`);
    staging = join(writer.directory, `.${writer.namespace}.recovery.${id}.json.tmp`);
    realFs.linkSync(record, staging);
    // No flock: the store is read-only and reads without the lock, as without /proc/self/fd.
    reader = new SendRecord(
      new DraftSpace(s.cfg, { flock: { ok: false, reason: 'test: reads without the lock' } }),
    );
    expect(reader.readOnlyReason).toBe('test: reads without the lock');
    unlinked = false;
  });
  afterEach(() => {
    delete hooks.afterOpen;
    delete hooks.afterFstat;
  });
  /** The writer's last step: unlink staging, leaving the published record with one link. */
  const publish = () => {
    if (unlinked) return;
    unlinked = true;
    realFs.unlinkSync(staging);
  };
  const reads = [
    ['restore', () => reader.restore(id)],
    ['list', async () => (await reader.list())[0]],
  ] as const;

  for (const [name, read] of reads) {
    it(`${name}: staging unlinked right after the reader first examines the record`, async () => {
      let recordFd = -1;
      hooks.afterOpen = (path, fd) => {
        if (path.endsWith(`.recovery.${id}.json`)) recordFd = fd;
      };
      hooks.afterFstat = (fd) => {
        if (fd === recordFd) publish();
      };
      expect(await read()).toEqual(expected);
      expect(unlinked).toBe(true);
    });

    it(`${name}: staging unlinked right after the reader opens it`, async () => {
      hooks.afterOpen = (path) => {
        if (path.endsWith(`.recovery.${id}.json.tmp`)) publish();
      };
      expect(await read()).toEqual(expected);
      expect(unlinked).toBe(true);
    });
  }

  it('the crash state with staging still in place reads as before', async () => {
    expect(await reader.restore(id)).toEqual(expected);
    expect(realFs.statSync(record).nlink).toBe(2);
  });

  it('an external hard link is still refused without the lock', async () => {
    realFs.unlinkSync(staging);
    realFs.linkSync(record, join(s.root, 'external'));
    await expect(reader.restore(id)).rejects.toThrow('safe links');
    await expect(reader.list()).rejects.toThrow('safe links');
  });

  it('a staging sibling that is a different file is still refused', async () => {
    realFs.unlinkSync(staging);
    realFs.linkSync(record, join(s.root, 'external'));
    realFs.writeFileSync(staging, 'other', { mode: 0o600 });
    realFs.linkSync(staging, join(s.root, 'external-staging'));
    await expect(reader.restore(id)).rejects.toThrow('does not match');
  });
});
