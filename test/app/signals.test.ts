/**
 * A signal stops the private signing agent (T6 ruling): SIGHUP, SIGTERM, SIGINT and SIGQUIT each
 * reach `agent.stop()`. Run against a real child: `bin/porch-next` under a pty, armed with the
 * throwaway test key, on the installed post in a sandbox.
 *
 * The agent's own supervisor kills `ssh-agent` when Porch dies however it dies, so the process
 * going away proves nothing; what only `stop()` does is remove the agent's `porch-agent-*`
 * directory. The test watches the run's `TMPDIR` while Porch runs (the directory must appear, or
 * the test is not testing anything) and checks it is gone after the signal.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanTmps, frameShows, liveWorld, underApp, type World } from './support.ts';

const agentDirs = (tmp: string) =>
  existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('porch-agent-')) : [];

describe('a signal stops the signing agent', () => {
  let world: World | undefined;
  afterAll(() => {
    world?.cleanup();
    cleanTmps();
  });

  it.each(['TERM', 'HUP', 'INT', 'QUIT'])(
    'on SIG%s',
    async (sig) => {
      world ??= await liveWorld(['commons']);
      const seen = new Set<string>();
      let timer: NodeJS.Timeout | undefined;
      const run = await underApp(
        world,
        (dump) => [
          { waitFor: 'Arm signing', ms: 20_000 },
          { send: 'y\r' },
          { waitFor: 'Passphrase', ms: 20_000 },
          { send: '\r' },
          frameShows(dump, '⚿ ARMED'),
          { file: 'armed', path: dump },
          { wait: 300 },
          { signal: sig },
          { wait: 4000 },
        ],
        {
          watchTmp: (tmp) => {
            timer = setInterval(() => {
              for (const d of agentDirs(tmp)) seen.add(d);
            }, 20);
          },
        },
      );
      clearInterval(timer);
      // Precondition: Porch armed, so there was an agent directory to remove.
      expect(run.timedOut).toBe(false);
      expect(run.files.armed ?? '', 'Porch never showed it was armed').toContain('⚿ ARMED');
      expect([...seen].length, 'no agent directory ever appeared').toBe(1);
      // Porch left on its own after the signal, cleanly, and stop() removed the directory.
      expect(run.signal).toBeNull();
      expect(run.exit).toBe(0);
      expect(agentDirs(run.tmp)).toEqual([]);
      for (const d of seen) expect(existsSync(join(run.tmp, d))).toBe(false);
    },
    90_000,
  );
});
