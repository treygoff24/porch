/**
 * The split-escape guard (plan F6 in Loom), ported with its tests from
 * `~/Code/loom/test/cockpit-input.test.ts:34-157` (c0c4b75). The bytes go through the real OpenTUI
 * stdin parser behind the guard, not around it: an arrow key whose tail arrives after OpenTUI's
 * 20 ms parser timeout becomes one key, not an Escape and a stray letter.
 */
import { PassThrough } from 'node:stream';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it } from 'vitest';
import { guardStdin, HOLD_MS, pendingTail } from '../src/host/input-guard.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ttyLike(): NodeJS.ReadStream {
  const real = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(real, {
    isTTY: true,
    setRawMode: () => real,
    ref: () => real,
    unref: () => real,
  });
  return real;
}

describe('the split-escape guard', () => {
  it('says when a read ends where a sequence may continue', () => {
    const b = (s: string) => Buffer.from(s, 'latin1');
    expect(pendingTail(b('abc'))).toBe(0);
    expect(pendingTail(b('abc\x1b'))).toBe(1);
    expect(pendingTail(b('abc\x1b['))).toBe(2);
    expect(pendingTail(b('abc\x1bO'))).toBe(2);
    expect(pendingTail(b('\x1b[A'))).toBe(0);
    expect(pendingTail(b(''))).toBe(0);
    // Unfinished further along: parameters so far and no final byte yet.
    expect(pendingTail(b('\x1b[3'))).toBe(3);
    expect(pendingTail(b('ab\x1b[1;'))).toBe(4);
    expect(pendingTail(b('\x1b[<35;12'))).toBe(8);
    expect(pendingTail(b('\x1b[200~text\x1b[20'))).toBe(4);
    // Whole sequences, and text that only looks like the start of one, are not held.
    expect(pendingTail(b('\x1b[3~'))).toBe(0);
    expect(pendingTail(b('\x1b[1;5C'))).toBe(0);
    expect(pendingTail(b('\x1bOP'))).toBe(0);
    expect(pendingTail(b('a[3'))).toBe(0);
    expect(pendingTail(b('\x1bx[3'))).toBe(0);
    // A run of parameter bytes with no ESC in reach is not a sequence, and is never held forever.
    expect(pendingTail(b(`\x1b[${'1;'.repeat(20)}`))).toBe(0);
  });

  it('reads a terminal stream that something paused before the guard took it', async () => {
    const real = ttyLike();
    // A prompt that read a line and paused stdin, as the arm question does before the screen.
    real.on('data', () => {});
    real.pause();
    expect(real.isPaused()).toBe(true);
    const g = guardStdin(real, { holdMs: 10 });
    const out: string[] = [];
    g.stdin.on('data', (d: Buffer) => out.push(d.toString('latin1')));
    real.write('typed');
    await sleep(30);
    g.dispose();
    expect(out.join('')).toBe('typed');
  });

  async function reads(steps: Array<string | number>, holdMs = 40): Promise<string[]> {
    const real = ttyLike();
    const g = guardStdin(real, { holdMs });
    const out: string[] = [];
    g.stdin.on('data', (d: Buffer) => out.push(d.toString('latin1')));
    for (const step of steps) {
      if (typeof step === 'number') await sleep(step);
      else real.write(step);
    }
    await sleep(holdMs * 3);
    g.dispose();
    return out;
  }

  it('joins the two halves of a sequence that arrive apart', async () => {
    expect(await reads(['\x1b[', 20, 'A'])).toEqual(['\x1b[A']);
    expect(await reads(['xy\x1b', 15, '[D'])).toEqual(['xy', '\x1b[D']);
    expect(await reads(['\x1b', 15, 'x'])).toEqual(['\x1bx']);
  });

  it('lets a lone escape through after the hold, as the renderer would have seen it', async () => {
    expect(await reads(['\x1b'])).toEqual(['\x1b']);
    expect(await reads(['\x1b[', 150, 'A'])).toEqual(['\x1b[', 'A']);
  });

  it('passes everything else straight through: a batched Enter, a paste, a whole sequence', async () => {
    expect(await reads(['ab\rcd\r'])).toEqual(['ab\rcd\r']);
    expect(await reads(['\x1b[200~one\ntwo\x1b[201~'])).toEqual(['\x1b[200~one\ntwo\x1b[201~']);
    expect(await reads(['\x1b[1;5C'])).toEqual(['\x1b[1;5C']);
  });

  async function keysFor(
    first: string,
    gap: number,
    second: string,
    guarded: boolean,
  ): Promise<string[]> {
    const real = ttyLike();
    const g = guarded ? guardStdin(real) : undefined;
    const t = await createTestRenderer({ width: 20, height: 5, stdin: g?.stdin ?? real });
    const keys: string[] = [];
    t.renderer.keyInput.on('keypress', (k) => {
      keys.push(`${k.ctrl ? 'C-' : ''}${k.meta ? 'M-' : ''}${k.name}`);
    });
    real.write(first);
    await sleep(gap);
    real.write(second);
    await sleep(250);
    t.renderer.destroy();
    g?.dispose();
    return keys;
  }

  it('turns an arrow whose tail arrived late into one key, not a stray letter (through the real parser)', async () => {
    // Without the guard OpenTUI's parser gives up after 20 ms and the arrow becomes a lone `a`.
    expect(await keysFor('\x1b[', 40, 'A', false)).toEqual(['a']);
    expect(await keysFor('\x1b[', 40, 'A', true)).toEqual(['up']);
    // Late by more than the guard holds: back to what the renderer would have done alone.
    expect(HOLD_MS).toBeLessThan(200);
  });

  it('a mouse report split across reads is never typed into the draft, and what follows it still is', async () => {
    // SGR reports: ESC [ < button ; column ; row M. The parser keeps the rest of a split one
    // waiting (no timeout), so no digit or semicolon reaches the composer.
    const split = [
      ['\x1b[<35;12', ';5M'],
      ['\x1b[<0;1', '2;5M'],
      ['\x1b[<35;12;', '5M'],
    ] as const;
    for (const [first, second] of split) {
      expect(await keysFor(first, 40, second, true), JSON.stringify(first)).toEqual([]);
    }
    // A key right behind the report is a key: nothing was swallowed with it.
    expect(await keysFor('\x1b[<35;12', 40, ';5Mq', true)).toEqual(['q']);
  });

  it('does the same for a sequence split after its first parameter: Delete, PageUp, a Ctrl-arrow', async () => {
    for (const [first, second, key] of [
      ['\x1b[3', '~', 'delete'],
      ['\x1b[1', ';5C', 'C-right'],
      ['\x1b[1;5', 'D', 'C-left'],
      ['\x1b[5', '~', 'pageup'],
    ] as const) {
      const alone = await keysFor(first, 40, second, false);
      expect(alone, `without the guard, ${JSON.stringify(first)}`).not.toEqual([key]);
      expect(await keysFor(first, 40, second, true), `${JSON.stringify(first)}`).toEqual([key]);
    }
  });
});
