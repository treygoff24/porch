/**
 * Take the terminal, show a scene in a `GridHost`, and give the terminal back completely on every
 * way out. The order is Loom's (`~/Code/loom/src/cockpit/run.tsx:148-347`, Loom recon §1): refuse
 * without a terminal, guard stdin against split escapes, install the exit guard and the signal
 * handlers before the renderer exists, push the title, then create the renderer on the alternate
 * screen with the mouse on, and turn focus reports on.
 *
 * Giving back goes through one `TerminalHold`: the renderer's own teardown pops what it pushed (the
 * kitty keyboard mode), every mode is turned off (repeatable), and the title Porch pushed is popped
 * exactly once, however many ways out run. A signal that arrives while the renderer is still
 * starting keeps the handlers and the exit guard in place until that start settles (up to
 * `LATE_START_MS`), so a renderer that finishes starting is taken down by its own teardown before
 * the title is popped. One that takes longer keeps the terminal guarded until it arrives, and is
 * taken down the same way then.
 *
 * `PORCH_GRID_DUMP=<file>` (tests only) writes, after each of OpenTUI's render passes, the pass
 * count and the grid last painted (its size and `grid.toText()`), so the pty checks can count
 * render passes on this production path and compare what a terminal emulator shows with the grid.
 *
 * The renderer is never started in continuous mode: it draws a frame only when the host asks for
 * one (ruling 4).
 */
import { renameSync, writeFileSync } from 'node:fs';
import { type CliRenderer, type CliRendererConfig, createCliRenderer } from '@opentui/core';
import type { Grid } from '../grid/grid.ts';
import { GridHost, type Scene } from './grid-host.ts';
import { guardStdin } from './input-guard.ts';
import { FOCUS_REPORTS_ON, guardExit, holdTerminal, type ProcessEvents } from './terminal.ts';

/** Sets the window title once the old one is pushed (OSC 2). */
const SET_TITLE = '\x1b]2;porch\x07';

const SIGNALS: NodeJS.Signals[] = ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT'];

/** How long a renderer still starting when Porch is told to leave is given to finish. */
export const LATE_START_MS = 3000;

export type RunIo = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WritableStream;
  /** Where signals and crashes arrive (the process; tests pass a stand-in). */
  proc?: ProcessEvents;
  /** Makes the renderer (OpenTUI's `createCliRenderer`; tests pass a stand-in). */
  createRenderer?: (config: CliRendererConfig) => Promise<CliRenderer>;
};

/** Show `scene` until it quits or a signal arrives. Resolves to the process's exit code. */
export async function runScene(scene: Scene, io: RunIo = {}): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const proc: ProcessEvents = io.proc ?? process;
  const create = io.createRenderer ?? createCliRenderer;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    err.write('porch-next needs a terminal on stdin and stdout\n');
    return 2;
  }

  const guarded = guardStdin(stdin);
  const hold = holdTerminal((s) => {
    try {
      stdout.write(s);
    } catch {
      // The terminal is gone (a closed pty); there is nothing left to restore.
    }
  });
  let inputBack = false;
  const giveBack = () => {
    hold.giveBack();
    if (inputBack) return;
    inputBack = true;
    guarded.dispose();
  };
  let leave: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    leave = resolve;
  });
  // The terminal is protected before anything is turned on: a signal, a crash or an exit while the
  // renderer is still loading puts it back too. A repeated signal changes nothing.
  const guard = guardExit({ restore: giveBack, stderr: err, proc });
  const onSignal = () => leave?.();
  for (const sig of SIGNALS) proc.on(sig, onSignal);
  const unprotect = () => {
    for (const sig of SIGNALS) proc.off(sig, onSignal);
    guard.dispose();
  };

  hold.takeTitle(SET_TITLE);
  const config: CliRendererConfig = {
    stdin: guarded.stdin,
    stdout,
    exitOnCtrlC: false,
    // Signals are Porch's: the handlers above leave through the one teardown below.
    exitSignals: [],
    useMouse: true,
    screenMode: 'alternate-screen',
    targetFps: 30,
    backgroundColor: groundOf(scene),
    openConsoleOnError: false,
  };
  const starting = create(config);
  const started = await Promise.race([
    starting.then(
      (made) => ({ made }),
      (error: unknown) => ({ error }),
    ),
    exited.then(() => undefined),
  ]);
  if (started === undefined) {
    // Told to leave before the renderer was up. It is given a moment to finish starting, still
    // under the guard, so its own teardown pops what it pushed before the title is popped. One that
    // takes longer is taken down whenever it arrives.
    const late = await settled(starting, LATE_START_MS);
    if (late !== undefined) {
      hold.adopt(late);
      giveBack();
      unprotect();
      return 0;
    }
    // Still not up. The terminal stays guarded until it arrives, because its teardown writes an
    // empty title, which must come before the pop, never after it. Another signal in the meantime
    // leaves at once; the exit guard gives the terminal back on the way out.
    for (const sig of SIGNALS) proc.off(sig, onSignal);
    const leaveNow = () => proc.exit(0);
    for (const sig of SIGNALS) proc.on(sig, leaveNow);
    const finish = () => {
      giveBack();
      for (const sig of SIGNALS) proc.off(sig, leaveNow);
      guard.dispose();
    };
    void starting.then((r) => {
      hold.adopt(r);
      finish();
    }, finish);
    return 0;
  }
  if ('error' in started) {
    giveBack();
    unprotect();
    const message = started.error instanceof Error ? started.error.message : String(started.error);
    err.write(`porch-next could not start its renderer: ${message}\n`);
    return 1;
  }

  const renderer = started.made;
  hold.adopt(renderer);
  stdout.write(FOCUS_REPORTS_ON);
  const host = new GridHost(renderer, { scene, onQuit: () => leave?.() });
  const dump = process.env.PORCH_GRID_DUMP;
  if (dump !== undefined && dump !== '') {
    let passes = 0;
    renderer.on('frame', () => {
      passes += 1;
      if (host.grid !== undefined) dumpFrame(dump, host.grid, passes);
    });
  }
  renderer.root.add(host);
  host.requestFrame();
  await exited;

  for (const sig of SIGNALS) proc.off(sig, onSignal);
  host.destroy();
  giveBack();
  guard.dispose();
  return 0;
}

/** What `p` resolves to, or undefined if it rejects or takes longer than `ms`. */
function settled<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function groundOf(scene: Scene): string {
  return scene.ground(0, 0).bg;
}

/**
 * One render pass for the pty checks: the passes so far and the grid last painted, written whole
 * and then renamed, so a reader never sees half of it.
 */
function dumpFrame(file: string, grid: Grid, passes: number): void {
  const tmp = `${file}.tmp`;
  const frame = { cols: grid.cols, rows: grid.rows, passes, text: grid.toText() };
  writeFileSync(tmp, JSON.stringify(frame));
  renameSync(tmp, file);
}
