/**
 * `porch-next init`: the port of porch-tui's `porch init` (`src/porch3/initcli.py`), which writes
 * Porch's trust anchor.
 *
 * Order: preflight `post owner show` (post's owner anchor must agree with the config), then the
 * acting-room check, then the existing-config check, then three mutations: the keypair, the
 * `allowed_signers` line, and the config file LAST (it is the activation marker). A failure after
 * the first mutation rolls back everything this run created or changed, and reports any rollback
 * that could not complete. Init never runs `post owner init` itself; when post is unconfigured it
 * names the exact command, now always with `--marker`.
 *
 * With an existing config that resolves to the same identity, init prints so, changes nothing and
 * returns 0.
 *
 * Differences from porch-tui, each deliberate:
 * - The printed `post owner init` command always carries `--marker` (build plan ruling 8).
 * - Post's JSON may carry members porch does not know (ruling 9).
 * - The config path honours `$PORCH_CONFIG`, as the loader does; porch-tui's init ignored it and
 *   could write a file the app then never read.
 * - Locks on `allowed_signers` wait at most {@link SIGNERS_LOCK_TIMEOUT_MS} rather than forever.
 * - The lock is held for the whole run of changes, through rollback, and rollback only undoes files
 *   still exactly as this run left them ({@link InitTransaction}); porch-tui held it only for the
 *   append and restored from a snapshot, which could erase a concurrent init's key or signer.
 * - An `allowed_signers` file whose last line has no newline gets one before the new line, so the
 *   two entries stay separate (porch-tui joined them into one broken line).
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertActingRoom,
  fetchOwnerShow,
  OwnerShowError,
  RoomInvariantError,
} from '../config/owner-check.ts';
import {
  buildConfig,
  ConfigError,
  type ConfigInput,
  type ConfigKey,
  configPath,
  configsResolveIdentical,
  DEFAULT_INITIAL_CHANNEL,
  DEFAULT_MARKER,
  defaultLabelFor,
  emitToml,
  HeldReadError,
  heldReadRegular,
  legacyValues,
  loadConfigBytes,
  MAX_CONFIG_BYTES,
  ownerFieldMismatches,
  type PorchConfig,
  resolveMailRoot,
} from '../config/porch-config.ts';
import { pyPath } from '../config/pypath.ts';
import { type FlockAvailability, loadFlock } from '../stores/flock.ts';
import { PY_S, pySplitlines, pyStrip } from '../stores/py.ts';
import { InitError } from './errors.ts';
import { type CommandRunner, runCommand, shellQuote } from './shell.ts';
import {
  InitTransaction,
  makeParents,
  SIGNERS_LOCK_TIMEOUT_MS,
  writeAllAt,
} from './transaction.ts';

export { InitError, SIGNERS_LOCK_TIMEOUT_MS };

const MAX_PUB_BYTES = 16 * 1024;
const MAX_KEY_BYTES = 16 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

export type InitDeps = {
  /** The ambient environment (config resolution and the post runs). */
  readonly env: Env;
  /** Home directory for `~` and defaults; `$HOME` when absent. */
  readonly home?: string;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Whether stdin is a terminal: prompts happen only then. */
  readonly isTty: boolean;
  /** Ask one question on the terminal; the answer without its newline. */
  readonly prompt?: (question: string) => Promise<string>;
  /** Ask one question without echoing the answer (passphrases). */
  readonly promptHidden?: (question: string) => Promise<string>;
  readonly run?: CommandRunner;
  /** The post program (tests use a stand-in or `PORCH_REAL_POST`). */
  readonly post?: string;
  readonly sshKeygen?: string;
  readonly flock?: FlockAvailability;
  /** Where temporary key material goes (defaults to the OS temp directory). */
  readonly tmpDir?: string;
};

// --- arguments --------------------------------------------------------------------------------

const VALUE_FLAGS = {
  '--config': 'config',
  '--owner-room': 'ownerRoom',
  '--owner-room-dir': 'ownerRoomDir',
  '--mail-root': 'mailRoot',
  '--marker': 'marker',
  '--label': 'label',
  '--initial-channel': 'initialChannel',
  '--sidecar-dir': 'sidecarDir',
  '--allowed-signers': 'allowedSigners',
  '--key-file': 'keyFile',
  '--signing-namespace': 'signingNamespace',
  '--principal': 'principal',
} as const;
type ValueKey = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];
export type InitArgs = { fromLegacy: boolean; help: boolean } & { [K in ValueKey]?: string };

export const INIT_USAGE = `usage: porch-next init [-h] [--from-legacy] ${Object.keys(VALUE_FLAGS)
  .map((f) => `[${f} ${f.slice(2).replaceAll('-', '_').toUpperCase()}]`)
  .join(' ')}`;

/** argparse's behaviour for these flags: `--flag value` or `--flag=value`; the last one wins. */
export function parseInitArgs(argv: readonly string[]): InitArgs {
  const out: InitArgs = { fromLegacy: false, help: false };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k] as string;
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    if (arg === '--from-legacy') {
      out.fromLegacy = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const key = (VALUE_FLAGS as Record<string, ValueKey>)[name];
    if (key === undefined) throw new InitError(`unrecognized arguments: ${arg}`);
    let value: string;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[k + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new InitError(`argument ${name}: expected one argument`);
      }
      value = next;
      k++;
    }
    out[key] = value;
  }
  return out;
}

// --- file helpers -----------------------------------------------------------------------------

/** A held read with porch-tui's messages; missing files rethrow `ENOENT`. */
function readRegularHeld(path: string, limit: number, label: string) {
  try {
    return heldReadRegular(path, limit, label);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    if (err instanceof HeldReadError) {
      const detail =
        err.kind === 'open'
          ? `${label} path ${path} exists but is unreadable/non-followable: ${err.message}`
          : err.kind === 'not-regular'
            ? `${label} at ${path} must be a regular file (symlink/FIFO/directory refused)`
            : err.kind === 'too-large'
              ? `${label} at ${path} exceeds ${limit} bytes — refuse`
              : `${label} at ${path}: ${err.message}`;
      throw new InitError(detail, 4);
    }
    throw err;
  }
}

/** `os.path.lexists`: the name exists, even as a dangling symlink. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRegularNoFollow(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

const isCode = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code;

/** Existing config bytes, parsed as porch-tui parses them for this comparison (no ambient env). */
function parseExisting(raw: Uint8Array, path: string, home: string | undefined): PorchConfig {
  try {
    return loadConfigBytes(raw, { env: {}, ...(home === undefined ? {} : { home }) });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new InitError(`config already exists at ${path} but is malformed: ${err.message}`);
    }
    throw err;
  }
}

/** porch-tui's `_hardlink_commit`: create the config by hard link, never replacing a file. */
function hardlinkCommit(
  src: string,
  dest: string,
  wanted: Buffer,
  config: PorchConfig,
  home: string | undefined,
): void {
  try {
    linkSync(src, dest);
    return;
  } catch (err) {
    if (!isCode(err, 'EEXIST')) {
      throw new InitError(
        `cannot hard-link config onto ${dest} from ${src}: ${(err as Error).message} (temp and destination must share a filesystem)`,
      );
    }
  }
  const existing = readRegularHeld(dest, MAX_CONFIG_BYTES, 'config').data;
  if (existing.equals(wanted)) return;
  if (configsResolveIdentical(parseExisting(existing, dest, home), config)) return;
  throw new InitError(`config already exists at ${dest} with different values — refuse`);
}

function writeConfigAtomic(config: PorchConfig, path: string, home: string | undefined): void {
  if (isSymlink(path)) throw new InitError(`refusing symlink at config path ${path}`);
  if (lexists(path)) {
    const existing = readRegularHeld(path, MAX_CONFIG_BYTES, 'config').data;
    if (configsResolveIdentical(parseExisting(existing, path, home), config)) return;
    throw new InitError(`config already exists at ${path} with different values — refuse`);
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const wanted = Buffer.from(emitToml(config), 'utf8');
  const tmp = join(parent, `.porch-config.${randomBytes(6).toString('hex')}.tmp`);
  let fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let committed = false;
  let cleanupError: unknown = null;
  try {
    fchmodSync(fd, 0o600);
    writeAllAt(fd, wanted, null);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    hardlinkCommit(tmp, path, wanted, config, home);
    committed = true;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {}
    }
    // Once the link commits, temp cleanup is best effort: a failed unlink must not unwind the key
    // and signers, because the config is already the activation marker.
    try {
      unlinkSync(tmp);
    } catch (err) {
      if (!committed && !isCode(err, 'ENOENT')) cleanupError = err;
    }
  }
  if (cleanupError !== null) throw cleanupError;
}

// --- ssh-keygen -------------------------------------------------------------------------------

type Keygen = { run: CommandRunner; program: string; tmp: string };

/**
 * An `SSH_ASKPASS` environment whose secret appears in no argv and no environment value: the
 * passphrase sits in a 0600 file read by a 0700 script, both removed afterwards.
 */
async function withAskpass<T>(
  passphrase: string,
  tmp: string,
  fn: (env: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmp, 'porch-askpass-'));
  const phrase = join(dir, 'phrase');
  const ask = join(dir, 'askpass');
  try {
    const pfd = openSync(phrase, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeAllAt(pfd, Buffer.from(passphrase, 'utf8'), null);
    } finally {
      closeSync(pfd);
    }
    writeFileSync(ask, `#!/bin/sh\nexec cat -- ${shellQuote(phrase)}\n`, { encoding: 'utf8' });
    chmodSync(ask, 0o700);
    const env: Record<string, string | undefined> = { ...process.env };
    env.SSH_ASKPASS = ask;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.DISPLAY ??= ':0';
    return await fn(env);
  } finally {
    for (const p of [phrase, ask]) {
      try {
        unlinkSync(p);
      } catch {}
    }
    try {
      rmdirSync(dir);
    } catch {}
  }
}

/** `ssh-ed25519 AAAA…` from public key text; the comment is dropped. */
export function pubCoreFromText(text: string): string {
  const parts = pyStrip(text).split(new RegExp(`${PY_S}+`, 'u'));
  if (parts.length < 2 || !(parts[0] as string).startsWith('ssh-')) {
    throw new InitError('public key material is malformed — refuse');
  }
  return `${parts[0]} ${parts[1]}`;
}

/** Prove private key bytes match a public key with `ssh-keygen -y` on a private 0600 copy. */
async function pubMatchesPrivateBytes(
  keyBytes: Buffer,
  pubCore: string,
  passphrase: string,
  kg: Keygen,
): Promise<boolean> {
  const dir = mkdtempSync(join(kg.tmp, 'porch-keycopy-'));
  let stdout: string | null = null;
  let stranded: Error | null = null;
  try {
    chmodSync(dir, 0o700);
    const material = join(dir, 'material');
    const fd = openSync(material, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeAllAt(fd, keyBytes, null);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const result =
      passphrase === ''
        ? await kg.run(kg.program, ['-y', '-f', material, '-P', ''], { timeoutMs: 10_000 })
        : await withAskpass(passphrase, kg.tmp, (env) =>
            kg.run(kg.program, ['-y', '-f', material], { timeoutMs: 10_000, env }),
          );
    if (result.status === 0) stdout = result.stdout;
  } catch {
    stdout = null;
  } finally {
    try {
      rmSync(dir, { recursive: true });
    } catch (err) {
      stranded = err as Error;
    }
  }
  // A stranded private key copy is worse than a failed init.
  if (stranded !== null) {
    throw new InitError(
      `cannot remove the temporary private key copy at ${dir}: ${stranded.message} — remove it by hand`,
      4,
    );
  }
  if (stdout === null) return false;
  try {
    return pubCoreFromText(pyStrip(stdout)) === pubCore;
  } catch {
    return false;
  }
}

/** Copy `src` to a new `dest` (exclusive create, no follow); `dest` joins the transaction at once. */
function installCreateOnly(src: string, dest: string, mode: number, txn: InitTransaction): void {
  const made: string[] = [];
  makeParents(dirname(dest), made);
  txn.recordDirs(made);
  const data = readRegularHeld(src, MAX_KEY_BYTES, 'key material').data;
  let fd: number;
  try {
    fd = openSync(
      dest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
  } catch (err) {
    if (isCode(err, 'EEXIST')) {
      throw new InitError(
        `refusing to overwrite existing path at ${dest} (ssh-keygen overwrite prompt never defines policy)`,
      );
    }
    throw new InitError(`cannot create ${dest}: ${(err as Error).message}`);
  }
  // Recorded empty at once, then with its bytes once written. A failed write is cut back to empty
  // so the rollback recognises the file as this run's and removes it.
  txn.recordCreated(dest, fd, Buffer.alloc(0));
  try {
    writeAllAt(fd, data, null);
    fsyncSync(fd);
    txn.recordCreated(dest, fd, data);
    fchmodSync(fd, mode);
  } catch (err) {
    try {
      ftruncateSync(fd, 0);
      txn.recordCreated(dest, fd, Buffer.alloc(0));
    } catch {}
    throw new InitError(`cannot write ${dest}: ${(err as Error).message}`);
  } finally {
    closeSync(fd);
  }
}

async function adoptExistingKeypair(
  config: PorchConfig,
  interactive: boolean,
  deps: InitDeps,
  kg: Keygen,
): Promise<string> {
  const key = config.keyFile;
  const pub = `${key}.pub`;
  const heldKey = readRegularHeld(key, MAX_KEY_BYTES, 'private key');
  const pubBytes = readRegularHeld(pub, MAX_PUB_BYTES, 'public key').data;
  if (heldKey.data.length === 0) {
    throw new InitError(`existing private key at ${key} is empty — refuse (kept as-is)`);
  }
  // The mode comes from the descriptor the bytes came from, never from a second look at the path.
  const mode = heldKey.stat.mode & 0o7777;
  if (mode !== 0o600) {
    throw new InitError(
      `existing key at ${key} has mode 0o${mode.toString(8)}, want 0600 — refusing to adopt (kept as-is)`,
    );
  }
  let pubCore: string;
  try {
    pubCore = pubCoreFromText(new TextDecoder('utf-8', { fatal: true }).decode(pubBytes));
  } catch {
    throw new InitError(`public key at ${pub} is malformed — refuse (kept as-is)`);
  }
  if (await pubMatchesPrivateBytes(heldKey.data, pubCore, '', kg)) return pubCore;
  if (interactive && deps.isTty && deps.promptHidden !== undefined) {
    const phrase = await askHidden(deps, 'existing encrypted key passphrase (for adoption): ');
    if (await pubMatchesPrivateBytes(heldKey.data, pubCore, phrase, kg)) return pubCore;
  }
  throw new InitError(
    `existing key pair at ${key} does not match (ssh-keygen -y) — refuse (kept as-is); if the key is encrypted, re-run interactively to adopt it`,
  );
}

async function askHidden(deps: InitDeps, question: string): Promise<string> {
  try {
    return await (deps.promptHidden as (q: string) => Promise<string>)(question);
  } catch {
    throw new InitError('passphrase prompt cancelled');
  }
}

/** Adopt the configured key pair, or generate one; returns the public key core for signers. */
async function ensureKeypair(
  config: PorchConfig,
  txn: InitTransaction,
  interactive: boolean,
  deps: InitDeps,
  kg: Keygen,
): Promise<string> {
  const key = config.keyFile;
  const pub = `${key}.pub`;
  const keyHere = lexists(key);
  const pubHere = lexists(pub);
  if (keyHere || pubHere) {
    if (keyHere && pubHere) return adoptExistingKeypair(config, interactive, deps, kg);
    throw new InitError(
      `key material partially present at ${key} / ${pub} — refuse (ssh-keygen overwrite prompt never defines policy; kept as-is)`,
    );
  }
  let passphrase = '';
  if (interactive && deps.isTty && deps.promptHidden !== undefined) {
    passphrase = await askHidden(deps, 'key passphrase (empty allowed): ');
  }
  const dir = mkdtempSync(join(kg.tmp, 'porch-keygen-'));
  chmodSync(dir, 0o700);
  const tmpKey = join(dir, 'key');
  const tmpPub = `${tmpKey}.pub`;
  const args = ['-t', 'ed25519', '-f', tmpKey, '-C', config.principal, '-q'];
  try {
    const result =
      passphrase === ''
        ? await kg.run(kg.program, [...args, '-N', ''], { timeoutMs: 30_000 })
        : await withAskpass(passphrase, kg.tmp, (env) =>
            kg.run(kg.program, args, { timeoutMs: 30_000, env }),
          );
    if (result.spawnError !== null) {
      throw new InitError(
        result.spawnError.code === 'ENOENT'
          ? 'ssh-keygen missing'
          : `ssh-keygen failed: ${result.spawnError.message}`,
        4,
      );
    }
    if (result.timedOut) throw new InitError('ssh-keygen timed out', 4);
    if (result.status !== 0) throw new InitError('ssh-keygen failed', 4);
    if (!isRegularNoFollow(tmpKey) || !isRegularNoFollow(tmpPub)) {
      throw new InitError('ssh-keygen produced non-regular key material');
    }
    if (lstatSync(tmpPub).size > MAX_PUB_BYTES) {
      throw new InitError('ssh-keygen produced oversized public key');
    }
    const pubBytes = readRegularHeld(tmpPub, MAX_PUB_BYTES, 'public key').data;
    const pubCore = pubCoreFromText(pubBytes.toString('utf8'));
    // Create-only installs: a planted destination refuses. Rollback owns every final-path unlink.
    installCreateOnly(tmpKey, key, 0o600, txn);
    installCreateOnly(tmpPub, pub, 0o644, txn);
    return pubCore;
  } finally {
    for (const p of [tmpKey, tmpPub]) {
      try {
        unlinkSync(p);
      } catch {}
    }
    try {
      rmdirSync(dir);
    } catch {}
  }
}

// --- allowed_signers --------------------------------------------------------------------------

/** OpenSSH `match_pattern`: `*` matches any run, `?` exactly one character. No regex engine. */
export function matchPattern(pattern: string, text: string): boolean {
  const p = [...pattern];
  const t = [...text];
  let pi = 0;
  let ti = 0;
  let star = -1;
  let starT = 0;
  while (ti < t.length) {
    if (pi < p.length && p[pi] === '*') {
      star = pi;
      pi++;
      starT = ti;
    } else if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
      pi++;
      ti++;
    } else if (star >= 0) {
      pi = star + 1;
      starT++;
      ti = starT;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

/** OpenSSH `match_pattern_list`: a matching `!` pattern is a definitive no. Case-sensitive. */
export function matchPatternList(list: string, text: string): boolean {
  let positive = false;
  for (const sub of list.split(',')) {
    const negated = sub.startsWith('!');
    const pattern = negated ? sub.slice(1) : sub;
    if (pattern === '') continue;
    if (matchPattern(pattern, text)) {
      if (negated) return false;
      positive = true;
    }
  }
  return positive;
}

export function signersLine(config: PorchConfig, pubCore: string): string {
  const parts = pubCore.split(new RegExp(`${PY_S}+`, 'u')).filter((s) => s !== '');
  if (parts.length < 2) throw new InitError('public key core is malformed');
  return `${config.principal} namespaces="${config.signingNamespace}" ${parts[0]} ${parts[1]}\n`;
}

/**
 * Add this principal's line to `allowed_signers`, read and written under the transaction's lock.
 * Refuses a rotation, a duplicate, or a pattern-list line that already matches the principal.
 */
function appendAllowedSigners(
  config: PorchConfig,
  txn: InitTransaction,
  pubCore: string,
  fromLegacy: boolean,
): void {
  const path = txn.path;
  const line = signersLine(config, pubCore);
  let existing: string;
  try {
    existing = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(txn.original);
  } catch {
    throw new InitError('allowed_signers is not valid UTF-8 — refuse');
  }
  let exact = 0;
  const bare = line.slice(0, -1);
  for (const eline of pySplitlines(existing)) {
    if (eline.startsWith(`${config.principal} `) || eline.startsWith(`${config.principal}\t`)) {
      if (eline === bare) {
        exact++;
        continue;
      }
      throw new InitError(
        `allowed_signers already has a different line for ${config.principal} — refuse rotation (kept as-is)`,
      );
    }
    // ssh reads the first field as a pattern list, so `*` or `mara@porch,other` would already
    // authorize this principal with someone else's key.
    const stripped = pyStrip(eline);
    if (stripped === '' || stripped.startsWith('#')) continue;
    const patterns = stripped.split(new RegExp(`${PY_S}+`, 'u'))[0] as string;
    if (matchPatternList(patterns, config.principal)) {
      throw new InitError(
        `allowed_signers has a conflicting pattern-list line (${JSON.stringify(patterns)}) that already matches ${config.principal} — refuse (kept as-is)`,
      );
    }
  }
  if (exact > 1) {
    throw new InitError(
      `allowed_signers has duplicate lines for ${config.principal} — refuse (kept as-is)`,
    );
  }
  const mode = txn.originalMode;
  if (exact === 1) {
    if (mode & 0o022) {
      throw new InitError(
        `allowed_signers at ${path} is group/world writable (mode 0o${mode.toString(8)}) — refuse (kept as-is)`,
      );
    }
    if (!fromLegacy) txn.chmodSigners(0o600);
    return;
  }
  // A last line without its newline would otherwise run into the new entry, breaking both.
  const last = txn.original.at(-1);
  const separator = last === undefined || last === 0x0a ? '' : '\n';
  txn.appendSigners(Buffer.from(`${separator}${line}`, 'utf8'));
}

// --- the command ------------------------------------------------------------------------------

async function ask(deps: InitDeps, question: string, fallback: string | null): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  let raw: string;
  try {
    raw = pyStrip(await (deps.prompt as (q: string) => Promise<string>)(`${question}${suffix}: `));
  } catch {
    throw new InitError('prompt cancelled');
  }
  return raw === '' && fallback !== null ? fallback : raw;
}

async function collectConfig(args: InitArgs, deps: InitDeps, interactive: boolean) {
  const env = deps.env;
  const home = deps.home;
  const homeOpt = home === undefined ? {} : { home };
  if (args.fromLegacy) {
    const legacy = legacyValues(home);
    let isDir = false;
    try {
      isDir = statSync(legacy.ownerRoomDir).isDirectory();
    } catch {}
    if (!isDir) {
      throw new InitError(
        `--from-legacy requires ${legacy.ownerRoomDir} to exist (reads legacy paths; never writes through them)`,
      );
    }
    return buildConfig(
      {
        ownerRoom: legacy.ownerRoom,
        ownerRoomDir: legacy.ownerRoomDir,
        mailRoot: resolveMailRoot(args.mailRoot, env, home),
        marker: legacy.marker,
        label: legacy.label,
        initialChannel: legacy.initialChannel,
      },
      { env, ...homeOpt, explicit: ['mail_root', 'marker', 'label', 'initial_channel'] },
    );
  }

  const prompting = interactive && deps.prompt !== undefined;
  let { ownerRoom, ownerRoomDir, marker, label, mailRoot, initialChannel } = args;
  if (ownerRoom === undefined && prompting) ownerRoom = await ask(deps, 'owner_room', null);
  if (ownerRoomDir === undefined && prompting) {
    const raw = await ask(deps, 'owner_room_dir (absolute)', null);
    ownerRoomDir = raw === '' ? undefined : raw;
  }
  if (!ownerRoom || ownerRoomDir === undefined) {
    throw new InitError(
      'owner_room and owner_room_dir are required (pass flags, or run interactively on a TTY)',
    );
  }
  if (prompting) {
    if (marker === undefined) marker = (await ask(deps, 'marker', DEFAULT_MARKER)) || undefined;
    if (label === undefined) {
      label = (await ask(deps, 'label', defaultLabelFor(ownerRoom))) || undefined;
    }
    if (mailRoot === undefined) {
      const raw = await ask(deps, 'mail_root', resolveMailRoot(undefined, env, home));
      mailRoot = raw === '' ? undefined : raw;
    }
    if (initialChannel === undefined) {
      initialChannel = (await ask(deps, 'initial_channel', DEFAULT_INITIAL_CHANNEL)) || undefined;
    }
  }
  const input: ConfigInput = {
    ownerRoom,
    ownerRoomDir,
    // The resolved mail root is always written: explicit flag, then POST_MAIL_ROOT, then default.
    mailRoot: resolveMailRoot(mailRoot, env, home),
  };
  const explicit: ConfigKey[] = ['mail_root'];
  const optional: [keyof InitArgs & keyof ConfigInput, ConfigKey][] = [
    ['marker', 'marker'],
    ['label', 'label'],
    ['initialChannel', 'initial_channel'],
    ['sidecarDir', 'sidecar_dir'],
    ['allowedSigners', 'allowed_signers'],
    ['keyFile', 'key_file'],
    ['signingNamespace', 'signing_namespace'],
    ['principal', 'principal'],
  ];
  const given: Partial<Record<string, string | undefined>> = {
    marker,
    label,
    initialChannel,
    sidecarDir: args.sidecarDir,
    allowedSigners: args.allowedSigners,
    keyFile: args.keyFile,
    signingNamespace: args.signingNamespace,
    principal: args.principal,
  };
  for (const [field, key] of optional) {
    const value = given[field];
    if (value !== undefined) {
      (input as Record<string, unknown>)[field] = value;
      explicit.push(key);
    }
  }
  return buildConfig(input, { env, ...homeOpt, explicit });
}

/**
 * Run `porch-next init` with command-line `argv` (the words after `init`). Returns the exit code:
 * 0 on success or an identical existing config, 2 for refusals and bad input, 4 for key and
 * filesystem failures.
 */
export async function runInit(argv: readonly string[], deps: InitDeps): Promise<number> {
  try {
    return await initInner(argv, deps);
  } catch (err) {
    if (err instanceof InitError) {
      deps.stderr(`porch-next init: ${err.message}`);
      return err.exitCode;
    }
    if (err instanceof ConfigError) {
      deps.stderr(`porch-next init: ${err.message}`);
      return 2;
    }
    // A filesystem error nothing above expected (a file removed mid-run, a full disk).
    if (typeof (err as NodeJS.ErrnoException)?.code === 'string') {
      deps.stderr(`porch-next init: ${(err as Error).message}`);
      return 4;
    }
    throw err;
  }
}

/**
 * Whether a config already at `path` resolves to the same identity (`true`), or none exists
 * (`false`). A different, malformed or symlinked one is refused.
 */
function existingConfigIdentical(
  path: string,
  cfg: PorchConfig,
  home: string | undefined,
): boolean {
  if (!lexists(path)) return false;
  if (isSymlink(path)) throw new InitError(`refusing symlink at config path ${path}`);
  const raw = readRegularHeld(path, MAX_CONFIG_BYTES, 'config').data;
  let existing: PorchConfig;
  try {
    existing = loadConfigBytes(raw, { env: {}, ...(home === undefined ? {} : { home }) });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new InitError(`existing config is malformed: ${err.message}`);
    }
    throw err;
  }
  if (configsResolveIdentical(existing, cfg)) return true;
  throw new InitError(`config already exists at ${path} with different values — refuse`);
}

/** Roll back; if anything could not be undone, say what, alongside the cause. */
function settle(txn: InitTransaction, cause: unknown): void {
  const problems = txn.rollback();
  if (problems.length === 0) return;
  const why = cause === null ? '' : ` (caused by: ${(cause as Error)?.message ?? String(cause)})`;
  throw new InitError(`rollback incomplete — ${problems.join('; ')}${why}`, 4);
}

async function initInner(argv: readonly string[], deps: InitDeps): Promise<number> {
  const args = parseInitArgs(argv);
  if (args.help) {
    deps.stdout(INIT_USAGE);
    return 0;
  }
  const home = deps.home;
  const path = args.config ? pyPath(args.config) : configPath(deps.env, home);
  const interactive = deps.isTty;
  const cfg = await collectConfig(args, deps, interactive);
  const postOpts = {
    env: deps.env,
    ...(deps.run === undefined ? {} : { run: deps.run }),
    ...(deps.post === undefined ? {} : { post: deps.post }),
  };

  // First preflight: post's owner anchor must be configured and agree field for field.
  let owner: Awaited<ReturnType<typeof fetchOwnerShow>>;
  try {
    owner = await fetchOwnerShow(cfg, postOpts);
  } catch (err) {
    if (err instanceof OwnerShowError) throw new InitError(err.message);
    throw err;
  }
  const mismatches = ownerFieldMismatches(cfg, owner);
  if (mismatches.length > 0) {
    throw new InitError(
      `post owner fields disagree with porch config — refuse before mutation: ${mismatches.join('; ')}`,
    );
  }
  // Second preflight: post's acting room, resolved from the owner room directory.
  try {
    await assertActingRoom(cfg, postOpts);
  } catch (err) {
    if (err instanceof RoomInvariantError) throw new InitError(err.message);
    throw err;
  }

  if (existingConfigIdentical(path, cfg, home)) {
    deps.stdout(`porch-next init: config already present and identical at ${path}`);
    return 0;
  }

  const flock = deps.flock ?? loadFlock();
  const kg: Keygen = {
    run: deps.run ?? runCommand,
    program: deps.sshKeygen ?? 'ssh-keygen',
    tmp: deps.tmpDir ?? tmpdir(),
  };
  const txn = await InitTransaction.begin(cfg.allowedSigners, flock);
  let identical: boolean;
  try {
    // Again under the lock: a concurrent init may have finished while this one waited.
    identical = existingConfigIdentical(path, cfg, home);
    if (!identical) {
      const pubCore = await ensureKeypair(cfg, txn, interactive, deps, kg);
      appendAllowedSigners(cfg, txn, pubCore, args.fromLegacy);
      writeConfigAtomic(cfg, path, home);
    }
  } catch (err) {
    settle(txn, err);
    throw err;
  }
  if (identical) {
    settle(txn, null); // undoes only a signers file this run created while waiting
    deps.stdout(`porch-next init: config already present and identical at ${path}`);
    return 0;
  }
  txn.commit();
  deps.stdout(`porch-next init: wrote ${path}`);
  deps.stdout(`  owner_room     ${cfg.ownerRoom}`);
  deps.stdout(`  owner_room_dir ${cfg.ownerRoomDir}`);
  deps.stdout(`  mail_root      ${cfg.mailRoot}`);
  deps.stdout(`  key_file       ${cfg.keyFile}`);
  return 0;
}
