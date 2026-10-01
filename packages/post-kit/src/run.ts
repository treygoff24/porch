/**
 * Running `post` for the pane: one process per call, bounded in time, its output read whole. A
 * call that fails says why in plain words (`PostError`) rather than throwing, because a pane that
 * cannot reach post still has to draw something a reader can act on.
 */
import { spawn } from 'node:child_process';
import { childEnv } from './owner.ts';
import { displayText } from './records.ts';

export type PostError = {
  /** post's own error code when it gave one, else ours: `post_missing`, `timeout`, `bad_output`. */
  code: string;
  /** One sentence for a reader. */
  message: string;
  /** post said a retry may work (an I/O error), or the call never reached it (a timeout). */
  retryable: boolean;
  /** What post suggested doing about it. */
  fix?: string;
};

export type Failure = { ok: false; error: PostError };
export type Result<T> = { ok: true; value: T } | Failure;

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: PostError): Failure => ({
  ok: false,
  error: {
    ...error,
    message: displayText(error.message),
    ...(error.fix === undefined ? {} : { fix: displayText(error.fix) }),
  },
});

export type Outcome = {
  code: number | null;
  stdout: string;
  stderr: string;
  /**
   * The process never ran to an exit it chose: no such executable, or it was stopped for taking
   * too long, for saying too much (`overflow`), or because the caller stopped waiting (`aborted`).
   */
  failed?: 'missing' | 'timeout' | 'spawn' | 'overflow' | 'aborted';
  detail?: string;
};

export type RunSpec = {
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin. Absent means stdin is /dev/null, which post requires of a read. */
  input?: string;
  timeoutMs: number;
  /** Stop the process and fail (`overflow`) when either stream grows past this. Default 8 MiB. */
  maxBytes?: number;
  /** How long a process gets to leave after TERM, and again after KILL. Default 2 s. */
  killGraceMs?: number;
  /** Aborting stops the process the same way a timeout does and fails the call (`aborted`). */
  signal?: AbortSignal;
  /**
   * The call only reads, so it does not outlive this process: when this process exits (the
   * cockpit told to leave, its terminal hung up) the group is signalled TERM. A call without this
   * (a send) is left to finish; its group has its own session, so a hang-up does not reach it.
   */
  stopOnExit?: boolean;
};

/** More than this on either stream is not a message list; stop collecting and say so. */
const MAX_OUT = 8 * 1024 * 1024;
/** A stuck `post` gets this long to leave after it is asked to. */
const KILL_GRACE_MS = 2000;
/**
 * After the child has exited, what still holds its pipes open gets this long, counted from the
 * last thing it wrote, before the call ends: output that is still draining is never cut short.
 */
const EXIT_GRACE_MS = 500;

/** The groups of reads in flight that must not outlive this process (`RunSpec.stopOnExit`). */
const leaving = new Set<number>();
let exitHooked = false;

/** How many reads in flight would be stopped if this process left now (for the tests). */
export function readsLeaving(): number {
  return leaving.size;
}

/** Runs as this process exits: nothing async can happen here, so a signal and no waiting. */
function stopLeavers(): void {
  for (const pgid of leaving) {
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      // the group is already gone
    }
  }
  leaving.clear();
}

/**
 * Run `executable` once. The child leads a process group of its own (`detached`), and every signal
 * goes to that group, which this call created and only this call knows: TERM when it must stop
 * (the deadline, too much output, an abort), KILL a grace later if the pipes are still open, so a
 * grandchild does not outlive the call. The call ends when the child has exited and a short grace
 * has passed, with the child's real exit code, even if a grandchild in another group still holds
 * the pipes; and, should the child survive KILL (nothing portable resists it, so this is a
 * backstop no test exercises), a grace after KILL the call stops waiting.
 */
export function runProcess(executable: string, spec: RunSpec): Promise<Outcome> {
  return new Promise((resolve) => {
    const maxBytes = spec.maxBytes ?? MAX_OUT;
    const grace = spec.killGraceMs ?? KILL_GRACE_MS;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let closed = false;
    let why: 'timeout' | 'overflow' | 'aborted' | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let giveUp: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined;
    let leaver: number | undefined;
    const finish = (out: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (giveUp !== undefined) clearTimeout(giveUp);
      if (exitTimer !== undefined) clearTimeout(exitTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      if (leaver !== undefined) leaving.delete(leaver);
      resolve(out);
    };
    if (spec.signal?.aborted === true) {
      resolve({ code: null, stdout, stderr, failed: 'aborted' });
      return;
    }
    const child = spawn(executable, spec.args, {
      cwd: spec.cwd,
      env: childEnv(spec.env),
      stdio: [spec.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (spec.stopOnExit === true && child.pid !== undefined) {
      leaver = child.pid;
      leaving.add(leaver);
      if (!exitHooked) {
        exitHooked = true;
        process.on('exit', stopLeavers);
      }
    }
    const signalGroup = (signal: NodeJS.Signals) => {
      const pid = child.pid;
      if (pid === undefined) return child.kill(signal);
      try {
        // A negative pid is the process group `pid` leads: the child and what it started.
        process.kill(-pid, signal);
      } catch {
        // the group is already gone
      }
    };
    const stop = (reason: 'timeout' | 'overflow' | 'aborted') => {
      if (why !== undefined || settled) return;
      why = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        // Nothing holds the pipes any more once they are closed: the group has nothing to kill.
        if (!closed) signalGroup('SIGKILL');
        giveUp = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ code: null, stdout, stderr, failed: reason });
        }, grace);
      }, grace);
    };
    const onAbort = () => stop('aborted');
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => stop('timeout'), spec.timeoutMs);
    let exited: { code: number | null } | undefined;
    // Ends the call once the child is gone and nothing has been written for a grace. Re-armed by
    // every write, so a long answer still draining through the pipe is read to its end.
    const endAfterExit = () => {
      if (exited === undefined || settled) return;
      if (exitTimer !== undefined) clearTimeout(exitTimer);
      exitTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        const { code } = exited as { code: number | null };
        finish(
          why === undefined ? { code, stdout, stderr } : { code, stdout, stderr, failed: why },
        );
      }, EXIT_GRACE_MS);
    };
    child.on('exit', (code) => {
      exited = { code };
      endAfterExit();
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish({
        code: null,
        stdout,
        stderr,
        failed: e.code === 'ENOENT' ? 'missing' : 'spawn',
        detail: e.message,
      });
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length + d.length > maxBytes) return stop('overflow');
      stdout += d;
      endAfterExit();
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length + d.length > maxBytes) return stop('overflow');
      stderr += d;
      endAfterExit();
    });
    child.on('close', (code) => {
      closed = true;
      finish(why === undefined ? { code, stdout, stderr } : { code, stdout, stderr, failed: why });
    });
    if (spec.input !== undefined && child.stdin !== null) {
      // A `post` that exits before reading its input closes the pipe; the exit says what happened.
      child.stdin.on('error', () => {});
      child.stdin.end(spec.input);
    }
  });
}

/**
 * The JSON object in post's output. post prints notes (`post: sending to #x ...`) beside it, and
 * an error object goes to stderr, so try stdout then stderr, from the first line that opens an
 * object, as porch does.
 */
export function decodeJson(stdout: string, stderr: string): Record<string, unknown> | undefined {
  for (const blob of [stdout, stderr]) {
    const text = blob.trim();
    if (text.length === 0) continue;
    const starts = new Set<number>();
    if (text.startsWith('{')) starts.add(0);
    for (let i = text.indexOf('\n{'); i >= 0; i = text.indexOf('\n{', i + 1)) starts.add(i + 1);
    const first = text.indexOf('{');
    if (first >= 0) starts.add(first);
    for (const s of starts) {
      try {
        const data: unknown = JSON.parse(text.slice(s));
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
          return data as Record<string, unknown>;
        }
      } catch {
        // try the next candidate
      }
    }
  }
  return undefined;
}

function firstLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length > 0) return t.replace(/^post:\s*/, '');
  }
  return undefined;
}

/** post's answer as data, or the plain reason it is not one. */
export function interpret(out: Outcome, what: string): Result<Record<string, unknown>> {
  if (out.failed === 'missing') {
    return fail({
      code: 'post_missing',
      message: 'post is not installed here (no `post` on PATH).',
      retryable: false,
    });
  }
  if (out.failed === 'timeout') {
    return fail({
      code: 'timeout',
      message: `post did not answer (${what}); it was stopped.`,
      retryable: true,
    });
  }
  if (out.failed === 'overflow') {
    return fail({
      code: 'too_large',
      message: `post said more than the pane reads (${what}); it was stopped.`,
      retryable: false,
    });
  }
  if (out.failed === 'aborted') {
    return fail({
      code: 'aborted',
      message: `The pane stopped waiting for post (${what}).`,
      retryable: true,
    });
  }
  if (out.failed === 'spawn') {
    return fail({
      code: 'spawn_failed',
      message: `post could not start (${out.detail ?? what}).`,
      retryable: false,
    });
  }
  const data = decodeJson(out.stdout, out.stderr);
  if (data !== undefined && data.ok === false) {
    const err = data.error;
    if (typeof err === 'object' && err !== null && !Array.isArray(err)) {
      const e = err as Record<string, unknown>;
      const message = typeof e.message === 'string' ? (firstLine(e.message) ?? e.message) : '';
      // `details.exact_fix` runs when pasted (post 7286de3 and later); `suggested_fix` is prose
      // that says what to do. The command is the better thing to show when there is one.
      const details = e.details;
      const exact =
        typeof details === 'object' && details !== null && !Array.isArray(details)
          ? (details as Record<string, unknown>).exact_fix
          : undefined;
      const suggested = typeof e.suggested_fix === 'string' ? e.suggested_fix : undefined;
      const fix = typeof exact === 'string' && exact.length > 0 ? exact : suggested;
      return fail({
        code: typeof e.code === 'string' ? e.code : 'post_error',
        message: message.length > 0 ? message : `post refused (${what}).`,
        retryable: e.retryable === true,
        ...(fix === undefined ? {} : { fix }),
      });
    }
  }
  if (out.code !== 0) {
    const line = firstLine(out.stderr) ?? firstLine(out.stdout);
    return fail({
      code: 'post_failed',
      message: line ?? `post exited ${out.code ?? 'abnormally'} (${what}).`,
      retryable: false,
    });
  }
  if (data === undefined) {
    return fail({
      code: 'bad_output',
      message: `post answered, but not in a shape the pane reads (${what}).`,
      retryable: false,
    });
  }
  return ok(data);
}
