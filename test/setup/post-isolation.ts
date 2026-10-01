/**
 * Vitest global setup: point post at a throwaway store for the whole run (pattern of
 * `~/Code/loom/test/setup/post-isolation.ts`). Workers inherit this environment, and so does any
 * post process a test starts, so nothing in the suite can write `~/.claude-mail`. An inherited
 * `POST_PARTICIPANT` is cleared so no test acts as the agent running the suite.
 *
 * The store is not initialised here: a test that runs the real post opts in through
 * `PORCH_REAL_POST` (see `tripwire.ts`) and sets up what it needs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The prefix of the per-run post store; `test/boot-isolation.test.ts` checks for it. */
export const POST_STORE_PREFIX = 'porch-test-post-';

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), POST_STORE_PREFIX));
  process.env.POST_MAIL_ROOT = join(dir, 'mail');
  delete process.env.POST_PARTICIPANT;
  return () => rmSync(dir, { recursive: true, force: true });
}
