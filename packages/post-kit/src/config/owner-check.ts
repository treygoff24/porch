/**
 * The checks porch-tui's `roomcheck.py` runs against post before trusting its config: `post owner
 * show --json` (post's owner anchor) and `post profile show --json` run in the owner room directory
 * (post's acting-room resolver).
 *
 * Two deliberate differences from porch-tui (build plan rulings 8 and 9):
 * - Unknown JSON members are tolerated. The members porch reads are still type-checked, and
 *   `owner` must still hold its seven string fields.
 * - The `post owner init` command named for an unconfigured post always carries `--marker`, so a
 *   fresh install cannot end with post and Porch disagreeing on the marker (post's default is not
 *   Porch's).
 */

import { type CommandRunner, runCommand, shellQuote } from '../init/shell.ts';
import { type PyJson, pyJsonLoads, pyStrip } from '../stores/py.ts';
import {
  defaultLabelFor,
  defaultNamespace,
  defaultPrincipal,
  type PorchConfig,
  type PostOwner,
} from './porch-config.ts';
import { pyJoin } from './pypath.ts';

export class OwnerShowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerShowError';
  }
}

/** Fail closed: no join, no cursor move, no send. */
export class RoomInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomInvariantError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Variables that would make post act as the agent that launched Porch rather than as Trey. */
export const AGENT_IDENTITY_VARS = [
  'POST_PARTICIPANT',
  'POST_FROM',
  'POST_SENDER_ADDRESS',
  'POST_HARNESS',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
] as const;

/** porch-tui's `post_env`: pin the mail root and drop the launching agent's identity. */
export function postEnv(
  config: Pick<PorchConfig, 'mailRoot'>,
  base: Env = process.env,
  participant: string | null = null,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const name of AGENT_IDENTITY_VARS) delete env[name];
  env.POST_MAIL_ROOT = config.mailRoot;
  if (participant !== null) env.POST_PARTICIPANT = participant;
  return env;
}

/**
 * The exact, shell-safe `post owner init …` command for this config, under its mail root. Unlike
 * porch-tui, `--marker` is always present.
 */
export function postOwnerInitCommand(config: PorchConfig): string {
  const parts = ['post', 'owner', 'init', '--room', config.ownerRoom, '--marker', config.marker];
  if (config.label !== defaultLabelFor(config.ownerRoom)) parts.push('--label', config.label);
  if (config.sidecarDir !== config.ownerRoomDir) parts.push('--sidecar-dir', config.sidecarDir);
  if (config.allowedSigners !== pyJoin(config.sidecarDir, 'allowed_signers')) {
    parts.push('--allowed-signers', config.allowedSigners);
  }
  if (config.principal !== defaultPrincipal(config.ownerRoom)) {
    parts.push('--principal', config.principal);
  }
  if (config.signingNamespace !== defaultNamespace(config.ownerRoom)) {
    parts.push('--namespace', config.signingNamespace);
  }
  return `env POST_MAIL_ROOT=${shellQuote(config.mailRoot)} ${parts.map(shellQuote).join(' ')}`;
}

function parseObject(stdout: string, label: string, status: number | null): Map<string, PyJson> {
  if (status !== 0)
    throw new OwnerShowError(`${label} exited ${status} (refusing to parse stdout)`);
  const text = pyStrip(stdout);
  if (text === '') throw new OwnerShowError(`${label} returned empty stdout`);
  let data: PyJson;
  try {
    data = pyJsonLoads(text);
  } catch {
    throw new OwnerShowError(`${label} returned invalid JSON`);
  }
  if (!(data instanceof Map)) throw new OwnerShowError(`${label} returned a non-object`);
  return data;
}

function requireKeys(data: Map<string, PyJson>, keys: readonly string[], label: string): void {
  const missing = keys.filter((k) => !data.has(k)).sort();
  if (missing.length > 0) {
    throw new OwnerShowError(`${label} missing required keys: ${missing.join(', ')}`);
  }
}

const OWNER_KEYS = [
  'room',
  'sidecar_dir',
  'allowed_signers',
  'principal',
  'namespace',
  'marker',
  'label',
] as const;

export type PostRunOptions = {
  /** The post program; tests pass a stand-in or `PORCH_REAL_POST`. */
  readonly post?: string;
  readonly run?: CommandRunner;
  readonly env?: Env;
};

/**
 * `post owner show --json` under the config's mail root: exit 0, `ok: true`, `state: "configured"`,
 * and an `owner` object with the seven string fields. Anything else is an {@link OwnerShowError};
 * an unconfigured post names the exact `post owner init …` command to run.
 */
export async function fetchOwnerShow(
  config: PorchConfig,
  options: PostRunOptions = {},
): Promise<PostOwner> {
  const run = options.run ?? runCommand;
  const result = await run(options.post ?? 'post', ['owner', 'show', '--json'], {
    cwd: config.ownerRoomDir,
    env: postEnv(config, options.env),
    timeoutMs: 15_000,
  });
  if (result.spawnError !== null) {
    throw new OwnerShowError(
      result.spawnError.code === 'ENOENT'
        ? `post CLI not found, or owner_room_dir ${config.ownerRoomDir} is missing`
        : `post owner show failed: ${result.spawnError.message}`,
    );
  }
  if (result.timedOut) throw new OwnerShowError('post owner show failed: timed out');
  const data = parseObject(result.stdout, 'post owner show', result.status);
  requireKeys(data, ['ok', 'state'], 'post owner show');
  if (data.get('ok') !== true) throw new OwnerShowError('post owner show did not report ok=true');
  const state = data.get('state');
  if (state !== 'configured') {
    throw new OwnerShowError(
      `post owner state is ${JSON.stringify(state)} (need configured) — run \`${postOwnerInitCommand(config)}\` first`,
    );
  }
  if (!data.has('owner')) throw new OwnerShowError('post owner show missing owner object');
  const note = data.get('note');
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new OwnerShowError('post owner show note must be a string');
  }
  const owner = data.get('owner');
  if (!(owner instanceof Map)) throw new OwnerShowError('post owner show owner must be an object');
  const missing = OWNER_KEYS.filter((k) => !owner.has(k)).sort();
  if (missing.length > 0) {
    throw new OwnerShowError(`post owner show owner schema: missing ${missing.join(', ')}`);
  }
  const out: Record<string, string> = {};
  for (const key of OWNER_KEYS) {
    const value = owner.get(key);
    if (typeof value !== 'string') {
      throw new OwnerShowError(`post owner show owner.${key} must be a string`);
    }
    out[key] = value;
  }
  return out as PostOwner;
}

/** Require post's acting-room resolver, run in the owner room directory, to name the owner room. */
export async function assertActingRoom(
  config: PorchConfig,
  options: PostRunOptions = {},
): Promise<void> {
  const run = options.run ?? runCommand;
  const result = await run(options.post ?? 'post', ['profile', 'show', '--json'], {
    cwd: config.ownerRoomDir,
    env: postEnv(config, options.env),
    timeoutMs: 10_000,
  });
  if (result.spawnError !== null || result.timedOut) {
    const why = result.timedOut ? 'timed out' : (result.spawnError as Error).message;
    throw new RoomInvariantError(`cannot probe acting room via post profile show: ${why}`);
  }
  let room: string;
  try {
    const data = parseObject(result.stdout, 'post profile show', result.status);
    requireKeys(data, ['ok', 'room', 'profile'], 'post profile show');
    if (data.has('key') && typeof data.get('key') !== 'string') {
      throw new OwnerShowError('post profile show key must be a string');
    }
    if (data.has('legacy') && typeof data.get('legacy') !== 'boolean') {
      throw new OwnerShowError('post profile show legacy must be a boolean');
    }
    if (data.get('ok') !== true)
      throw new OwnerShowError('post profile show did not report ok=true');
    const r = data.get('room');
    if (typeof r !== 'string') throw new OwnerShowError('post profile show room must be a string');
    room = r;
    const profile = data.get('profile');
    if (!(profile instanceof Map)) {
      throw new OwnerShowError('post profile show profile must be an object');
    }
    for (const key of ['name', 'pfp']) {
      const v = profile.get(key);
      if (v !== undefined && v !== null && typeof v !== 'string') {
        throw new OwnerShowError(`post profile show profile.${key} must be a string or null`);
      }
    }
    if (data.has('announced')) {
      const a = data.get('announced');
      if (!Array.isArray(a) || !a.every((item) => typeof item === 'string')) {
        throw new OwnerShowError('post profile show announced must be a list of strings');
      }
    }
  } catch (err) {
    if (err instanceof OwnerShowError) throw new RoomInvariantError(err.message);
    throw err;
  }
  if (room !== config.ownerRoom) {
    throw new RoomInvariantError(
      `acting-room mismatch: config owner_room=${JSON.stringify(config.ownerRoom)} but post profile show (cwd=${config.ownerRoomDir}) reports room=${JSON.stringify(room)} — refusing to join/read/send`,
    );
  }
}
