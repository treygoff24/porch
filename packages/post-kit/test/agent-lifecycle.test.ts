import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrivateAgent } from '../src/signing.ts';
import { sandbox } from './helpers.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function eventually(check: () => boolean, timeout = 3000) {
  const end = performance.now() + timeout;
  while (!check() && performance.now() < end) await delay(20);
  return check();
}
describe('real private agent lifecycle', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  it('SIGKILL of the Node parent unloads the key and removes its agent socket', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx/esm', join(import.meta.dirname, 'agent-parent.ts'), s.cfg.keyFile],
      {
        env: s.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const exited = once(child, 'exit');
    let info: { socket: string; pid: number } | undefined;
    try {
      const [bytes] = await once(child.stdout, 'data');
      info = JSON.parse(String(bytes));
      if (!info) throw new Error('no agent metadata');
      expect(alive(info.pid)).toBe(true);
      expect(existsSync(info.socket)).toBe(true);
      child.kill('SIGKILL');
      await exited;
      const agent = info;
      expect(await eventually(() => !alive(agent.pid) && !existsSync(agent.socket))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      if (info !== undefined) {
        if (alive(info.pid)) process.kill(info.pid, 'SIGTERM');
        await eventually(() => !existsSync(info?.socket ?? ''));
        // This is the private directory created by this test's child, never a service socket.
        if (dirname(info.socket).startsWith('/tmp/porch-agent-'))
          rmSync(dirname(info.socket), { recursive: true, force: true });
      }
    }
  }, 15000);
  it('wrong passphrase is answered once and returns promptly with a specific error', async () => {
    const key = join(s.root, 'encrypted-test-key');
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      'throwaway test passphrase',
      '-f',
      key,
    ]);
    let prompts = 0;
    const start = performance.now();
    let error: unknown;
    try {
      const agent = await PrivateAgent.start({
        keyFile: key,
        env: s.env,
        askPassphrase: () => {
          prompts++;
          return 'wrong test passphrase';
        },
      });
      await agent.stop();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('wrong passphrase');
    expect(prompts).toBe(1);
    expect(performance.now() - start).toBeLessThan(3000);
  }, 25000);
});
