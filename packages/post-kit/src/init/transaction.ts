/**
 * The init transaction. Every change `porch-next init` makes happens while it holds the exclusive
 * `flock` on `allowed_signers` (the lock porch-tui's init also takes to append there): from before
 * the first key file is created until the config is committed or everything is rolled back. Two
 * inits on the same signers file therefore never interleave, and one's rollback cannot undo work
 * the other finished.
 *
 * Rollback undoes only what is still exactly this run's. A file it created is removed only while
 * the path names the same inode and that inode holds exactly the bytes this run wrote;
 * `allowed_signers` is restored only while it is the same inode and holds exactly the bytes this
 * run left in it. Anything changed underneath (by a process that does not take the lock, or by
 * hand) is left alone, and the rollback reports it instead of erasing someone else's work.
 *
 * The removal itself still goes by path, after the check: a process that ignores the lock and swaps
 * the file in that instant could lose its file. Node has no descriptor-relative unlink to close that.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { type FlockAvailability, LockTimeoutError, lockExclusive } from '../stores/flock.ts';
import { InitError } from './errors.ts';

export const SIGNERS_LOCK_TIMEOUT_MS = 10_000;
export const MAX_SIGNERS_BYTES = 1 << 20;
const OPEN_ATTEMPTS = 5;

type Identity = { readonly dev: number; readonly ino: number };
type CreatedFile = { readonly path: string; readonly id: Identity; readonly bytes: Buffer };

const isCode = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code;
const idOf = (st: Stats): Identity => ({ dev: st.dev, ino: st.ino });
const sameId = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

/** The identity the path names now, without following a final symlink; null when it is gone. */
function pathId(path: string): Identity | null {
  try {
    return idOf(lstatSync(path));
  } catch (err) {
    if (isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR')) return null;
    throw err;
  }
}

/** Positional write of every byte. */
export function writeAllAt(fd: number, data: Uint8Array, position: number | null): void {
  let offset = 0;
  while (offset < data.length) {
    const wrote = writeSync(
      fd,
      data,
      offset,
      data.length - offset,
      position === null ? null : position + offset,
    );
    if (wrote <= 0) throw new Error('short write');
    offset += wrote;
  }
}

/** Read all of `fd` from offset 0, refusing more than `limit` bytes. */
function readAllFrom0(fd: number, limit: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const want = Math.min(65536, limit + 1 - total);
    if (want <= 0) return null;
    const chunk = Buffer.alloc(want);
    const got = readSync(fd, chunk, 0, want, total);
    if (got === 0) break;
    chunks.push(chunk.subarray(0, got));
    total += got;
  }
  return Buffer.concat(chunks);
}

/** The directories `mkdirSync(leaf, { recursive: true })` created, deepest first. */
function createdChain(first: string | undefined, leaf: string): string[] {
  if (first === undefined) return [];
  const chain: string[] = [];
  for (let d = leaf; ; d = dirname(d)) {
    chain.push(d);
    if (d === first || dirname(d) === d) break;
  }
  return chain;
}

/** `mkdir -p`, remembering what it created so a rollback can remove it again if still empty. */
export function makeParents(dir: string, made: string[]): void {
  const first = mkdirSync(dir, { recursive: true });
  made.unshift(...createdChain(first, dir));
}

async function lockSigners(fd: number, flock: FlockAvailability): Promise<void> {
  if (!flock.ok) {
    throw new InitError(`cannot lock allowed_signers (${flock.reason}); nothing written`, 4);
  }
  try {
    await lockExclusive(flock.flocker, fd, {
      timeoutMs: SIGNERS_LOCK_TIMEOUT_MS,
      message: 'another process is holding allowed_signers',
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new InitError(err.message, 4);
    throw err;
  }
}

export class InitTransaction {
  /** The `allowed_signers` path, and the descriptor whose lock this transaction holds. */
  readonly path: string;
  readonly fd: number;
  /** Its bytes and permission bits when the lock was taken. */
  readonly original: Buffer;
  readonly originalMode: number;
  /** Whether this run created `allowed_signers`. */
  readonly createdSigners: boolean;
  private readonly id: Identity;
  /** Its bytes after this run's append; null while untouched. */
  private expected: Buffer | null = null;
  private modeChanged = false;
  /** Files this run created, by path, in creation order. */
  private readonly created = new Map<string, CreatedFile>();
  /** Directories this run created, deepest first. */
  readonly madeDirs: string[];
  private open = true;

  private constructor(
    path: string,
    fd: number,
    st: Stats,
    original: Buffer,
    createdSigners: boolean,
    madeDirs: string[],
  ) {
    this.path = path;
    this.fd = fd;
    this.id = idOf(st);
    this.original = original;
    this.originalMode = st.mode & 0o7777;
    this.createdSigners = createdSigners;
    this.madeDirs = madeDirs;
  }

  /**
   * Open (creating if needed) and lock `allowed_signers`, then check that the path still names the
   * locked file: another init may have removed or replaced it while this one waited, in which case
   * the open is retried.
   */
  static async begin(path: string, flock: FlockAvailability): Promise<InitTransaction> {
    if (!flock.ok) {
      throw new InitError(`cannot lock allowed_signers (${flock.reason}); nothing written`, 4);
    }
    const madeDirs: string[] = [];
    makeParents(dirname(path), madeDirs);
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    try {
      for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
        let fd = -1;
        let created = false;
        let locked = false;
        try {
          try {
            fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
            created = true;
          } catch (err) {
            if (!isCode(err, 'EEXIST')) throw err;
            fd = openSync(path, flags);
          }
          // Lock first, then stat and read, so no writer appends between the size check and the lock.
          await lockSigners(fd, flock);
          locked = true;
          const st = fstatSync(fd);
          if (!st.isFile()) {
            throw new InitError('allowed_signers must be a regular file (symlink/FIFO refused)');
          }
          const now = pathId(path);
          if (now === null || !sameId(now, idOf(st))) {
            closeSync(fd);
            fd = -1;
            continue;
          }
          if (st.size > MAX_SIGNERS_BYTES) {
            throw new InitError(`allowed_signers exceeds ${MAX_SIGNERS_BYTES} bytes — refuse`);
          }
          const original = readAllFrom0(fd, MAX_SIGNERS_BYTES);
          if (original === null) {
            throw new InitError(`allowed_signers exceeds ${MAX_SIGNERS_BYTES} bytes — refuse`, 4);
          }
          return new InitTransaction(path, fd, st, original, created, madeDirs);
        } catch (err) {
          if (fd >= 0) {
            // A file this run created and still holds locked and empty is removed again. Unlocked,
            // someone else holds it and owns what happens to it.
            if (created && locked && fstatSync(fd).size === 0) {
              const now = pathId(path);
              if (now !== null && sameId(now, idOf(fstatSync(fd)))) unlinkSync(path);
            }
            closeSync(fd);
          }
          if (isCode(err, 'ELOOP')) {
            throw new InitError('allowed_signers must be a regular file (symlink/FIFO refused)');
          }
          if (err instanceof InitError) throw err;
          throw new InitError(`cannot open/update allowed_signers: ${(err as Error).message}`);
        }
      }
      throw new InitError('allowed_signers kept being replaced while init waited for its lock', 4);
    } catch (err) {
      removeEmptyDirs(madeDirs);
      throw err;
    }
  }

  /** Record (or update) a file this run created, with exactly the bytes it holds through `fd`. */
  recordCreated(path: string, fd: number, bytes: Buffer): void {
    this.created.set(path, { path, id: idOf(fstatSync(fd)), bytes });
  }

  /** Directories made for a created file, deepest first. */
  recordDirs(dirs: readonly string[]): void {
    this.madeDirs.unshift(...dirs);
  }

  /**
   * Append `data` at the end of the bytes read under the lock. Refuses if the file grew since (a
   * writer that ignores the lock), and cuts a failed append back to the original length.
   */
  appendSigners(data: Buffer): void {
    if (fstatSync(this.fd).size !== this.original.length) {
      throw new InitError('allowed_signers changed while init held its lock — refuse (kept as-is)');
    }
    try {
      writeAllAt(this.fd, data, this.original.length);
      fsyncSync(this.fd);
    } catch (err) {
      try {
        ftruncateSync(this.fd, this.original.length);
        fsyncSync(this.fd);
      } catch (cut) {
        throw new InitError(
          `appending to allowed_signers failed (${(err as Error).message}) and cutting it back failed (${(cut as Error).message}) — check its last line`,
          4,
        );
      }
      throw new InitError(`cannot open/update allowed_signers: ${(err as Error).message}`);
    }
    this.expected = Buffer.concat([this.original, data]);
    this.chmodSigners(0o600);
  }

  chmodSigners(mode: number): void {
    if (mode === this.originalMode) return;
    fchmodSync(this.fd, mode);
    this.modeChanged = true;
  }

  /** Keep every change and release the lock. */
  commit(): void {
    this.close();
  }

  /**
   * Undo this run's changes that are still exactly this run's, then release the lock. Returns what
   * could not be undone, and why; an empty list means everything was undone.
   */
  rollback(): string[] {
    if (!this.open) return [];
    const problems: string[] = [];
    try {
      const signers = this.rollbackSigners();
      if (signers !== null) problems.push(signers);
      for (const file of [...this.created.values()].reverse()) {
        const problem = removeIfUnchanged(file);
        if (problem !== null) problems.push(problem);
      }
      removeEmptyDirs(this.madeDirs);
    } finally {
      this.close();
    }
    return problems;
  }

  private rollbackSigners(): string | null {
    const touched = this.expected !== null || this.modeChanged || this.createdSigners;
    if (!touched) return null;
    try {
      const now = pathId(this.path);
      if (now === null || !sameId(now, this.id)) {
        return `left ${this.path} alone: it was replaced or removed while init ran`;
      }
      const current = readAllFrom0(this.fd, MAX_SIGNERS_BYTES);
      const want = this.expected ?? this.original;
      if (current === null || !current.equals(want)) {
        return `left ${this.path} alone: its contents changed while init ran`;
      }
      if (this.createdSigners) {
        unlinkSync(this.path);
        return null;
      }
      if (this.expected !== null) {
        ftruncateSync(this.fd, this.original.length);
        fsyncSync(this.fd);
      }
      if (this.modeChanged) fchmodSync(this.fd, this.originalMode);
      return null;
    } catch (err) {
      return `${this.path} (restore failed: ${(err as Error).message})`;
    }
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    closeSync(this.fd); // releases the lock
  }
}

/** Remove `file` only while it is the same inode holding exactly the bytes this run wrote. */
function removeIfUnchanged(file: CreatedFile): string | null {
  let fd: number;
  try {
    fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (isCode(err, 'ENOENT')) return null;
    if (isCode(err, 'ELOOP')) return `left ${file.path} alone: it was replaced while init ran`;
    return `${file.path} (cleanup failed: ${(err as Error).message})`;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !sameId(idOf(st), file.id)) {
      return `left ${file.path} alone: it was replaced while init ran`;
    }
    const bytes = readAllFrom0(fd, file.bytes.length);
    if (bytes === null || !bytes.equals(file.bytes)) {
      return `left ${file.path} alone: its contents changed while init ran`;
    }
    const now = pathId(file.path);
    if (now === null || !sameId(now, file.id)) {
      return `left ${file.path} alone: it was replaced while init ran`;
    }
    unlinkSync(file.path);
    return null;
  } catch (err) {
    return `${file.path} (cleanup failed: ${(err as Error).message})`;
  } finally {
    closeSync(fd);
  }
}

/** `rmdir` each directory, deepest first; a directory that is not empty stays. */
function removeEmptyDirs(dirs: readonly string[]): void {
  for (const dir of dirs) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}
