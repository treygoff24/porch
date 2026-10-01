/**
 * Vitest global setup: put a tripwire stand-in for `post` and `herdr` first on PATH for the whole
 * run (pattern of `~/Code/loom/test/setup/tripwire.ts`, trimmed). `post` writes a live mailbox and
 * `herdr` drives a real pane; a test that reaches either through PATH records the call, gets exit
 * {@link TRIPWIRE_STATUS}, and fails the run at teardown with the test's name.
 *
 * A test that needs the real post opts in explicitly: this setup names the real binary in
 * `PORCH_REAL_POST` (empty when none is installed), and the test runs that path directly against
 * the run's throwaway `POST_MAIL_ROOT` (`post-isolation.ts`). Nothing reaches the real program by
 * its bare name.
 */
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** The prefix of the run's tripwire directory. */
export const TRIPWIRE_PREFIX = 'porch-test-tripwire-';

/** The programs no test may reach through PATH. */
export const TRIPWIRE_NAMES = ['post', 'herdr'] as const;

/** Exit status of a stand-in, so a test that ran one sees a failure it can name. */
export const TRIPWIRE_STATUS = 97;

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), TRIPWIRE_PREFIX));
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls');
  mkdirSync(bin);
  mkdirSync(calls);
  const inherited = process.env.PATH ?? '';
  process.env.PORCH_REAL_POST = which('post', inherited) ?? '';
  for (const name of TRIPWIRE_NAMES) {
    const shim = join(bin, name);
    writeFileSync(shim, shimFor(name, calls));
    chmodSync(shim, 0o755);
  }
  process.env.PORCH_TRIPWIRE_BIN = bin;
  process.env.PATH = [bin, inherited].join(delimiter);
  return () => {
    let recorded: string[];
    try {
      recorded = readdirSync(calls).flatMap((file) =>
        readFileSync(join(calls, file), 'utf8')
          .split('\n')
          .filter((line) => line !== ''),
      );
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`the tripwire could not read its records: ${(err as Error).message}`);
    }
    rmSync(dir, { recursive: true, force: true });
    if (recorded.length > 0) {
      const lines = recorded.map((line) => {
        const [name, context, cwd, args] = line.split('\t');
        return `  ${name} ${args ?? ''} (in ${context}, cwd ${cwd})`;
      });
      throw new Error(
        `a test ran a program the suite must never reach through PATH:\n${lines.join('\n')}\n` +
          'Give that test a stub, or run the real post through PORCH_REAL_POST on the test store.',
      );
    }
  };
}

/** The first `name` on `path` that can be run, or undefined. */
export function which(name: string, path: string): string | undefined {
  for (const part of path.split(delimiter)) {
    if (part === '') continue;
    const candidate = join(part, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The stand-in's text: record the call in a file of its own under `calls`, then fail. */
export function shimFor(name: string, calls: string): string {
  return [
    '#!/bin/sh',
    `# Tripwire for \`${name}\` (test/setup/tripwire.ts). It runs nothing.`,
    `args=$(printf '%.300s' "$*" | tr '\\n\\t' '  ')`,
    `printf '%s\\t%s\\t%s\\t%s\\n' ${quote(name)} "\${PORCH_TEST_CONTEXT:-unknown}" "$PWD" "$args" > ${quote(calls)}"/${name}.$$" 2>/dev/null ||`,
    `  echo ${quote(`tripwire: the record of this call to \`${name}\` could not be written`)} >&2`,
    `echo ${quote(`tripwire: a test ran \`${name}\` through PATH; give it a stub, or PORCH_REAL_POST (test/setup/tripwire.ts)`)} >&2`,
    `exit ${TRIPWIRE_STATUS}`,
    '',
  ].join('\n');
}

function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
