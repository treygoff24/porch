/**
 * `porch-next init` reaches post-kit's init: `--help` prints its usage and writes nothing. HOME and
 * PORCH_CONFIG point into an empty temporary directory, so Trey's own config is never in reach.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INIT_USAGE } from '@estate/post-kit';
import { afterAll, expect, it } from 'vitest';

const bin = join(import.meta.dirname, '..', '..', 'bin', 'porch-next');
const home = mkdtempSync(join(tmpdir(), 'porch-init-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

it('porch-next init --help prints post-kit’s init usage and writes nothing', () => {
  const r = spawnSync(bin, ['init', '--help'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
    env: { ...process.env, HOME: home, PORCH_CONFIG: join(home, 'config.toml') },
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(INIT_USAGE.split('\n')[0]);
  expect(readdirSync(home)).toEqual([]);
});
