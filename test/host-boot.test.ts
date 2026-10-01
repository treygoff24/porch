/**
 * The launcher's refusals, without a terminal: no TTY is exit 2 with one line on stderr and nothing
 * on stdout (no escape sequence reaches a pipe), for the demo and for the app alike; the app checks
 * for a terminal before it reads any config. And the app can import the two workspace packages by
 * name, as the app lanes will.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const bin = join(import.meta.dirname, '..', 'bin', 'porch-next');
const run = (...args: string[]) =>
  spawnSync(bin, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });

describe('porch-next without a terminal', () => {
  it('refuses to start, touching nothing on stdout', () => {
    const r = run('--demo');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('porch-next needs a terminal on stdin and stdout\n');
    expect(r.stdout).toBe('');
  });

  it('refuses the app the same way before reading any config, and prints usage on --help', () => {
    const app = spawnSync(bin, ['commons'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      // A config path that does not exist: reaching config would say "missing config" instead.
      env: { ...process.env, PORCH_CONFIG: '/nonexistent/porch-next-test/config.toml' },
    });
    expect(app.status).toBe(2);
    expect(app.stderr).toBe('porch-next needs a terminal on stdin and stdout\n');
    expect(app.stdout).toBe('');
    const help = run('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage: porch-next [channel] [--no-sign]');
    expect(help.stdout).toContain('porch-next init');
    const bad = run('--bogus');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unexpected --bogus');
  });
});

describe('the workspace packages', () => {
  it('resolve by name from the app, through the root dependency links', async () => {
    const pixel = await import('@estate/pixel');
    const postKit = await import('@estate/post-kit');
    expect(typeof pixel).toBe('object');
    expect(typeof postKit).toBe('object');
  });
});
