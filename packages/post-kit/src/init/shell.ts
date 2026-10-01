/**
 * Small process helpers for `porch-next init`: Python's `shlex.quote`, and a runner that captures
 * output with a hard timeout and never hands the child a terminal on stdin.
 */
import { spawn } from 'node:child_process';

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Python's `shlex.quote`. */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  if (SAFE.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

export type RunResult = {
  /** Exit status, or null when the process was killed or never started. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the program could not be started at all (for example `ENOENT`). */
  readonly spawnError: NodeJS.ErrnoException | null;
};

export type RunOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
};

export type CommandRunner = (
  program: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

/** Run `program` directly (no shell), stdin closed, output captured as UTF-8. */
export const runCommand: CommandRunner = (program, args, options) =>
  new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env ?? process.env))
      if (v !== undefined) env[k] = v;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        status: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: err as NodeJS.ErrnoException,
      });
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => errOut.push(b));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('error', (err) => {
      spawnError = err as NodeJS.ErrnoException;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: spawnError !== null || timedOut ? null : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8'),
        timedOut,
        spawnError,
      });
    });
  });
