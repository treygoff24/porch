import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PorchConfig } from './config/porch-config.ts';

/**
 * What the client needs from Porch's config. Field names follow Loom's post client; build it from
 * a loaded config with {@link clientConfig}.
 */
export type ClientConfig = {
  ownerRoom: string;
  ownerRoomDir: string;
  mailRoot: string;
  sidecarDir: string;
  allowedSigners: string;
  keyFile: string;
  namespace: string;
  principal: string;
  marker: string;
  label: string;
};

export type OwnerAnchor = Pick<
  ClientConfig,
  'ownerRoom' | 'sidecarDir' | 'allowedSigners' | 'namespace' | 'principal' | 'marker' | 'label'
> & { signingBlocked?: string | undefined };
export type OwnerIdentity = ClientConfig & {
  participant: string;
  signingBlocked: string | undefined;
};

export function withoutCredentials(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(
      ([key, value]) =>
        value !== undefined &&
        !/(?:^|_)(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)$/.test(key),
    ),
  );
}

export function ownerEnv(
  base: NodeJS.ProcessEnv,
  cfg: Pick<ClientConfig, 'mailRoot'>,
  participant?: string,
): NodeJS.ProcessEnv {
  const env = withoutCredentials(base);
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('CODEX_') ||
      key.startsWith('HERDR_') ||
      [
        'POST_PARTICIPANT',
        'POST_FROM',
        'POST_SENDER_ADDRESS',
        'POST_HARNESS',
        'CLAUDE_CODE_SESSION_ID',
        'SSH_AUTH_SOCK',
        'SSH_AGENT_PID',
      ].includes(key)
    )
      delete env[key];
  }
  env.POST_MAIL_ROOT = cfg.mailRoot;
  if (participant !== undefined) env.POST_PARTICIPANT = participant;
  return env;
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  if (copy.LOOM_NODE_ENV_DEFAULTED !== undefined) {
    delete copy.LOOM_NODE_ENV_DEFAULTED;
    delete copy.NODE_ENV;
  }
  return copy;
}

export function porchConfigPath(env = process.env, home = homedir()): string {
  return env.PORCH_CONFIG || join(home, '.config', 'porch', 'config.toml');
}

/** The loader belongs to the config lane; injecting it also keeps unit tests off real config. */
export async function readConfig(path: string, home = homedir()): Promise<ClientConfig> {
  const moduleUrl = new URL('./config/index.ts', import.meta.url).href;
  const module = (await import(moduleUrl)) as {
    loadPorchConfig(path: string, home?: string): ClientConfig;
  };
  return module.loadPorchConfig(path, home);
}

export function crossCheck(
  cfg: OwnerAnchor,
  shown: Record<string, unknown>,
): { kind: 'agree' } | { kind: 'unsigned' | 'stop'; reason: string } {
  const owner = shown.owner;
  if (
    shown.state !== 'configured' ||
    typeof owner !== 'object' ||
    owner === null ||
    Array.isArray(owner)
  ) {
    return { kind: 'unsigned', reason: 'post owner is not configured' };
  }
  const o = owner as Record<string, unknown>;
  if (o.room !== cfg.ownerRoom)
    return { kind: 'stop', reason: 'Porch and post disagree about the owner room' };
  const fields: [string, unknown, string][] = [
    ['marker', o.marker, cfg.marker],
    ['label', o.label, cfg.label],
    ['principal', o.principal, cfg.principal],
    ['namespace', o.namespace, cfg.namespace],
    ['sidecar_dir', o.sidecar_dir, cfg.sidecarDir],
    ['allowed_signers', o.allowed_signers, cfg.allowedSigners],
  ];
  const mismatches = fields
    .filter(([, actual, expected]) => actual !== expected)
    .map(([key]) => key);
  return mismatches.length === 0
    ? { kind: 'agree' }
    : {
        kind: 'unsigned',
        reason: `Porch and post disagree about the owner (${mismatches.join(', ')})`,
      };
}

/** The client's view of a loaded Porch config (`loadPorchConfig`). */
export function clientConfig(cfg: PorchConfig): ClientConfig {
  return {
    ownerRoom: cfg.ownerRoom,
    ownerRoomDir: cfg.ownerRoomDir,
    mailRoot: cfg.mailRoot,
    sidecarDir: cfg.sidecarDir,
    allowedSigners: cfg.allowedSigners,
    keyFile: cfg.keyFile,
    namespace: cfg.signingNamespace,
    principal: cfg.principal,
    marker: cfg.marker,
    label: cfg.label,
  };
}
