/**
 * Per-channel drafts, byte-compatible with porch-tui's `DraftStore` (`src/porch3/drafts.py`), so
 * porch-tui and porch-next can run at once over the same file.
 *
 * - Path: `<owner_room_dir>/.porch-drafts/<ns>.json`, lock `<ns>.lock`, where `<ns>` is the first 32
 *   hex digits of the sha256 of Python's `json.dumps([owner_room, str(owner_room_dir),
 *   str(mail_root)], ensure_ascii=True)`.
 * - Format: one JSON object `{channel: text}` written as `json.dumps(…, ensure_ascii=False) + "\n"`.
 * - Caps: file ≤ 1 MiB, ≤ 1000 channels, text ≤ 256 KiB of UTF-8.
 * - Safety: the directory is walked no-follow from `/`, created 0700 and must be owner-only; files
 *   must be owner-only regular files with one link; an invalid or unsafe file is never overwritten.
 * - Locking: an exclusive `flock` on `<ns>.lock`, polled every 20 ms for 3 s. Without a working
 *   `flock`, or without `/proc/self/fd` to write through the held directory (macOS for now), the
 *   store is read-only: it never writes without both.
 * - Concurrency: a changed channel whose saved value differs from both what this caller last saw and
 *   what it now wants is a conflict; unrelated channels and deletions merge.
 *
 * {@link DraftSpace} (namespace, directory and lock) is shared with the recovery-record store, which
 * porch-tui keeps under the same lock.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, readSync, writeSync } from 'node:fs';
import { pyJoin } from '../config/pypath.ts';
import {
  assertPrivateDirectory,
  assertPrivateFile,
  DirHandle,
  isCode,
  WRITES_UNAVAILABLE,
} from './dirfd.ts';
import { type FlockAvailability, loadFlock, lockExclusive } from './flock.ts';
import { PyJsonError, pyJsonDumps, pyJsonLoadsBytes, pyUtf8Length } from './py.ts';

export const MAX_DRAFT_BYTES = 1024 * 1024;
export const MAX_CHANNELS = 1000;
export const MAX_TEXT_BYTES = 256 * 1024;
export const LOCK_TIMEOUT_MS = 3000;
export const LOCK_TIMEOUT_MESSAGE = 'another Porch process is writing drafts';

/**
 * Shown, and kept on screen, when drafts cannot be written: `flock` is unavailable, or this system
 * cannot write through a held directory. The reason follows it.
 */
export const DRAFTS_READ_ONLY_NOTICE =
  'drafts are read-only: porch-next writes drafts only under the drafts lock, through a held directory';

/** The identity triple that scopes drafts. Paths are as the config holds them (pathlib form). */
export type DraftIdentity = {
  readonly ownerRoom: string;
  readonly ownerRoomDir: string;
  readonly mailRoot: string;
};

export class DraftConflictError extends Error {
  constructor() {
    super('Another Porch session changed a draft; reload before saving.');
    this.name = 'DraftConflictError';
  }
}

export class DraftsInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftsInvalidError';
  }
}

export class DraftsReadOnlyError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`${DRAFTS_READ_ONLY_NOTICE} (${reason})`);
    this.name = 'DraftsReadOnlyError';
    this.reason = reason;
  }
}

/** porch-tui's `validate_channel`: one bounded post path component, never a traversal or control. */
export function validateChannelName(channel: unknown): string {
  if (typeof channel === 'string' && channel !== '' && channel !== '.' && channel !== '..') {
    let ok = !channel.includes('/') && !channel.includes('\\');
    for (const ch of channel) {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 32 || (c >= 127 && c <= 159)) ok = false;
    }
    const bytes = pyUtf8Length(channel);
    if (ok && bytes !== null && bytes <= 255) return channel;
  }
  throw new DraftsInvalidError('channel must be one nonempty path-safe component');
}

/** The drafts namespace: `sha256(json.dumps([room, dir, root], ensure_ascii=True))[:32]`. */
export function draftNamespace(identity: DraftIdentity): string {
  const text = pyJsonDumps([identity.ownerRoom, identity.ownerRoomDir, identity.mailRoot], true);
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/** The namespace, directory and lock shared by drafts and recovery records. No I/O on construction. */
export class DraftSpace {
  readonly namespace: string;
  readonly directory: string;
  readonly jsonName: string;
  readonly lockName: string;
  readonly path: string;
  readonly flock: FlockAvailability;
  /** Why nothing may be written here, or `null` when writes are possible. */
  readonly readOnlyReason: string | null;
  private readonly lockTimeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    identity: DraftIdentity,
    options: { flock?: FlockAvailability; lockTimeoutMs?: number } = {},
  ) {
    this.namespace = draftNamespace(identity);
    this.directory = pyJoin(identity.ownerRoomDir, '.porch-drafts');
    this.jsonName = `${this.namespace}.json`;
    this.lockName = `${this.namespace}.lock`;
    this.path = pyJoin(this.directory, this.jsonName);
    this.flock = options.flock ?? loadFlock();
    this.readOnlyReason = this.flock.ok ? WRITES_UNAVAILABLE : this.flock.reason;
    this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  }

  /**
   * The held, verified drafts directory, created 0700 if missing unless `create` is false (then a
   * missing directory throws `ENOENT`). Caller closes it.
   */
  openDirectory(create = true): DirHandle {
    const handle = DirHandle.walk(this.directory, { createLast: create, createMode: 0o700 });
    try {
      assertPrivateDirectory(handle);
      return handle;
    } catch (err) {
      handle.close();
      throw err;
    }
  }

  /**
   * Run `fn` with the directory held and the exclusive lock taken, one caller at a time within this
   * object. Throws {@link DraftsReadOnlyError} when the store is read-only: nothing runs unlocked.
   */
  locked<T>(fn: (directory: DirHandle) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const flock = this.flock;
      if (!flock.ok) throw new DraftsReadOnlyError(flock.reason);
      if (this.readOnlyReason !== null) throw new DraftsReadOnlyError(this.readOnlyReason);
      const directory = this.openDirectory();
      let lock: number | null = null;
      try {
        lock = directory.open(
          this.lockName,
          constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK,
          0o600,
        );
        assertPrivateFile(lock);
        await lockExclusive(flock.flocker, lock, {
          timeoutMs: this.lockTimeoutMs,
          message: LOCK_TIMEOUT_MESSAGE,
        });
        return await fn(directory);
      } finally {
        if (lock !== null) closeSync(lock);
        directory.close();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function validateDrafts(drafts: ReadonlyMap<string, unknown>): Map<string, string> {
  if (drafts.size > MAX_CHANNELS) {
    throw new DraftsInvalidError('invalid or excessive draft channel map');
  }
  const out = new Map<string, string>();
  for (const [channel, text] of drafts) {
    validateChannelName(channel);
    const bytes = typeof text === 'string' ? pyUtf8Length(text) : null;
    if (typeof text !== 'string' || bytes === null || bytes > MAX_TEXT_BYTES) {
      throw new DraftsInvalidError('invalid or excessive draft text');
    }
    out.set(channel, text);
  }
  return out;
}

function toMap(drafts: ReadonlyMap<string, string> | Readonly<Record<string, string>>) {
  return drafts instanceof Map
    ? new Map<string, unknown>(drafts)
    : new Map<string, unknown>(Object.entries(drafts));
}

/** Read the whole of `fd`, refusing more than `limit` bytes. */
export function readBounded(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(65536, limit + 1 - total);
    if (want <= 0) break;
    const chunk = Buffer.alloc(want);
    const got = readSync(fd, chunk, 0, want, null);
    if (got === 0) break;
    chunks.push(chunk.subarray(0, got));
    total += got;
  }
  return Buffer.concat(chunks);
}

/** Write every byte of `data` to `fd`. */
export function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const wrote = writeSync(fd, data, offset, data.length - offset);
    if (wrote <= 0) throw new Error('short write');
    offset += wrote;
  }
}

export class Drafts {
  readonly space: DraftSpace;
  private baseline = new Map<string, string>();

  constructor(space: DraftSpace) {
    this.space = space;
  }

  static for(
    identity: DraftIdentity,
    options?: { flock?: FlockAvailability; lockTimeoutMs?: number },
  ): Drafts {
    return new Drafts(new DraftSpace(identity, options));
  }

  /** Why drafts cannot be written, or `null` when they can. */
  get readOnlyReason(): string | null {
    return this.space.readOnlyReason;
  }

  private read(directory: DirHandle): Map<string, string> {
    let fd: number;
    try {
      fd = directory.open(this.space.jsonName, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return new Map();
      throw err;
    }
    let raw: Buffer;
    try {
      assertPrivateFile(fd);
      if (fstatSync(fd).size > MAX_DRAFT_BYTES) {
        throw new DraftsInvalidError('draft file exceeds size limit');
      }
      raw = readBounded(fd, MAX_DRAFT_BYTES);
    } finally {
      closeSync(fd);
    }
    if (raw.length > MAX_DRAFT_BYTES) throw new DraftsInvalidError('draft file exceeds size limit');
    try {
      const value = pyJsonLoadsBytes(raw);
      if (!(value instanceof Map)) throw new DraftsInvalidError('not an object');
      return validateDrafts(value);
    } catch (err) {
      if (err instanceof PyJsonError || err instanceof DraftsInvalidError) {
        throw new DraftsInvalidError('draft file is invalid; existing file kept');
      }
      throw err;
    }
  }

  /**
   * Read the saved drafts and remember them as this caller's baseline. Takes the lock when it can;
   * in a read-only store it reads unlocked (the file is only ever replaced whole) and creates
   * nothing.
   */
  async load(): Promise<Map<string, string>> {
    if (this.space.readOnlyReason !== null) {
      let directory: DirHandle;
      try {
        directory = this.space.openDirectory(false);
      } catch (err) {
        if (!isCode(err, 'ENOENT')) throw err;
        this.baseline = new Map();
        return new Map();
      }
      try {
        const data = this.read(directory);
        this.baseline = new Map(data);
        return data;
      } finally {
        directory.close();
      }
    }
    return this.space.locked((directory) => {
      const data = this.read(directory);
      this.baseline = new Map(data);
      return data;
    });
  }

  /** Save the full draft map, merging unrelated changes made by another process. */
  async save(drafts: ReadonlyMap<string, string> | Readonly<Record<string, string>>) {
    const wanted = validateDrafts(toMap(drafts));
    await this.space.locked((directory) => {
      const latest = this.read(directory);
      const changes: string[] = [];
      for (const channel of new Set([...this.baseline.keys(), ...wanted.keys()])) {
        if (this.baseline.get(channel) !== wanted.get(channel)) changes.push(channel);
      }
      for (const channel of changes) {
        const old = this.baseline.get(channel);
        const next = wanted.get(channel);
        const current = latest.get(channel);
        if (current !== old && current !== next) throw new DraftConflictError();
        if (next === undefined) latest.delete(channel);
        else latest.set(channel, next);
      }
      validateDrafts(latest);
      const payload = Buffer.from(`${pyJsonDumps(latest, false)}\n`, 'utf8');
      if (payload.length > MAX_DRAFT_BYTES) {
        throw new DraftsInvalidError('draft file exceeds size limit');
      }
      if (changes.length > 0) {
        const temporary = `.${this.space.namespace}.${randomUUID().replaceAll('-', '')}.tmp`;
        try {
          const fd = directory.open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o600,
          );
          try {
            writeAll(fd, payload);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          directory.rename(temporary, this.space.jsonName);
          directory.fsync();
        } finally {
          directory.unlinkIfPresent(temporary);
        }
      }
      // The baseline is what THIS caller knows, not merged foreign edits, so a later stale full-map
      // save cannot erase a merge.
      this.baseline = wanted;
    });
  }
}
