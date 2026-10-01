/**
 * The terminal boundary, checked from the terminal's side (T1 addendum item 3). `bin/porch-next
 * --demo` runs under a real pty; everything it writes is fed into a terminal emulator (xterm.js,
 * headless), and the emulator's screen must equal the grid the app last painted (`grid.toText()`,
 * dumped by `PORCH_GRID_DUMP`) at each snapshot. The host writes only the cells that changed since
 * the previous frame, so this is where a diffing mistake, a ghost half of a wide glyph, or a stale
 * cell after a resize would show.
 *
 * Covered: repeated updates to the same cells; CJK and emoji replaced by ASCII and the reverse,
 * including wide glyphs shifted one column so every old half is straddled; a resize smaller and
 * then larger; a bracketed paste (line breaks, a tab, and an escape sequence, which must reach the
 * screen as U+FFFD and text, never as a colour change); focus reports; and exit, which leaves the
 * emulator on its normal screen with every mode off.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanUp,
  dumped,
  emulate,
  expectTerminalGivenBack,
  python,
  type Run,
  ready,
  screenOf,
  snapshot,
  underPty,
} from './setup/pty.ts';

afterAll(cleanUp);

const SETTLE = { wait: 400 };
const CLEAR = { send: '\x15' }; // Ctrl+U

async function expectScreenMatchesGrid(run: Run, name: string) {
  const grid = dumped(run, name);
  const term = await emulate(run, run.marks[name]);
  expect({ cols: term.cols, rows: term.rows }, name).toEqual({ cols: grid.cols, rows: grid.rows });
  expect(screenOf(term), name).toEqual(grid.lines);
  return { grid, term };
}

describe.skipIf(!python)('what a terminal shows equals the grid', () => {
  it('through updates, wide glyphs, resizes, a paste, focus, and exit', async () => {
    const run = await underPty(
      (dump) => [
        ready(dump),
        SETTLE,
        snapshot(dump, 'first'),
        // The same cells, over and over: type, erase, retype, and a hop's frames.
        { send: 'abc' },
        { send: '\x7f\x7f\x7f' },
        { send: 'xyz' },
        { send: '\x7f' },
        { send: 'Z' },
        SETTLE,
        snapshot(dump, 'retyped'),
        { send: '\r' },
        { wait: 1500 },
        snapshot(dump, 'hopped'),
        // Wide over narrow, narrow over wide, and wide shifted by one column over wide.
        { send: '日本語🙂字' },
        SETTLE,
        snapshot(dump, 'wide'),
        CLEAR,
        { send: 'abcdefghijkl' },
        SETTLE,
        snapshot(dump, 'narrow'),
        CLEAR,
        { send: '日本語🙂字' },
        SETTLE,
        CLEAR,
        { send: 'x日本🙂語字' },
        SETTLE,
        snapshot(dump, 'shifted'),
        { send: '\x7f\x7f' },
        SETTLE,
        snapshot(dump, 'erased'),
        // Smaller (the compact layout), then larger than the start.
        { resize: [44, 22] },
        { wait: 700 },
        snapshot(dump, 'small'),
        { resize: [110, 36] },
        { wait: 700 },
        snapshot(dump, 'large'),
        // A bracketed paste with a line break, a tab and an escape sequence inside it.
        CLEAR,
        { send: '\x1b[200~hello\nworld\tTAB\x1b[31mred\x1b[201~' },
        SETTLE,
        snapshot(dump, 'pasted'),
        // Focus reports: away, then back.
        { send: '\x1b[O' },
        SETTLE,
        snapshot(dump, 'away'),
        { send: '\x1b[I' },
        SETTLE,
        snapshot(dump, 'back'),
        { send: '\x03' },
      ],
      { cols: 80, rows: 28 },
    );
    expect(run.exit).toBe(0);

    for (const name of ['first', 'retyped', 'hopped', 'wide', 'narrow', 'shifted', 'erased'])
      await expectScreenMatchesGrid(run, name);
    expect(dumped(run, 'retyped').text).toContain('▸ xyZ');
    expect(dumped(run, 'wide').text).toContain('▸ 日本語🙂字');
    expect(dumped(run, 'narrow').text).toContain('▸ abcdefghijkl');
    expect(dumped(run, 'shifted').text).toContain('▸ x日本🙂語字');
    expect(dumped(run, 'erased').text).toContain('▸ x日本🙂 ');

    const small = await expectScreenMatchesGrid(run, 'small');
    expect(small.grid.cols).toBe(44);
    const large = await expectScreenMatchesGrid(run, 'large');
    expect(large.grid.cols).toBe(110);
    // The larger frame is the full layout again, drawn everywhere: no cell of the compact one left.
    expect(large.grid.text).toContain('1UP');

    const pasted = await expectScreenMatchesGrid(run, 'pasted');
    // The tab advances to the next multiple of four columns from where the text started (12).
    expect(pasted.grid.text).toContain('▸ hello world TAB\ufffd[31mred');
    // The escape reached the screen as a replacement mark: nothing after it turned red.
    const row = pasted.grid.lines.findIndex((l) => l.includes('hello world'));
    const line = pasted.term.buffer.active.getLine(pasted.term.buffer.active.viewportY + row);
    const col = pasted.grid.lines[row]?.indexOf('red') ?? -1;
    expect(col).toBeGreaterThan(0);
    const cell = line?.getCell(col);
    expect(cell?.getChars()).toBe('r');
    expect(cell?.isFgPalette()).toBe(false);

    const away = await expectScreenMatchesGrid(run, 'away');
    expect(away.grid.text).toContain('AWAY');
    const back = await expectScreenMatchesGrid(run, 'back');
    expect(back.grid.text).not.toContain('AWAY');

    // Exit: the emulator is back on its normal screen, blank, with every mode off.
    const end = await emulate(run);
    expect(end.buffer.active.type).toBe('normal');
    expect(screenOf(end).every((l) => l === '')).toBe(true);
    expect(end.modes).toMatchObject({
      bracketedPasteMode: false,
      mouseTrackingMode: 'none',
      sendFocusMode: false,
      synchronizedOutputMode: false,
    });
    expectTerminalGivenBack(run);
  }, 90_000);
});
