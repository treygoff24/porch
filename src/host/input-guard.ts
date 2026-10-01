// Ported from ~/Code/loom/src/cockpit/input-guard.ts (c0c4b75), unchanged in behaviour.
/**
 * The split-escape fix (plan F6). OpenTUI's stdin parser waits a fixed 20 ms after a bare `ESC` or
 * `ESC [` before it decides the bytes are a key of their own (Escape, or Alt-`[`). Over mosh, and
 * through herdr, the rest of a sequence can arrive later than that (measured: 55 ms on the Mac), so
 * an arrow key's `ESC [ A` becomes an Escape or an Alt-`[` followed by a typed `A`. That is a stray
 * letter in the draft.
 *
 * The same is true further along a sequence: a Delete (`ESC [ 3 ~`), a Home, a modified arrow
 * (`ESC [ 1 ; 5 C`) or a mouse report split after its first parameter loses its tail to the draft
 * the same way. So the held tail is any unfinished sequence, not just its first two bytes.
 *
 * This sits between the terminal and the renderer and holds back only the tail of a read that could
 * still be the start of a sequence (`ESC`, `ESC [` and its parameters so far, `ESC O`) for `holdMs`,
 * then lets it through as it is. If the rest arrives inside the hold the two reads are joined and the renderer sees one
 * whole sequence; if not, the renderer sees exactly what it would have seen without the guard,
 * `holdMs` late. Everything else passes through untouched and immediately, including a batched
 * `ab⏎cd⏎` (mosh) and a bracketed paste.
 */
import { PassThrough } from 'node:stream';

/** Long enough for a late sequence tail over mosh; short enough that a lone Escape still feels instant. */
export const HOLD_MS = 80;

const ESC = 0x1b;
const LBRACKET = 0x5b;
const O = 0x4f;

/** The longest unfinished sequence held: a mouse report or a kitty key with every parameter is well under this. */
const MAX_HELD = 32;

/**
 * How many bytes at the end of `data` could be the start of an escape sequence that is not finished:
 * a bare `ESC`, `ESC O` (its final byte is still to come), or `ESC [` with parameter and
 * intermediate bytes so far but no final byte. 0 when the read ends on a whole sequence or on text.
 */
export function pendingTail(data: Uint8Array): number {
  const n = data.length;
  for (let back = 1; back <= Math.min(n, MAX_HELD); back++) {
    const at = n - back;
    const byte = data[at] as number;
    if (byte === ESC) {
      if (back === 1) return 1;
      const kind = data[at + 1];
      if (kind === O) return back === 2 ? 2 : 0;
      if (kind !== LBRACKET) return 0;
      // Parameter bytes are 0x30-0x3f and intermediates 0x20-0x2f; the first byte outside them is the final one.
      for (let i = at + 2; i < n; i++) {
        const b = data[i] as number;
        if (b < 0x20 || b > 0x3f) return 0;
      }
      return back;
    }
    // A byte a sequence's tail cannot contain, and no ESC after it: nothing is pending.
    if ((byte < 0x20 || byte > 0x3f) && byte !== LBRACKET && byte !== O) return 0;
  }
  return 0;
}

export type Guarded = {
  /** The stream to give the renderer. */
  stdin: NodeJS.ReadStream;
  /** Stop reading the terminal and let anything held through. */
  dispose(): void;
};

export function guardStdin(real: NodeJS.ReadStream, opts: { holdMs?: number } = {}): Guarded {
  const holdMs = opts.holdMs ?? HOLD_MS;
  // Raw mode as the shell left it: a renderer that dies part-way through starting may have turned
  // it on and never turned it off, so giving the input back puts it as it was.
  const wasRaw = real.isRaw === true;
  const out = new PassThrough();
  let held: Buffer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const release = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (held !== undefined) {
      const bytes = held;
      held = undefined;
      out.write(bytes);
    }
  };

  const onData = (chunk: Buffer | string) => {
    let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (held !== undefined) {
      data = Buffer.concat([held, data]);
      held = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
    const tail = pendingTail(data);
    if (tail > 0) {
      held = Buffer.from(data.subarray(data.length - tail));
      data = data.subarray(0, data.length - tail);
      timer = setTimeout(release, holdMs);
      timer.unref();
    }
    if (data.length > 0) out.write(data);
  };

  real.on('data', onData);
  // A stream someone paused (a prompt read before the screen started) stays paused when a 'data'
  // listener is added; the guard reads the terminal from here on, so it starts the flow itself.
  real.resume();
  const stdin = out as unknown as NodeJS.ReadStream & { isRaw?: boolean };
  Object.assign(stdin, {
    isTTY: real.isTTY,
    setRawMode(mode: boolean) {
      real.setRawMode?.(mode);
      return stdin;
    },
    ref() {
      real.ref?.();
      return stdin;
    },
    unref() {
      real.unref?.();
      return stdin;
    },
  });
  Object.defineProperty(stdin, 'isRaw', { get: () => real.isRaw });
  return {
    stdin,
    dispose() {
      release();
      real.off('data', onData);
      if (real.isTTY && (real.isRaw === true) !== wasRaw) real.setRawMode?.(wasRaw);
      real.pause();
      out.end();
    },
  };
}
