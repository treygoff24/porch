/**
 * porch-tui's identity config (`~/.config/porch/config.toml`, or `$PORCH_CONFIG`), read the way
 * `src/porch3/config.py` reads it. porch-tui refuses unknown keys, so porch-next adds none; its own
 * settings live elsewhere (`settings.ts`).
 *
 * Path fields hold `pathlib` strings (`pypath.ts`), because porch-tui hashes and compares them as
 * strings. Field names are camelCase here; the TOML keys are porch-tui's.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { pyLen, pyStrip } from '../stores/py.ts';
import { pyAbspath, pyExpandUser, pyHome, pyIsAbsolute, pyJoin, pyPath } from './pypath.ts';
import { parseFlatToml, TomlError, type TomlValue } from './toml.ts';

export const DEFAULT_MARKER = '🦊';
export const DEFAULT_OWNER_ACCENT = '#FFD700';
export const DEFAULT_INITIAL_CHANNEL = 'commons';
export const MAX_CONFIG_BYTES = 1 << 20;

/** Every key porch-tui's config may hold, in its emit order. */
export const CONFIG_KEYS = [
  'owner_room',
  'owner_room_dir',
  'mail_root',
  'sidecar_dir',
  'allowed_signers',
  'key_file',
  'signing_namespace',
  'principal',
  'marker',
  'label',
  'initial_channel',
  'owner_accent',
  'crossed_send_guard',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
const KNOWN = new Set<string>(CONFIG_KEYS);

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly field: ConfigKey | string | null = null,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type PorchConfig = {
  readonly ownerRoom: string;
  readonly ownerRoomDir: string;
  readonly mailRoot: string;
  readonly sidecarDir: string;
  readonly allowedSigners: string;
  readonly keyFile: string;
  readonly signingNamespace: string;
  readonly principal: string;
  readonly marker: string;
  readonly label: string;
  readonly initialChannel: string;
  readonly ownerAccent: string;
  readonly crossedSendGuard: boolean;
  /** The optional keys present in the source (drives what an emit writes). */
  readonly explicitFields: ReadonlySet<ConfigKey>;
  /** The lexical absolute path the config was read from, or null when built in memory. */
  readonly sourcePath: string | null;
};

/** `<sidecar_dir>/sigs`. */
export const sigsDir = (c: PorchConfig) => pyJoin(c.sidecarDir, 'sigs');
/** `<mail_root>/channels`. */
export const channelsDir = (c: PorchConfig) => pyJoin(c.mailRoot, 'channels');
/** `<owner_room_dir>/decision-records.jsonl`. */
export const drLogPath = (c: PorchConfig) => pyJoin(c.ownerRoomDir, 'decision-records.jsonl');
/** The verified-sender label: `<label> (<owner_room>)`. */
export const verifiedRender = (c: PorchConfig) => `${c.label} (${c.ownerRoom})`;

// Post's refused_profile_char set: C0, DEL, C1, and the bidi and line-separator controls. ZWJ and
// VS16 stay legal inside a marker.
const BIDI_AND_CONTROLS = new Set<number>([
  ...Array.from({ length: 0x20 }, (_, k) => k),
  0x7f,
  ...Array.from({ length: 0x20 }, (_, k) => 0x80 + k),
  0x061c,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
  0x200e,
  0x200f,
  0x2028,
  0x2029,
]);
const ZWJ = '‍';
const PRINCIPAL = /^[A-Za-z0-9._@-]{1,128}$/;
const NAMESPACE = /^[A-Za-z0-9._@-]{1,64}$/;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function rejectControls(value: string, field: string): void {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (BIDI_AND_CONTROLS.has(c) || ch === '\n' || ch === '\r' || ch === '\t') {
      throw new ConfigError(
        `config field '${field}' rejects control/bidi/newline characters`,
        field,
      );
    }
  }
}

/** Post's marker rule: exactly one extended grapheme cluster, no edge ZWJ, no controls, not ASCII. */
export function validateMarker(marker: unknown): string {
  if (typeof marker !== 'string') throw new ConfigError('marker must be a string', 'marker');
  if (marker === '') {
    throw new ConfigError('marker must be exactly one glyph (one grapheme cluster)', 'marker');
  }
  if (marker.startsWith(ZWJ) || marker.endsWith(ZWJ)) {
    throw new ConfigError(
      'marker must not start or end with a zero-width joiner (ZWJ-abuse refused)',
      'marker',
    );
  }
  if ([...graphemes.segment(marker)].length !== 1) {
    throw new ConfigError('marker must be exactly one glyph (one grapheme cluster)', 'marker');
  }
  for (const ch of marker) {
    if (BIDI_AND_CONTROLS.has(ch.codePointAt(0) ?? 0)) {
      throw new ConfigError(
        'marker contains control, bidi, or line-separator characters',
        'marker',
      );
    }
  }
  if (![...marker].some((c) => c.charCodeAt(0) > 0x7f)) {
    throw new ConfigError('marker must be a non-ASCII glyph, not ASCII', 'marker');
  }
  return marker;
}

export function validateLabel(label: unknown): string {
  if (typeof label !== 'string') throw new ConfigError('label must be a string', 'label');
  if (pyStrip(label) === '') {
    throw new ConfigError('label must not be empty or whitespace-only', 'label');
  }
  const n = pyLen(label);
  if (n < 1 || n > 32) throw new ConfigError('label must be 1-32 Unicode scalar values', 'label');
  rejectControls(label, 'label');
  return label;
}

export function validatePrincipal(principal: unknown): string {
  if (typeof principal !== 'string' || !PRINCIPAL.test(principal)) {
    throw new ConfigError('principal must match [A-Za-z0-9._@-]{1,128}', 'principal');
  }
  return principal;
}

export function validateNamespace(namespace: unknown): string {
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) {
    throw new ConfigError(
      'signing_namespace must match [A-Za-z0-9._@-]{1,64}',
      'signing_namespace',
    );
  }
  return namespace;
}

/** `room[0].upper() + room[1:]`. */
export function defaultLabelFor(room: string): string {
  if (room === '') return room;
  const first = String.fromCodePoint(room.codePointAt(0) ?? 0);
  return first.toUpperCase() + room.slice(first.length);
}
export const defaultPrincipal = (room: string) => `${room}@porch`;
export const defaultNamespace = (room: string) => `${room}-porch`;

/** Absolute, control-free, `~`-expanded path in pathlib form. */
export function validateAbsPath(value: unknown, field: string, home?: string): string {
  if (typeof value !== 'string') throw new ConfigError(`${field} must be a string or Path`, field);
  rejectControls(value, field);
  let path: string;
  try {
    path = pyExpandUser(value, home);
  } catch (err) {
    throw new ConfigError(`${field}: ${(err as Error).message}`, field);
  }
  if (!pyIsAbsolute(path)) throw new ConfigError(`${field} must be an absolute path`, field);
  return path;
}

type Env = Readonly<Record<string, string | undefined>>;

/** Explicit field, then a present `POST_MAIL_ROOT` (even empty, which then fails), then
 * `~/.claude-mail`. */
export function resolveMailRoot(explicit: unknown, env: Env, home?: string): string {
  if (explicit !== undefined) return validateAbsPath(explicit, 'mail_root', home);
  if (Object.hasOwn(env, 'POST_MAIL_ROOT') && env.POST_MAIL_ROOT !== undefined) {
    return validateAbsPath(env.POST_MAIL_ROOT, 'mail_root', home);
  }
  return pyJoin(pyHome(home), '.claude-mail');
}

export type ConfigInput = {
  ownerRoom: unknown;
  ownerRoomDir: unknown;
  mailRoot?: unknown;
  sidecarDir?: unknown;
  allowedSigners?: unknown;
  keyFile?: unknown;
  signingNamespace?: unknown;
  principal?: unknown;
  marker?: unknown;
  label?: unknown;
  initialChannel?: unknown;
  ownerAccent?: unknown;
  crossedSendGuard?: unknown;
};

/** porch-tui's `build_config`: validate, fill derived defaults, record which fields were given. */
export function buildConfig(
  input: ConfigInput,
  options: { env?: Env; home?: string; explicit?: Iterable<ConfigKey> } = {},
): PorchConfig {
  const env = options.env ?? process.env;
  const home = options.home;
  const explicit = new Set<ConfigKey>(options.explicit ?? []);
  const room = input.ownerRoom;
  if (typeof room !== 'string' || room === '') {
    throw new ConfigError('owner_room must be a non-empty string', 'owner_room');
  }
  rejectControls(room, 'owner_room');
  const roomDir = validateAbsPath(input.ownerRoomDir, 'owner_room_dir', home);
  const mailRoot = resolveMailRoot(input.mailRoot, env, home);
  if (input.mailRoot !== undefined) explicit.add('mail_root');

  let sidecarDir = roomDir;
  if (input.sidecarDir !== undefined) {
    sidecarDir = validateAbsPath(input.sidecarDir, 'sidecar_dir', home);
    explicit.add('sidecar_dir');
  }
  let allowedSigners = pyJoin(sidecarDir, 'allowed_signers');
  if (input.allowedSigners !== undefined) {
    allowedSigners = validateAbsPath(input.allowedSigners, 'allowed_signers', home);
    explicit.add('allowed_signers');
  }
  let keyFile = pyJoin(roomDir, `${room}_porch_key`);
  if (input.keyFile !== undefined) {
    keyFile = validateAbsPath(input.keyFile, 'key_file', home);
    explicit.add('key_file');
  }
  const signingNamespace = validateNamespace(input.signingNamespace ?? defaultNamespace(room));
  if (input.signingNamespace !== undefined) explicit.add('signing_namespace');
  const principal = validatePrincipal(input.principal ?? defaultPrincipal(room));
  if (input.principal !== undefined) explicit.add('principal');
  const marker = validateMarker(input.marker ?? DEFAULT_MARKER);
  if (input.marker !== undefined) explicit.add('marker');
  const label = validateLabel(input.label ?? defaultLabelFor(room));
  if (input.label !== undefined) explicit.add('label');

  const initialChannel = input.initialChannel ?? DEFAULT_INITIAL_CHANNEL;
  if (typeof initialChannel !== 'string' || initialChannel === '') {
    throw new ConfigError('initial_channel must be a non-empty string', 'initial_channel');
  }
  rejectControls(initialChannel, 'initial_channel');
  if (input.initialChannel !== undefined) explicit.add('initial_channel');

  const ownerAccent = input.ownerAccent ?? DEFAULT_OWNER_ACCENT;
  if (typeof ownerAccent !== 'string' || !HEX_COLOR.test(ownerAccent)) {
    throw new ConfigError('owner_accent must be a #RRGGBB hex color', 'owner_accent');
  }
  if (input.ownerAccent !== undefined) explicit.add('owner_accent');

  let crossedSendGuard = false;
  if (input.crossedSendGuard !== undefined) {
    if (typeof input.crossedSendGuard !== 'boolean') {
      throw new ConfigError('crossed_send_guard must be a boolean', 'crossed_send_guard');
    }
    crossedSendGuard = input.crossedSendGuard;
    explicit.add('crossed_send_guard');
  }

  return {
    ownerRoom: room,
    ownerRoomDir: roomDir,
    mailRoot,
    sidecarDir,
    allowedSigners,
    keyFile,
    signingNamespace,
    principal,
    marker,
    label,
    initialChannel,
    ownerAccent,
    crossedSendGuard,
    explicitFields: explicit,
    sourcePath: null,
  };
}

/** porch-tui's `parse_config_dict`: a flat document, unknown keys refused. */
export function parseConfigDocument(
  data: ReadonlyMap<string, TomlValue>,
  options: { env?: Env; home?: string } = {},
): PorchConfig {
  const unknown = [...data.keys()].filter((k) => !KNOWN.has(k)).sort();
  if (unknown.length > 0) {
    throw new ConfigError(`unknown config field '${unknown[0]}'`, unknown[0]);
  }
  for (const key of ['owner_room', 'owner_room_dir'] as const) {
    if (!data.has(key)) throw new ConfigError(`missing required field '${key}'`, key);
  }
  const room = data.get('owner_room');
  if (typeof room !== 'string') throw new ConfigError('owner_room must be a string', 'owner_room');
  rejectControls(room, 'owner_room');
  if (room === '') throw new ConfigError('owner_room must be non-empty', 'owner_room');
  if (typeof data.get('owner_room_dir') !== 'string') {
    throw new ConfigError('owner_room_dir must be a string path', 'owner_room_dir');
  }
  const pick = (k: ConfigKey) => (data.has(k) ? data.get(k) : undefined);
  const explicit = CONFIG_KEYS.filter((k) => data.has(k));
  return buildConfig(
    {
      ownerRoom: room,
      ownerRoomDir: data.get('owner_room_dir'),
      mailRoot: pick('mail_root'),
      sidecarDir: pick('sidecar_dir'),
      allowedSigners: pick('allowed_signers'),
      keyFile: pick('key_file'),
      signingNamespace: pick('signing_namespace'),
      principal: pick('principal'),
      marker: pick('marker'),
      label: pick('label'),
      initialChannel: pick('initial_channel'),
      ownerAccent: pick('owner_accent'),
      crossedSendGuard: pick('crossed_send_guard'),
    },
    { ...options, explicit },
  );
}

/** Parse config bytes already read (no reopen): UTF-8, TOML, then the field rules. */
export function loadConfigBytes(
  raw: Uint8Array,
  options: { env?: Env; home?: string; sourcePath?: string } = {},
): PorchConfig {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new ConfigError('config bytes are not valid UTF-8');
  }
  let data: Map<string, TomlValue>;
  try {
    data = parseFlatToml(text);
  } catch (err) {
    if (err instanceof TomlError) throw new ConfigError(`malformed TOML: ${err.message}`);
    throw err;
  }
  const config = parseConfigDocument(data, options);
  return options.sourcePath === undefined
    ? config
    : { ...config, sourcePath: pyAbspath(options.sourcePath) };
}

export class HeldReadError extends Error {
  constructor(
    message: string,
    readonly kind: 'open' | 'not-regular' | 'too-large' | 'io',
  ) {
    super(message);
    this.name = 'HeldReadError';
  }
}

/**
 * porch-tui's `held_read_regular_nofollow`: open once `O_NOFOLLOW|O_NONBLOCK`, require a regular
 * file, read to EOF with a strict `limit + 1` bound. Returns the bytes and that descriptor's stat.
 * A missing file rethrows the ENOENT error.
 */
export function heldReadRegular(path: string, limit: number, label = 'file') {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    throw new HeldReadError(`cannot open ${label}: ${(err as Error).message}`, 'open');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new HeldReadError(
        `${label} must be a regular file (symlink/FIFO/directory refused)`,
        'not-regular',
      );
    }
    if (stat.size > limit) throw new HeldReadError(`${label} exceeds ${limit} bytes`, 'too-large');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const want = Math.min(65536, limit + 1 - total);
      if (want <= 0) break;
      const chunk = Buffer.alloc(want);
      let got: number;
      try {
        got = readChunk(fd, chunk);
      } catch (err) {
        throw new HeldReadError(`cannot read ${label}: ${(err as Error).message}`, 'io');
      }
      if (got === 0) break;
      chunks.push(chunk.subarray(0, got));
      total += got;
      if (total > limit) throw new HeldReadError(`${label} exceeds ${limit} bytes`, 'too-large');
    }
    return { data: Buffer.concat(chunks), stat };
  } finally {
    closeSync(fd);
  }
}

function readChunk(fd: number, chunk: Buffer): number {
  return readSync(fd, chunk, 0, chunk.length, null);
}

/** The config path porch-tui reads: `$PORCH_CONFIG` when set and non-empty, else
 * `~/.config/porch/config.toml`. */
export function configPath(env: Env = process.env, home?: string): string {
  const override = env.PORCH_CONFIG;
  return override !== undefined && override !== ''
    ? pyPath(override)
    : pyJoin(pyHome(home), '.config', 'porch', 'config.toml');
}

/**
 * Read and validate porch-tui's config. A missing file is a {@link ConfigError} naming
 * `porch-next init`.
 */
export function loadPorchConfig(
  options: { path?: string; env?: Env; home?: string } = {},
): PorchConfig {
  const env = options.env ?? process.env;
  const path = options.path ?? configPath(env, options.home);
  let raw: Buffer;
  try {
    raw = heldReadRegular(path, MAX_CONFIG_BYTES, 'config').data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`missing config at ${path} — run \`porch-next init\``);
    }
    if (err instanceof HeldReadError) {
      if (err.kind === 'open') {
        throw new ConfigError(
          `config path ${path} exists but is unreadable/non-followable: ${err.message}`,
        );
      }
      if (err.kind === 'not-regular') {
        throw new ConfigError(
          `config at ${path} must be a regular file (symlink/FIFO/directory refused)`,
        );
      }
      if (err.kind === 'too-large') {
        throw new ConfigError(`config at ${path} exceeds ${MAX_CONFIG_BYTES} bytes — refuse`);
      }
      throw new ConfigError(`config at ${path}: ${err.message}`);
    }
    throw err;
  }
  try {
    return loadConfigBytes(raw, {
      env,
      sourcePath: path,
      ...(options.home === undefined ? {} : { home: options.home }),
    });
  } catch (err) {
    if (err instanceof ConfigError && err.message === 'config bytes are not valid UTF-8') {
      throw new ConfigError(`config at ${path} is not valid UTF-8`);
    }
    if (err instanceof ConfigError && err.message.startsWith('malformed TOML: ')) {
      throw new ConfigError(`malformed TOML at ${path}: ${err.message.slice(16)}`);
    }
    throw err;
  }
}

/** The fields porch-tui writes, in its order, omitting derived optionals. */
export function emitEntries(c: PorchConfig): [ConfigKey, string | boolean][] {
  const out: [ConfigKey, string | boolean][] = [
    ['owner_room', c.ownerRoom],
    ['owner_room_dir', c.ownerRoomDir],
    ['marker', c.marker],
    ['label', c.label],
  ];
  const has = (k: ConfigKey) => c.explicitFields.has(k);
  if (has('mail_root')) out.push(['mail_root', c.mailRoot]);
  if (has('sidecar_dir')) out.push(['sidecar_dir', c.sidecarDir]);
  if (has('allowed_signers')) out.push(['allowed_signers', c.allowedSigners]);
  if (has('key_file')) out.push(['key_file', c.keyFile]);
  if (has('signing_namespace')) out.push(['signing_namespace', c.signingNamespace]);
  if (has('principal')) out.push(['principal', c.principal]);
  if (has('initial_channel') || c.initialChannel !== DEFAULT_INITIAL_CHANNEL) {
    out.push(['initial_channel', c.initialChannel]);
  }
  if (has('owner_accent') || c.ownerAccent !== DEFAULT_OWNER_ACCENT) {
    out.push(['owner_accent', c.ownerAccent]);
  }
  if (has('crossed_send_guard') || c.crossedSendGuard) {
    out.push(['crossed_send_guard', c.crossedSendGuard]);
  }
  return out;
}

function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (BIDI_AND_CONTROLS.has(c) || ch === '\n' || ch === '\r') {
      throw new ConfigError('cannot emit TOML string containing control/newline characters');
    }
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else out += ch;
  }
  return `${out}"`;
}

/** porch-tui's `emit_toml`: the exact bytes `porch init` writes. */
export function emitToml(c: PorchConfig): string {
  return `${emitEntries(c)
    .map(([k, v]) => `${k} = ${typeof v === 'boolean' ? String(v) : tomlString(v)}`)
    .join('\n')}\n`;
}

/** The fields `porch init` compares to decide an existing config is identical. */
export function configsResolveIdentical(a: PorchConfig, b: PorchConfig): boolean {
  return (
    a.ownerRoom === b.ownerRoom &&
    a.ownerRoomDir === b.ownerRoomDir &&
    a.mailRoot === b.mailRoot &&
    a.sidecarDir === b.sidecarDir &&
    a.allowedSigners === b.allowedSigners &&
    a.keyFile === b.keyFile &&
    a.signingNamespace === b.signingNamespace &&
    a.principal === b.principal &&
    a.marker === b.marker &&
    a.label === b.label &&
    a.initialChannel === b.initialChannel &&
    a.ownerAccent === b.ownerAccent
  );
}

/** Compatibility values for `init --from-legacy`. */
export function legacyValues(home?: string) {
  return {
    ownerRoom: 'trey',
    ownerRoomDir: pyJoin(pyHome(home), '.trey-room'),
    marker: '🧔',
    label: 'Trey',
    initialChannel: DEFAULT_INITIAL_CHANNEL,
  } as const;
}

/** The seven owner fields `post owner show` reports, as strings. */
export type PostOwner = {
  readonly room: string;
  readonly sidecar_dir: string;
  readonly allowed_signers: string;
  readonly principal: string;
  readonly namespace: string;
  readonly marker: string;
  readonly label: string;
};

/** porch-tui's `owner_field_mismatches`: every duplicated field must be present and equal. */
export function ownerFieldMismatches(
  c: PorchConfig,
  post: Readonly<Record<string, unknown>>,
): string[] {
  const pairs: [string, string, string][] = [
    ['room', 'room', c.ownerRoom],
    ['sidecar_dir', 'sidecar_dir', c.sidecarDir],
    ['allowed_signers', 'allowed_signers', c.allowedSigners],
    ['principal', 'principal', c.principal],
    ['signing_namespace', 'namespace', c.signingNamespace],
    ['marker', 'marker', c.marker],
    ['label', 'label', c.label],
  ];
  const bad: string[] = [];
  for (const [name, key, expected] of pairs) {
    const got = post[key];
    if (got === undefined || got === null) {
      bad.push(`${name}: missing in post owner show`);
      continue;
    }
    if (String(got) !== expected) {
      bad.push(`${name}: porch=${JSON.stringify(expected)} post=${JSON.stringify(got)}`);
    }
  }
  return bad;
}
