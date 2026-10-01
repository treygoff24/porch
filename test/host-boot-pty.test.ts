/**
 * The real launcher, `bin/porch-next --demo`, under a real pty (`test/setup/pty.ts`): leaving gives
 * the terminal back completely on Esc, Ctrl+C, SIGTERM and SIGHUP (the alternate screen left, every
 * mode off, the cursor shown, the line discipline cooked, nothing readable after the restore, and
 * every stack popped exactly as often as it was pushed), and at rest the app runs no render passes
 * and writes zero bytes (ruling 4).
 *
 * Render passes are counted, not just bytes, because OpenTUI writes nothing for a pass in which no
 * cell changed: a renderer left running continuously would be silent on the wire and still wake the
 * process 30 times a second. The count comes from this production startup path (`runScene`, through
 * `PORCH_GRID_DUMP`), not from a host mounted by a test helper.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  answerKittyQuery,
  cleanUp,
  count,
  dumped,
  expectTerminalGivenBack,
  KITTY_POP,
  KITTY_PUSH,
  python,
  type Run,
  ready,
  snapshot,
  underPty,
} from './setup/pty.ts';

const passes = (run: Run, name: string) => dumped(run, name).passes;

afterAll(cleanUp);

describe.skipIf(!python)('porch-next --demo under a real terminal', () => {
  it.concurrent('a signal during a slow start still leaves the shell title restored last', async () => {
    // The renderer takes longer than LATE_START_MS to start; its teardown then writes an empty
    // title, which must come before Porch pops the title it pushed, never after.
    const run = await underPty(
      () => [{ waitFor: '\x1b]2;porch\x07', ms: 20_000 }, { signal: 'TERM' }],
      {
        env: { PORCH_START_DELAY_MS: '4500' },
      },
    );
    expect(run.exit).toBe(0);
    expect(run.bytes).toContain('\x1b[?1049h');
    expectTerminalGivenBack(run, { focusReports: false });
  }, 90_000);

  it.concurrent('starts, renders nothing while idle, and quits on Esc giving the terminal back', async () => {
    const run = await underPty((dump) => [
      ready(dump),
      { wait: 300 },
      { probe: 'running' },
      snapshot(dump, 'idleFrom'),
      { wait: 2000 },
      snapshot(dump, 'idleTo'),
      { send: '\x1b' },
    ]);
    expect(run.exit).toBe(0);
    expect(run.tty.running).toEqual({ icanon: false, echo: false });
    expect(run.marks.idleTo).toBeGreaterThan(0);
    // The initial render happened, and then two idle seconds: no render pass and zero bytes.
    expect(passes(run, 'idleFrom')).toBeGreaterThanOrEqual(1);
    expect(passes(run, 'idleTo')).toBe(passes(run, 'idleFrom'));
    expect((run.marks.idleTo ?? 0) - (run.marks.idleFrom ?? 0)).toBe(0);
    expectTerminalGivenBack(run);
  }, 90_000);

  it.concurrent('renders only while a hop runs, then goes quiet again', async () => {
    const run = await underPty((dump) => [
      ready(dump),
      { wait: 300 },
      snapshot(dump, 'before'),
      { send: '\r' },
      { wait: 1600 },
      snapshot(dump, 'hopped'),
      { wait: 1500 },
      snapshot(dump, 'after'),
      { send: '\x03' },
    ]);
    expect(run.exit).toBe(0);
    const hop = run.bytes.slice(run.marks.before, run.marks.hopped);
    expect(count(hop, '\x1b[?2026h')).toBeGreaterThanOrEqual(3);
    expect(passes(run, 'hopped') - passes(run, 'before')).toBeGreaterThanOrEqual(3);
    // The burst has ended: no render pass and zero bytes since.
    expect(passes(run, 'after')).toBe(passes(run, 'hopped'));
    expect((run.marks.after ?? 0) - (run.marks.hopped ?? 0)).toBe(0);
    expectTerminalGivenBack(run);
  }, 90_000);

  it.concurrent('echoes typed input and quits on Ctrl+C', async () => {
    const run = await underPty((dump) => [
      ready(dump),
      { wait: 300 },
      { send: 'hello porch' },
      { waitFile: dump, contains: 'hello porch', ms: 5000 },
      { file: 'typed', path: dump },
      { send: '\x03' },
    ]);
    expect(run.exit).toBe(0);
    expect(run.files.typed).toContain('▸ hello porch');
    expectTerminalGivenBack(run);
  }, 90_000);

  it.concurrent('on a terminal with the kitty keyboard protocol, pops that mode once', async () => {
    const run = await underPty((dump) => [
      ...answerKittyQuery,
      ready(dump),
      { wait: 300 },
      { send: '\x1b' },
    ]);
    expect(run.exit).toBe(0);
    // OpenTUI pushed the mode (the terminal answered its query) and its teardown popped it; Porch's
    // restore does not pop it again.
    expect(count(run.bytes, KITTY_PUSH)).toBe(1);
    expect(count(run.bytes, KITTY_POP)).toBe(1);
    expectTerminalGivenBack(run);
  }, 90_000);

  it.concurrent('leaves on SIGTERM and SIGHUP the same way', async () => {
    for (const signal of ['TERM', 'HUP']) {
      const run = await underPty((dump) => [ready(dump), { wait: 300 }, { signal }]);
      expect(run.exit, signal).toBe(0);
      expect(run.signal, signal).toBeNull();
      expectTerminalGivenBack(run);
    }
  }, 90_000);
});
