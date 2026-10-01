import type { Stats } from 'node:fs';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';

/** Descriptor-relative calls preserve the Python store's no-follow parent walk on both hosts. */
async function loadNative() {
  const ffi = await import('node:ffi');
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Error('safe filesystem unavailable on this platform');
  const errnoName = process.platform === 'darwin' ? '__error' : '__errno_location';
  const handle = ffi.dlopen(null, {
    openat: { arguments: ['i32', 'string', 'i32', 'u32'], return: 'i32' },
    mkdirat: { arguments: ['i32', 'string', 'u32'], return: 'i32' },
    unlinkat: { arguments: ['i32', 'string', 'i32'], return: 'i32' },
  });
  const errnoFn = handle.lib.getFunction(errnoName, { arguments: [], return: 'pointer' });
  const errnoAddress = errnoFn() as bigint;
  return {
    ...handle.functions,
    ffi,
    errno: () => ffi.getInt32(errnoAddress),
  };
}
type Native = Awaited<ReturnType<typeof loadNative>>;
let native: Promise<Native> | undefined;
const libc = () => (native ??= loadNative());

function error(op: string, errno: number): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${op}: filesystem error ${errno}`);
  err.code = errno === 2 ? 'ENOENT' : errno === 17 ? 'EEXIST' : 'EUNSAFE';
  return err;
}

export function component(name: string): string {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    Buffer.byteLength(name) > 255 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject filesystem controls
    /[\u0000-\u001f\u007f-\u009f]/.test(name)
  )
    throw new Error('invalid path component');
  return name;
}

export function privateFile(fd: number, links = 1): Stats {
  const st = fstatSync(fd);
  if (
    !st.isFile() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o077) !== 0 ||
    st.nlink !== links
  )
    throw new Error('state must be an owner-only regular file with safe links');
  return st;
}

export function boundedRead(fd: number, limit: number): Buffer {
  const st = fstatSync(fd);
  if (!st.isFile() || st.size > limit) throw new Error('not a regular file within size limit');
  const data = Buffer.alloc(limit + 1);
  let n = 0;
  while (n <= limit) {
    const read = readSync(fd, data, n, data.length - n, null);
    if (read === 0) return data.subarray(0, n);
    n += read;
  }
  throw new Error('file exceeds size limit');
}

export class SafeDirectory {
  private constructor(
    readonly fd: number,
    private readonly native: Native,
  ) {}
  static async open(
    path: string,
    opts: { create?: boolean; private?: boolean } = {},
  ): Promise<SafeDirectory> {
    if (!isAbsolute(path)) throw new Error('directory must be absolute');
    const lib = await libc();
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let fd = openSync('/', flags);
    const parts = path.split('/').filter(Boolean);
    try {
      for (const [i, part] of parts.entries()) {
        component(part);
        if (opts.create && i === parts.length - 1) {
          if (lib.mkdirat(fd, part, 0o700) !== 0 && lib.errno() !== 17)
            throw error('mkdir', lib.errno());
          fsyncSync(fd);
        }
        const child = lib.openat(fd, part, flags, 0);
        if (child < 0) throw error('open directory', lib.errno());
        closeSync(fd);
        fd = child;
      }
      const st = fstatSync(fd);
      if (opts.private && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0))
        throw new Error('directory must be owned by you and mode 0700');
      return new SafeDirectory(fd, lib);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }
  open(name: string, flags = constants.O_RDONLY, mode = 0o600): number {
    const fd = this.native.openat(
      this.fd,
      component(name),
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      mode,
    );
    if (fd < 0) throw error('open file', this.native.errno());
    return fd;
  }
  names(): string[] {
    return readdirSync(`${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${this.fd}`);
  }
  unlink(name: string): void {
    if (this.native.unlinkat(this.fd, component(name), 0) !== 0)
      throw error('remove', this.native.errno());
  }
  sync(): void {
    fsyncSync(this.fd);
  }
  close(): void {
    closeSync(this.fd);
  }
}

export async function readSafeFile(path: string, limit: number): Promise<Buffer> {
  const at = path.lastIndexOf('/');
  const dir = await SafeDirectory.open(path.slice(0, at) || '/');
  try {
    const fd = dir.open(path.slice(at + 1));
    try {
      return boundedRead(fd, limit);
    } finally {
      closeSync(fd);
    }
  } finally {
    dir.close();
  }
}
