import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MAX_RECOVERY_RECORDS, SendRecord } from '../src/recovery.ts';
import { DraftSpace, draftNamespace, LOCK_TIMEOUT_MS } from '../src/stores/drafts.ts';
import { python, referenceRoot, sandbox } from './helpers.ts';

describe('Porch recovery evidence', () => {
  let s = sandbox();
  afterAll(() => s.cleanup());
  afterEach(() => {
    s.cleanup();
    s = sandbox();
  });
  const id = '00000000000000000001-0123456789abcdef0123456789abcdef';
  const filename = (store: SendRecord, recordId = id) =>
    join(store.directory, `${store.namespace}.recovery.${recordId}.json`);
  it('exact Python bytes, namespace, permissions and restore without sending', async () => {
    const store = new SendRecord(s.cfg, () => id);
    expect(draftNamespace(s.cfg)).toBe(
      python(
        s,
        'import hashlib,json,sys;print(hashlib.sha256(json.dumps(sys.argv[1:],ensure_ascii=True).encode()).hexdigest()[:32])',
        [s.cfg.ownerRoom, s.cfg.ownerRoomDir, s.cfg.mailRoot],
      ).trim(),
    );
    expect(await store.record('commons', '🗳️ p1: b')).toBe(id);
    expect(readFileSync(filename(store), 'utf8')).toBe(
      `{"id": "${id}", "channel": "commons", "text": "🗳️ p1: b", "reply_to": null}\n`,
    );
    expect(await store.restore(id)).toEqual({
      id,
      channel: 'commons',
      text: '🗳️ p1: b',
      reply_to: null,
    });
    expect(await store.list('other')).toEqual([]);
    expect(readdirSync(store.directory)).toEqual(
      expect.arrayContaining([`${store.namespace}.lock`, `${store.namespace}.recovery.${id}.json`]),
    );
  });
  it('Python writes -> TS reads, TS writes -> Python reads and removes', async () => {
    const pythonId = python(
      s,
      'import sys;from porch3.config import load_config;from porch3.drafts import RecoveryStore;print(RecoveryStore(load_config()).record("commons","first\\nsecond ",reply_to="reply-id"))',
    ).trim();
    const store = new SendRecord(s.cfg, () => id);
    expect((await store.restore(pythonId)).text).toBe('first\nsecond ');
    await store.record('commons', 'back 🦊', { replyTo: 'reply-id' });
    const records = JSON.parse(
      python(
        s,
        'import json;from porch3.config import load_config;from porch3.drafts import RecoveryStore;print(json.dumps(RecoveryStore(load_config()).list()))',
      ),
    ) as { id: string; text: string }[];
    expect(records.find((r) => r.id === id)?.text).toBe('back 🦊');
    python(
      s,
      'import sys;from porch3.config import load_config;from porch3.drafts import RecoveryStore;RecoveryStore(load_config()).remove(sys.argv[1])',
      [id],
    );
    expect((await store.list()).map((r) => r.id)).toEqual([pythonId]);
    await store.remove(pythonId);
    expect(await store.list()).toEqual([]);
  });
  it('collision never overwrites existing evidence', async () => {
    const store = new SendRecord(s.cfg, () => id);
    await store.record('commons', 'first');
    await expect(store.record('commons', 'second')).rejects.toThrow();
    expect((await store.restore(id)).text).toBe('first');
  });
  it('corruption is neither empty nor deleted, even by explicit remove', async () => {
    const store = new SendRecord(s.cfg, () => id);
    await store.record('commons', 'first');
    writeFileSync(filename(store), '{corrupt', { mode: 0o600 });
    await expect(store.list()).rejects.toThrow();
    await expect(store.remove(id)).rejects.toThrow();
    expect(readFileSync(filename(store), 'utf8')).toBe('{corrupt');
    await expect(store.record('commons', 'next')).rejects.toThrow();
  });
  it('mismatched ids and unknown fields are refused without touching evidence', async () => {
    const store = new SendRecord(s.cfg, () => id);
    await store.record('commons', 'first');
    const original = readFileSync(filename(store), 'utf8');
    writeFileSync(filename(store), original.replace(id, 'other'));
    await expect(store.list()).rejects.toThrow();
    writeFileSync(
      filename(store),
      JSON.stringify({ id, channel: 'commons', text: 'first', reply_to: null, extra: true }),
    );
    await expect(store.list()).rejects.toThrow();
  });
  it('capacity refuses new evidence and keeps all existing records', async () => {
    const store = new SendRecord(s.cfg);
    mkdirSync(store.directory, { mode: 0o700 });
    for (let i = 0; i < MAX_RECOVERY_RECORDS; i++) {
      const next = `${String(i).padStart(20, '0')}-${'0'.repeat(32)}`;
      writeFileSync(
        filename(store, next),
        JSON.stringify({ id: next, channel: 'commons', text: 'saved', reply_to: null }),
        { mode: 0o600 },
      );
    }
    await expect(store.record('commons', 'new')).rejects.toThrow('capacity');
    expect(await store.list()).toHaveLength(MAX_RECOVERY_RECORDS);
  });
  it('rejects symlink parents, public directories, symlink locks and linked records', async () => {
    const store = new SendRecord(s.cfg);
    const outside = join(s.root, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, store.directory);
    await expect(store.record('commons', 'new')).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });
  it('world-readable recovery directory is refused', async () => {
    const store = new SendRecord(s.cfg);
    mkdirSync(store.directory, { mode: 0o755 });
    chmodSync(store.directory, 0o755);
    await expect(store.record('commons', 'new')).rejects.toThrow('0700');
  });
  it('external hardlinks refused; exact post-publication sibling accepted', async () => {
    const store = new SendRecord(s.cfg, () => id);
    await store.record('commons', 'first');
    linkSync(filename(store), join(s.root, 'external'));
    await expect(store.list()).rejects.toThrow();
  });
  it('crash-state two-link sibling round-trips and explicit remove cleans both', async () => {
    const store = new SendRecord(s.cfg, () => id);
    await store.record('commons', 'first');
    const sibling = join(store.directory, `.${store.namespace}.recovery.${id}.json.tmp`);
    linkSync(filename(store), sibling);
    expect((await store.list())[0]?.text).toBe('first');
    await store.remove(id);
    expect(readdirSync(store.directory)).toEqual([`${store.namespace}.lock`]);
  });
  it('lock symlinks and public files refused', async () => {
    const store = new SendRecord(s.cfg);
    mkdirSync(store.directory, { mode: 0o700 });
    writeFileSync(join(s.root, 'lock'), 'evidence', { mode: 0o600 });
    symlinkSync(join(s.root, 'lock'), join(store.directory, `${store.namespace}.lock`));
    await expect(store.record('commons', 'new')).rejects.toThrow();
    expect(readFileSync(join(s.root, 'lock'), 'utf8')).toBe('evidence');
  });
  it('Unicode namespace matches Python ensure_ascii for astral and BMP characters', () => {
    const cfg = { ...s.cfg, ownerRoom: '🦊é' };
    expect(draftNamespace(cfg)).toBe(
      python(
        s,
        'import hashlib,json,sys;print(hashlib.sha256(json.dumps(sys.argv[1:],ensure_ascii=True).encode()).hexdigest()[:32])',
        [cfg.ownerRoom, cfg.ownerRoomDir, cfg.mailRoot],
      ).trim(),
    );
  });
  it('text, record and path bounds are checked before publish', async () => {
    const store = new SendRecord(s.cfg);
    await expect(store.record('../escape', 'new')).rejects.toThrow();
    await expect(store.record('commons', 'x'.repeat(1048577))).rejects.toThrow('1 MiB');
    await expect(store.record('commons', '\ud800')).rejects.toThrow('UTF-8');
  });
  it('a send made while this process holds the drafts lock waits its turn, not the 3 s timeout', async () => {
    // Production's timeout, held past it: a recovery store with a lock of its own would be refused.
    const space = new DraftSpace(s.cfg);
    const store = new SendRecord(space, () => id);
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = space.locked(() => {
      entered();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await inside;
    let settled = false;
    const pending = store.record('commons', 'sent while held');
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, LOCK_TIMEOUT_MS + 300));
    const settledWhileHeld = settled;
    release();
    await held;
    expect(await pending).toBe(id);
    expect(settledWhileHeld).toBe(false);
    expect((await store.restore(id)).text).toBe('sent while held');
  }, 15000);
  it('uses the same flock as a concurrently running Python Porch', async () => {
    const reference = referenceRoot;
    const child = spawn(
      join(reference, '.venv', 'bin', 'python'),
      [
        '-u',
        '-c',
        'import sys;from porch3.config import load_config;from porch3.drafts import DraftStore\nwith DraftStore(load_config())._locked():\n print("held",flush=True)\n sys.stdin.readline()',
      ],
      {
        cwd: s.cfg.ownerRoomDir,
        env: { ...s.env, PYTHONPATH: join(reference, 'src'), PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exit = once(child, 'exit');
    try {
      const [ready] = await once(child.stdout, 'data');
      expect(String(ready).trim()).toBe('held');
      const store = new SendRecord(s.cfg);
      let completed = false;
      const pending = store.record('commons', 'locked words').then((result) => {
        completed = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const whileLocked = completed;
      child.stdin.end();
      const recordId = await pending;
      expect(whileLocked).toBe(false);
      expect((await store.restore(recordId)).text).toBe('locked words');
    } finally {
      child.stdin.end();
      await exit;
    }
  });
});
