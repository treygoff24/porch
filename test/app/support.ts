/**
 * Live worlds for the app's end-to-end and pty tests: the installed post (`PORCH_REAL_POST`) on a
 * throwaway mail root, Trey's room and config from post-kit's sandbox (with the throwaway test key),
 * and an agent room, `crew`, bound as Bolt. Nothing here reads `~/.claude-mail`, Trey's config,
 * his keys or his drafts: `HOME`, `PORCH_CONFIG` and `POST_MAIL_ROOT` all point into the sandbox.
 *
 * `underApp` runs the real `bin/porch-next` under a pty (`test/setup/pty_run.py`) with the
 * sandbox's environment, `PORCH_POST_BIN` set to the real post (the tripwire `post` on PATH would
 * fail the run), `PORCH_GRID_DUMP` for the frames, and `TMPDIR` inside the sandbox so the private
 * signing agent's directory can be checked.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJson, OwnerPost, ownerEnv, runProcess } from '@estate/post-kit';
import { initializePost, realPost, sandbox } from '../../packages/post-kit/test/helpers.ts';
import { markAttractSeen } from '../../src/app/stage/attract.ts';
import type { Run, Step } from '../setup/pty.ts';

const root = join(import.meta.dirname, '..', '..');

export type World = Awaited<ReturnType<typeof liveWorld>>;

export async function liveWorld(channels: readonly string[] = ['commons', 'ops']) {
  if (!realPost) throw new Error('the installed post is required (PORCH_REAL_POST)');
  const post = realPost;
  const s = sandbox();
  await initializePost(s);
  const connected = await OwnerPost.connect({ executable: post, env: s.env, config: s.cfg });
  if (!connected.ok) throw new Error(connected.error.message);
  const owner = connected.value;
  for (const ch of channels) {
    const joined = await owner.join(ch);
    if (!joined.ok) throw new Error(joined.error.message);
  }
  const crewDir = join(s.root, 'crew');
  mkdirSync(crewDir, { mode: 0o700 });
  let agent = '';
  const agentPost = async (args: string[], input?: string) => {
    const out = await runProcess(post, {
      args,
      env: ownerEnv(s.env, s.cfg, agent === '' ? undefined : agent),
      cwd: crewDir,
      timeoutMs: 10000,
      ...(input === undefined ? {} : { input }),
    });
    const data = decodeJson(out.stdout, out.stderr);
    if (out.code !== 0 || data?.ok !== true) throw new Error(`agent post: ${out.stderr}`);
    return data;
  };
  await agentPost(['rooms', 'add', 'crew', crewDir, '--json']);
  const bound = await agentPost([
    'participant',
    'bind',
    '--harness',
    'test',
    '--key',
    'bolt',
    '--workspace',
    'crew',
    '--json',
  ]);
  agent = bound.id as string;
  for (const ch of channels) await agentPost(['chat', ch, '--join', '--json']);
  await agentPost(['profile', 'set', '--name', 'Bolt', '--json']);
  /** Bolt sends `body` to `channel`; the record's id. */
  const say = async (channel: string, body: string) => {
    const r = await agentPost(['chat', channel, '--send', '--json', '--body-file', '-'], body);
    return String((r.message as { id?: string } | undefined)?.id ?? r.id ?? '');
  };
  /** Trey's history of `channel`, read as post stores it (not through Porch). */
  const history = async (channel: string, limit = 50) => {
    const r = await owner.history(channel, limit);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  /** Post's unread count for Trey in `channel`. */
  const unread = async (channel: string) => {
    const r = await owner.channels();
    if (!r.ok) throw new Error(r.error.message);
    return r.value.find((c) => c.name === channel)?.unread;
  };
  return { ...s, post, owner, agent, say, history, unread, crewDir };
}

export type AppRun = Run & { tmp: string };

const shortTmps: string[] = [];

/** Remove the runs' short `TMPDIR`s (call from `afterAll`, with the world's own cleanup). */
export function cleanTmps(): void {
  for (const d of shortTmps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** `bin/porch-next <args>` under a pty in `world`, scripted. */
export async function underApp(
  world: World,
  script: (dump: string) => Step[],
  opts: {
    args?: string[];
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
    /**
     * Show the first-launch attract screen (default: no). These runs read the chat screen, so by
     * default the run's own state dir already has the attract marker, as on any launch after the
     * first.
     */
    firstLaunch?: boolean;
    /** Called once the run's `TMPDIR` exists, before the app starts, to watch it while it runs. */
    watchTmp?: (tmp: string) => void;
  } = {},
): Promise<AppRun> {
  const dir = join(world.root, `pty-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The run's TMPDIR is kept short: the signing agent's socket lives under it, and a Unix socket
  // path over ~108 bytes cannot be bound (the sandbox's own path is already most of that).
  const tmp = mkdtempSync(join(tmpdir(), 'pa-'));
  shortTmps.push(tmp);
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (opts.firstLaunch !== true) markAttractSeen(stateDir);
  const out = join(dir, 'out.bin');
  const dump = join(dir, 'grid.json');
  opts.watchTmp?.(tmp);
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 32;
  const child = spawn(
    'python3',
    [
      join(root, 'test/setup/pty_run.py'),
      '--cols',
      String(cols),
      '--rows',
      String(rows),
      '--out',
      out,
      '--script',
      JSON.stringify(script(dump)),
      '--timeout',
      '60',
      '--',
      join(root, 'bin/porch-next'),
      ...(opts.args ?? []),
    ],
    {
      cwd: root,
      env: {
        ...world.env,
        TERM: 'xterm-256color',
        PORCH_GRID_DUMP: dump,
        PORCH_POST_BIN: world.post,
        PORCH_POLL_MS: '300',
        PORCH_STATE_DIR: stateDir,
        TMPDIR: tmp,
        ...opts.env,
      },
    },
  );
  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  await new Promise((resolve) => child.on('close', resolve));
  const report = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Omit<
    Run,
    'raw' | 'bytes' | 'cols' | 'rows'
  >;
  const raw = readFileSync(out);
  return { ...report, raw, bytes: raw.toString('latin1'), cols, rows, tmp };
}

/** Wait until the app's dumped frame contains `text`. */
export const frameShows = (dump: string, text: string, ms = 20_000): Step => ({
  waitFile: dump,
  contains: text,
  ms,
});
