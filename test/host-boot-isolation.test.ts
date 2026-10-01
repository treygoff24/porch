/**
 * The suite's own isolation (`test/setup/`): post points at a throwaway store, `post` and `herdr`
 * reached through PATH are tripwires that record the call and fail, and the real post is reachable
 * only through the binary named in `PORCH_REAL_POST`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POST_STORE_PREFIX } from './setup/post-isolation.ts';
import tripwireSetup, { which } from './setup/tripwire.ts';

describe('test isolation', () => {
  it('points post at a per-run store under the temp directory, never ~/.claude-mail', () => {
    const store = process.env.POST_MAIL_ROOT ?? '';
    expect(store.startsWith(join(tmpdir(), POST_STORE_PREFIX))).toBe(true);
    expect(store).not.toContain('.claude-mail');
    expect(process.env.POST_PARTICIPANT).toBeUndefined();
  });

  it('puts the tripwires first on PATH for post and herdr', () => {
    const bin = process.env.PORCH_TRIPWIRE_BIN ?? '';
    expect(bin).not.toBe('');
    for (const name of ['post', 'herdr']) {
      expect(which(name, process.env.PATH ?? '')).toBe(join(bin, name));
    }
    const real = process.env.PORCH_REAL_POST ?? '';
    if (real !== '') expect(real.startsWith(bin)).toBe(false);
  });

  it('fails the run at teardown when a test reached a tripwire, naming the test and the call', () => {
    const teardown = withOwnTripwire(() => {
      // A careless test reaching post through PATH. Its exit status is ignored on purpose, as a
      // careless test would ignore it: the teardown alone must catch the call.
      spawnSync('post', ['chat', 'general', '--send'], {
        env: { ...process.env, PORCH_TEST_CONTEXT: 'the careless test' },
        stdio: 'ignore',
      });
    });
    expect(existsSync(teardown.dir)).toBe(true);
    expect(teardown.run).toThrow(
      /a test ran a program the suite must never reach through PATH:\n {2}post chat general --send \(in the careless test, cwd /,
    );
    expect(existsSync(teardown.dir)).toBe(false);
  });

  it('passes teardown when no test reached one', () => {
    const teardown = withOwnTripwire(() => {});
    expect(teardown.run).not.toThrow();
    expect(existsSync(teardown.dir)).toBe(false);
  });
});

/**
 * Run the real global setup (`test/setup/tripwire.ts`) for a run of its own, `body` inside it with
 * the process's PATH as that setup left it, and hand back its teardown, not yet run. The run's own
 * tripwire and environment are put back before this returns.
 */
function withOwnTripwire(body: () => void): { run: () => void; dir: string } {
  const names = ['PATH', 'PORCH_TRIPWIRE_BIN', 'PORCH_REAL_POST'] as const;
  const saved = names.map((n) => [n, process.env[n]] as const);
  let teardown: (() => void) | undefined;
  let bin = '';
  try {
    teardown = tripwireSetup();
    bin = process.env.PORCH_TRIPWIRE_BIN ?? '';
    expect(bin).not.toBe(saved.find(([n]) => n === 'PORCH_TRIPWIRE_BIN')?.[1]);
    expect(which('post', process.env.PATH ?? '')).toBe(join(bin, 'post'));
    body();
  } catch (err) {
    teardown?.();
    throw err;
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
  if (teardown === undefined) throw new Error('the tripwire setup returned no teardown');
  return { run: teardown, dir: dirname(bin) };
}
