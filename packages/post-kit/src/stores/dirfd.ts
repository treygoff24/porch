/**
 * A held directory and file operations relative to it, the Node equivalent of Python's `dir_fd=`
 * calls in porch-tui's `drafts.py`. Node has no `openat` family, so on Linux every operation goes
 * through `/proc/self/fd/<fd>/<name>`: the kernel resolves that path through the held descriptor,
 * so a directory renamed or replaced by a symlink after the walk cannot redirect a write. Only the
 * final `<name>` is looked up by name, and `O_NOFOLLOW` guards it exactly as in Python.
 *
 * Where `/proc/self/fd` does not exist (macOS), there is no way to name a file through the held
 * descriptor, and a path-based write could be redirected by a directory swapped in after the check.
 * So there every write is refused ({@link WRITES_UNAVAILABLE}; coordinator ruling, 2026-09-30) until
 * descriptor-relative operations exist, and the stores run read-only. Reads still work: they go
 * through the directory's path after checking that it still names the held directory (device and
 * inode), which narrows the race to a read of the wrong file, never a write.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const PROC = existsSync('/proc/self/fd');

/**
 * Why this process cannot write through a held directory, or `null` when it can. Fixed for the
 * process's lifetime.
 */
export const WRITES_UNAVAILABLE: string | null = PROC
  ? null
  : 'this system has no /proc/self/fd, so porch-next cannot write through a held directory';

const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_RDWR |
  constants.O_CREAT |
  constants.O_TRUNC |
  constants.O_APPEND;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

function checkName(name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new UnsafePathError(`unsafe file name: ${JSON.stringify(name)}`);
  }
  return name;
}

function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

export class DirHandle {
  private closed = false;
  readonly fd: number;
  /** The directory's absolute path, for messages and the non-Linux fallback. */
  readonly path: string;

  private constructor(fd: number, path: string) {
    this.fd = fd;
    this.path = path;
  }

  /**
   * Walk `absPath` from `/` one component at a time, each opened `O_DIRECTORY|O_NOFOLLOW` relative
   * to the one before, as porch-tui's `_directory_fd` does. With `createLast`, the last component is
   * created (mode `createMode`, subject to the umask) and its parent is fsynced even when it already
   * existed, since an earlier process may have died between the mkdir and the fsync.
   */
  static walk(absPath: string, options: { createLast?: boolean; createMode?: number } = {}) {
    if (!absPath.startsWith('/')) throw new UnsafePathError('directory must be absolute');
    const parts = absPath.split('/').filter((p) => p !== '');
    for (const part of parts) {
      if (part === '.' || part === '..') throw new UnsafePathError('unsafe directory component');
    }
    let handle = new DirHandle(openSync('/', DIR_FLAGS), '/');
    try {
      parts.forEach((part, index) => {
        if (index === parts.length - 1 && options.createLast === true) {
          handle.refuseWrite(part);
          try {
            mkdirSync(handle.entry(part), options.createMode ?? 0o700);
          } catch (err) {
            if (!isCode(err, 'EEXIST')) throw err;
          }
          fsyncSync(handle.fd);
        }
        const childPath = handle.path === '/' ? `/${part}` : `${handle.path}/${part}`;
        const child = new DirHandle(openSync(handle.entry(part), DIR_FLAGS), childPath);
        handle.close();
        handle = child;
      });
      return handle;
    } catch (err) {
      handle.close();
      throw err;
    }
  }

  /** The path through which an operation on `name` in this directory is made. */
  entry(name: string): string {
    checkName(name);
    if (this.closed) throw new Error('directory handle is closed');
    if (PROC) return `/proc/self/fd/${this.fd}/${name}`;
    const held = fstatSync(this.fd);
    const now = lstatSync(this.path);
    if (!now.isDirectory() || now.dev !== held.dev || now.ino !== held.ino) {
      throw new UnsafePathError(`${this.path} changed while it was held`);
    }
    return this.path === '/' ? `/${name}` : `${this.path}/${name}`;
  }

  /** Throw unless a write through this handle can be made relative to its descriptor. */
  private refuseWrite(name: string): void {
    if (WRITES_UNAVAILABLE !== null) {
      throw new UnsafePathError(
        `refusing to write ${this.path === '/' ? '' : this.path}/${name}: ${WRITES_UNAVAILABLE}`,
      );
    }
  }

  /** `open(name, flags | O_NOFOLLOW, mode, dir_fd=…)`. Opening for writing is a write. */
  open(name: string, flags: number, mode = 0o600): number {
    if ((flags & WRITE_FLAGS) !== 0) this.refuseWrite(name);
    return openSync(this.entry(name), flags | constants.O_NOFOLLOW, mode);
  }

  mkdir(name: string, mode: number): void {
    this.refuseWrite(name);
    mkdirSync(this.entry(name), mode);
  }

  /** `os.replace(a, b, src_dir_fd=…, dst_dir_fd=…)`. */
  rename(from: string, to: string): void {
    this.refuseWrite(to);
    renameSync(this.entry(from), this.entry(to));
  }

  /** `os.link(a, b, …, follow_symlinks=False)`: fails with EEXIST rather than replacing `b`. */
  link(from: string, to: string): void {
    this.refuseWrite(to);
    linkSync(this.entry(from), this.entry(to));
  }

  unlink(name: string): void {
    this.refuseWrite(name);
    unlinkSync(this.entry(name));
  }

  /** Unlink, treating an already-missing file as done. */
  unlinkIfPresent(name: string): void {
    try {
      this.unlink(name);
    } catch (err) {
      if (!isCode(err, 'ENOENT')) throw err;
    }
  }

  list(): string[] {
    if (PROC) return readdirSync(`/proc/self/fd/${this.fd}`);
    this.entry('x');
    return readdirSync(this.path);
  }

  fsync(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/**
 * porch-tui's `_private_file`: a regular file owned by this user, with no group or other permission
 * bits, and exactly `links` hard links.
 */
export function assertPrivateFile(fd: number, links = 1, what = 'draft state'): void {
  const info = fstatSync(fd);
  const uid = process.getuid?.();
  if (
    !info.isFile() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0 ||
    info.nlink !== links
  ) {
    throw new UnsafePathError(`${what} must be an owner-only regular file`);
  }
}

/**
 * A shared log's check: a regular file owned by this user with exactly one link. Unlike
 * {@link assertPrivateFile} the mode is not checked, since porch-tui creates the decision log with
 * the umask's default mode.
 */
export function assertOwnedRegularFile(fd: number, what: string): void {
  const info = fstatSync(fd);
  const uid = process.getuid?.();
  if (!info.isFile() || (uid !== undefined && info.uid !== uid) || info.nlink !== 1) {
    throw new UnsafePathError(`${what} must be a regular file you own, with one link`);
  }
}

/** porch-tui's check on the drafts directory itself: owned by this user and mode 0700. */
export function assertPrivateDirectory(handle: DirHandle, what = 'draft directory'): void {
  const info = fstatSync(handle.fd);
  const uid = process.getuid?.();
  if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new UnsafePathError(`${what} must be owned by you and mode 0700`);
  }
}

export { isCode };
