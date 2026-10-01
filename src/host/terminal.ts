// Ported from ~/Code/loom/src/cockpit/terminal.ts (c0c4b75); the crash line names Porch.
/**
 * Porch's hold on the terminal: keeping Node's FFI warning off the screen before it is taken,
 * and giving the terminal back completely on every way out, printing nothing (Trey, 2026-09-28:
 * "he closes Loom to get his terminal back"). OpenTUI's own teardown covers a normal exit; this
 * covers the paths it does not: an uncaught error, a signal, the process exiting under the app.
 */
const FFI_WARNING = /FFI is an experimental feature/;

let silenced = false;

/**
 * Drop Node's one `ExperimentalWarning: FFI is an experimental feature` line, and only that. It
 * must run before `@opentui/core` is imported, since importing it loads `node:ffi`.
 */
export function silenceFfiWarning(): void {
  if (silenced) return;
  silenced = true;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (message !== undefined && FFI_WARNING.test(message)) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}

/**
 * The terminal's title stack: Porch pushes the title before it sets its own, and pops it once on the
 * way out. A pop is not idempotent (a second one pops a title that belongs to whatever runs Porch,
 * such as a multiplexer), so `holdTerminal` writes each exactly once.
 */
export const PUSH_TITLE = '\x1b[22;0t';
export const POP_TITLE = '\x1b[23;0t';

/**
 * Focus reports on (`CSI ? 1004 h`): the terminal sends `CSI I` on focus and `CSI O` on blur, which
 * OpenTUI turns into `focus` and `blur` events. OpenTUI does not enable them itself.
 */
export const FOCUS_REPORTS_ON = '\x1b[?1004h';

/**
 * Every mode Porch or OpenTUI turns on, turned off: the alternate screen, every mouse mode (press,
 * drag, motion, SGR encoding), focus reports (`FOCUS_REPORTS_ON`), bracketed paste, grapheme-cluster
 * mode and theme reports (OpenTUI turns both on at start and leaves 2027 on at exit), synchronized
 * output (a frame cut mid-write would hold the screen), then attributes reset and the cursor shown.
 * Each is a set, not a push, so this is idempotent and harmless on a terminal that never had them.
 *
 * The kitty keyboard mode is not here: it is a stack, OpenTUI pushes it only when the terminal
 * answers its query, and OpenTUI's own teardown (`renderer.destroy()`) pops it. Popping it here too
 * popped an entry that was not Porch's on every exit.
 */
export const RESET_MODES =
  '\x1b[?1049l' + // leave the alternate screen
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l' + // mouse off
  '\x1b[?1004l' + // focus reports off
  '\x1b[?2004l' + // bracketed paste off
  '\x1b[?2027l\x1b[?2031l' + // grapheme-cluster mode and theme reports off
  '\x1b[?2026l' + // synchronized output off
  '\x1b[0m\x1b[?25h'; // attributes reset, cursor shown

/** What a clean exit writes last: every mode off, then the title Porch pushed popped. */
export const RESTORE_SEQUENCE = RESET_MODES + POP_TITLE;

/** What can be destroyed to give back what it took: OpenTUI's renderer. */
export type Destroyable = { destroy(): void };

export type TerminalHold = {
  /** Push the terminal's title, then write `set` (Porch's own). Once; later calls do nothing. */
  takeTitle(set: string): void;
  /** The renderer, once it exists. Giving back destroys it, which pops what it pushed. */
  adopt(renderer: Destroyable): void;
  /** Every mode off (`RESET_MODES`). Repeatable. */
  resetModes(): void;
  /**
   * Give the terminal back: destroy the adopted renderer (OpenTUI's `destroy` is idempotent), turn
   * every mode off, and pop the title if it was pushed and not popped yet. Repeatable: every stack
   * is popped exactly once however many ways out run, and in whatever order.
   */
  giveBack(): void;
};

/** Porch's hold on the terminal, writing through `write` (which must not throw). */
export function holdTerminal(write: (s: string) => void): TerminalHold {
  let titlePushed = false;
  let titlePopped = false;
  let renderer: Destroyable | undefined;
  const resetModes = () => write(RESET_MODES);
  return {
    takeTitle(set) {
      if (titlePushed) return;
      titlePushed = true;
      write(PUSH_TITLE + set);
    },
    adopt(r) {
      renderer = r;
    },
    resetModes,
    giveBack() {
      try {
        renderer?.destroy();
      } catch {
        // Leaving anyway: the resets below still go out.
      }
      resetModes();
      // After the renderer's teardown, which writes a title of its own.
      if (titlePushed && !titlePopped) {
        titlePopped = true;
        write(POP_TITLE);
      }
    },
  };
}

export type ExitGuard = {
  /** Take the guard down (the app left cleanly). Idempotent. */
  dispose(): void;
};

/** Where crashes and exits arrive, and how to exit: the process, or a stand-in in tests. */
export type ProcessEvents = {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  off(event: string, fn: (...args: unknown[]) => void): unknown;
  prependListener(event: string, fn: (...args: unknown[]) => void): unknown;
  exit(code: number): void;
};

/**
 * While Porch owns the screen, an uncaught error or rejection gives the terminal back first
 * (`restore`), then prints the error to stderr, then exits 1, so the message lands on the user's own
 * screen and not inside the alternate one. The process exiting for any other reason restores it too.
 */
export function guardExit(opts: {
  restore: () => void;
  stderr?: NodeJS.WritableStream;
  proc?: ProcessEvents;
}): ExitGuard {
  const err = opts.stderr ?? process.stderr;
  const proc: ProcessEvents = opts.proc ?? process;
  let active = true;
  const restore = () => {
    try {
      opts.restore();
    } catch {
      // The terminal is gone (a closed pty); there is nothing left to restore.
    }
  };
  const crash = (error: unknown) => {
    if (!active) return;
    active = false;
    restore();
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    err.write(`porch-next crashed: ${text}\n`);
    proc.exit(1);
  };
  const onExit = () => {
    if (!active) return;
    active = false;
    restore();
  };
  proc.prependListener('uncaughtException', crash);
  proc.prependListener('unhandledRejection', crash);
  proc.on('exit', onExit);
  return {
    dispose() {
      if (!active) return;
      active = false;
      proc.off('uncaughtException', crash);
      proc.off('unhandledRejection', crash);
      proc.off('exit', onExit);
    },
  };
}
