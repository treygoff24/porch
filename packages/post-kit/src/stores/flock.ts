/**
 * The exclusive `flock(2)` porch-tui takes on its drafts lock and its decision-record log, called
 * through Node's built-in FFI (`node:ffi`, Node 26.1+). Node has no `flock` of its own, and an
 * `fcntl` or lockfile scheme would not exclude porch-tui, which uses `fcntl.flock` (BSD locks on the
 * open file description). Both apps may run at once, so the lock must be the same kind.
 *
 * Checked on this Linux box (2026-09-30, Node 26.10): a lock taken here blocks Python's
 * `fcntl.flock(LOCK_EX|LOCK_NB)` with EAGAIN, and Python's lock blocks this one. macOS uses the same
 * lock constants and resolves `flock` and `__error` from the process image; that path is written
 * but not yet run on a Mac.
 *
 * When FFI is unavailable, {@link loadFlock} says so and callers must not write: drafts become
 * read-only with a sticky notice (build plan I4).
 */
import { createRequire } from 'node:module';

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EINTR = 4;

export type TryLock = 'locked' | 'busy';

export interface Flocker {
  /** One non-blocking attempt at an exclusive lock on `fd`. Throws on any error but contention. */
  tryExclusive(fd: number): TryLock;
  unlock(fd: number): void;
}

export type FlockAvailability =
  | { readonly ok: true; readonly flocker: Flocker }
  | { readonly ok: false; readonly reason: string };

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

let cached: FlockAvailability | undefined;

type Ffi = typeof import('node:ffi');

function platformNames(): { errno: string; wouldBlock: number } | null {
  if (process.platform === 'linux') return { errno: '__errno_location', wouldBlock: 11 };
  if (process.platform === 'darwin') return { errno: '__error', wouldBlock: 35 };
  return null;
}

/** Resolve libc's `flock` once. Never throws: an unavailable lock is a reported state. */
export function loadFlock(): FlockAvailability {
  if (cached !== undefined) return cached;
  cached = resolve();
  return cached;
}

function resolve(): FlockAvailability {
  const names = platformNames();
  if (names === null) return { ok: false, reason: `flock is not wired for ${process.platform}` };
  let ffi: Ffi;
  try {
    ffi = createRequire(import.meta.url)('node:ffi') as Ffi;
  } catch (err) {
    return { ok: false, reason: `node:ffi is unavailable: ${(err as Error).message}` };
  }
  try {
    const { functions } = ffi.dlopen(null, {
      flock: { arguments: ['i32', 'i32'], return: 'i32' },
      [names.errno]: { arguments: [], return: 'pointer' },
    });
    const flock = functions.flock as unknown as (fd: number, op: number) => number;
    const errnoAt = functions[names.errno] as unknown as () => bigint;
    const errno = () => ffi.getInt32(errnoAt(), 0);
    const call = (fd: number, op: number): number => {
      for (;;) {
        if (flock(fd, op) === 0) return 0;
        // Read errno straight after the call, before anything else can run on this thread.
        const e = errno();
        if (e !== EINTR) return e;
      }
    };
    const flocker: Flocker = {
      tryExclusive(fd) {
        const e = call(fd, LOCK_EX | LOCK_NB);
        if (e === 0) return 'locked';
        if (e === names.wouldBlock) return 'busy';
        throw new Error(`flock failed with errno ${e}`);
      },
      unlock(fd) {
        const e = call(fd, LOCK_UN);
        if (e !== 0) throw new Error(`flock unlock failed with errno ${e}`);
      },
    };
    return { ok: true, flocker };
  } catch (err) {
    return { ok: false, reason: `libc flock could not be resolved: ${(err as Error).message}` };
  }
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Poll for an exclusive lock, as porch-tui's drafts lock does (every 20 ms, for 3 s by default),
 * without blocking the event loop.
 */
export async function lockExclusive(
  flocker: Flocker,
  fd: number,
  options: { timeoutMs: number; pollMs?: number; message: string },
): Promise<void> {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    if (flocker.tryExclusive(fd) === 'locked') return;
    if (performance.now() >= deadline) throw new LockTimeoutError(options.message);
    await sleep(options.pollMs ?? 20);
  }
}
