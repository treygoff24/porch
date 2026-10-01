/**
 * `bin/porch-next --demo` under a real pty (`pty_run.py`, Loom's pattern), for the tests that need
 * what a terminal is actually sent: OpenTUI's native library writes to the terminal itself, so only
 * a pty shows it. `PORCH_GRID_DUMP` points at a file in the run's temporary directory, so a step can
 * wait for the first frame (`ready`) and snapshot the grid the app last painted (`snapshot`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unicode11 from '@xterm/addon-unicode11';
import xterm from '@xterm/headless';
import { expect } from 'vitest';
import { POP_TITLE, PUSH_TITLE, RESTORE_SEQUENCE } from '../../src/host/terminal.ts';

export const python = spawnSync('python3', ['--version']).status === 0;
const root = join(import.meta.dirname, '..', '..');

export type Tty = { icanon: boolean; echo: boolean } | null | undefined;
export type Run = {
  exit: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Everything written to the terminal, as bytes, and as latin1 text for escape matching. */
  raw: Buffer;
  bytes: string;
  marks: Record<string, number>;
  tty: Record<string, Tty>;
  resizes: [number, number, number][];
  files: Record<string, string | null>;
  cols: number;
  rows: number;
};

export type Step = Record<string, unknown>;

/** A run's steps, built with the dump file's path in hand. */
export type Script = (dump: string) => Step[];

const made: string[] = [];

/** Remove the runs' temporary directories (call from `afterAll`). */
export function cleanUp(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Wait for the first frame that shows the demo's bot. */
export const ready = (dump: string): Step => ({ waitFile: dump, contains: 'TEST BOT', ms: 20_000 });

/** Record the output so far and the grid last painted, under `name`. */
export const snapshot = (dump: string, name: string): Step => ({ file: name, path: dump });

export async function underPty(
  script: Script,
  opts: { env?: Record<string, string>; cols?: number; rows?: number } = {},
): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'porch-pty-'));
  made.push(dir);
  const out = join(dir, 'out.bin');
  const dump = join(dir, 'grid.json');
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 32;
  const child = spawn(
    'python3',
    [
      join(root, 'test/setup/pty_run.py'),
      '--cols',
      String(cols),
      '--rows',
      String(rows),
      '--out',
      out,
      '--script',
      JSON.stringify(script(dump)),
      '--timeout',
      '45',
      '--',
      join(root, 'bin/porch-next'),
      '--demo',
    ],
    {
      cwd: root,
      // The terminal is pinned, not inherited: OpenTUI reads COLORTERM to choose true colour over
      // the 256-colour palette, so a caller without it (a cell, CI) would draw every cell with a
      // palette foreground and the paste check below could not tell inert text from a recolour.
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PORCH_GRID_DUMP: dump,
        ...opts.env,
      },
    },
  );
  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  await new Promise((resolve) => child.on('close', resolve));
  const report = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Omit<
    Run,
    'raw' | 'bytes' | 'cols' | 'rows'
  >;
  const raw = readFileSync(out);
  return { ...report, raw, bytes: raw.toString('latin1'), cols, rows };
}

const ESC = String.fromCharCode(27);

/** How many times `seq` occurs in `bytes`. */
export function count(bytes: string, seq: string | RegExp): number {
  return typeof seq === 'string' ? bytes.split(seq).length - 1 : (bytes.match(seq) ?? []).length;
}

/** The kitty keyboard mode's stack: a push is `CSI > flags u`, a pop `CSI < n u`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the subject
export const KITTY_PUSH = /\x1b\[>\d*u/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the subject
export const KITTY_POP = /\x1b\[<\d*u/g;

/**
 * An answer to OpenTUI's kitty keyboard query (`CSI ? u`), as a terminal with the protocol gives
 * it: steps for a run that should see the mode pushed.
 */
export const answerKittyQuery: Step[] = [{ waitFor: '\x1b[?u', ms: 20_000 }, { send: '\x1b[?0u' }];

/** Whether a private mode ended up on, by the last set or reset of it. */
export function modeOn(bytes: string, mode: number): boolean | undefined {
  let on: boolean | undefined;
  for (const m of bytes.matchAll(new RegExp(`${ESC}\\[\\?${mode}([hl])`, 'g'))) on = m[1] === 'h';
  return on;
}

/** What is left once every escape sequence is taken out: what a person would read. */
export function printable(bytes: string): string {
  const escapes = (tail: string) => new RegExp(`${ESC}${tail}`, 'g');
  return bytes
    .replace(escapes('\\][^\x07\x1b]*(?:\x07|\x1b\\\\)'), '')
    .replace(escapes('\\[[0-9;?<>=]*[ -/]*[@-~]'), '')
    .replace(escapes('[()][0-9A-Za-z]'), '')
    .replace(escapes('[=>78]'), '');
}

export function expectTerminalGivenBack(run: Run, opts: { focusReports?: boolean } = {}): void {
  expect(run.timedOut).toBe(false);
  // Node's FFI warning is silenced: it would print over the first frame or after the last.
  expect(run.bytes).not.toContain('FFI is an experimental');
  // The screen was taken, with the mouse and focus reports on, and given back.
  expect(run.bytes).toContain('\x1b[?1049h');
  expect(run.bytes).toContain('\x1b[?1000h');
  // Focus reports go on once the renderer is shown; a start cut short by a signal never shows it.
  if (opts.focusReports !== false) expect(run.bytes).toContain('\x1b[?1004h');
  expect(modeOn(run.bytes, 1049)).toBe(false);
  for (const mode of [1000, 1002, 1003, 1004, 1006, 2004, 2027, 2031]) {
    expect(modeOn(run.bytes, mode), `mode ${mode}`).not.toBe(true);
  }
  expect(modeOn(run.bytes, 25)).toBe(true);
  // Every stack was popped exactly as often as it was pushed: the title once (Porch's), and the
  // kitty keyboard mode as often as OpenTUI pushed it (never, on a terminal that did not answer).
  expect(count(run.bytes, PUSH_TITLE), 'title pushes').toBe(1);
  expect(count(run.bytes, POP_TITLE), 'title pops').toBe(1);
  expect(count(run.bytes, KITTY_POP), 'kitty keyboard pops').toBe(count(run.bytes, KITTY_PUSH));
  // Porch's own restore went out, and it was the last thing written.
  expect(run.bytes.endsWith(RESTORE_SEQUENCE)).toBe(true);
  // Nothing readable follows the moment the alternate screen was left.
  const leave = run.bytes.lastIndexOf('\x1b[?1049l');
  expect(printable(run.bytes.slice(leave))).toBe('');
  // The terminal is cooked again (line editing and echo), as the shell left it.
  expect(run.tty.end).toEqual({ icanon: true, echo: true });
}

/**
 * A terminal emulator (xterm.js, headless) fed the run's output: up to byte `upTo`, resized where
 * the pty was. This is what a terminal would show, independent of what the app thinks it drew. It
 * measures with Unicode 11 widths, as current terminals do: xterm.js's default, Unicode 6, counts
 * most emoji as one column where the grid (`string-width`) and a modern terminal count two.
 */
export async function emulate(run: Run, upTo = run.raw.length): Promise<xterm.Terminal> {
  const term = new xterm.Terminal({ cols: run.cols, rows: run.rows, allowProposedApi: true });
  term.loadAddon(new unicode11.Unicode11Addon());
  term.unicode.activeVersion = '11';
  let at = 0;
  const feed = (end: number) =>
    new Promise<void>((resolve) => {
      const chunk = run.raw.subarray(at, end);
      at = end;
      term.write(chunk, resolve);
    });
  for (const [offset, cols, rows] of run.resizes) {
    // A resize recorded at the snapshot's own offset came after it: the steps run in order.
    if (offset >= upTo) break;
    await feed(offset);
    term.resize(cols, rows);
  }
  await feed(upTo);
  return term;
}

/**
 * The emulator's visible screen, one string per row, trailing spaces trimmed. Each row is read to
 * the terminal's width only: after a shrink xterm.js keeps the cut-off cells in the line.
 */
export function screenOf(term: xterm.Terminal): string[] {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++)
    lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true, 0, term.cols) ?? '');
  return lines.map((l) => l.trimEnd());
}

/** A frame the app dumped: the grid last painted, and OpenTUI's render passes so far. */
export type Dumped = { cols: number; rows: number; passes: number; text: string };

/** The grid a snapshot recorded, rows trimmed the same way. */
export function dumped(run: Run, name: string): Dumped & { lines: string[] } {
  const raw = run.files[name];
  if (raw === null || raw === undefined) throw new Error(`no grid dump for ${name}`);
  const d = JSON.parse(raw) as Dumped;
  return { ...d, lines: d.text.split('\n').map((l) => l.trimEnd()) };
}
