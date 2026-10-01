/**
 * `porch-next avatar`: pick an avatar in one command instead of drawing a pack by hand. `list`
 * describes the characters, presets and emotes; `preview` prints one in the terminal; `set` builds
 * the pack, validates it with the same validator post runs, and stores it with
 * `post profile avatar set --file`. The building and checking live in `@estate/pixel`'s picker;
 * this file is argument parsing, printing and the post call.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AvatarPack,
  buildAvatar,
  framePixels,
  listText,
  type PickerRequest,
  SPRITE_PALETTE,
  toHalfBlocks,
} from '@estate/pixel';
import { type Runner, setAvatarFile } from '@estate/post-kit';

export const AVATAR_USAGE = `usage: porch-next avatar list
       porch-next avatar preview <character> [--variant N] [--accent X] [--secondary X] [--eyes X] [--plain]
       porch-next avatar set <character> [--variant N] [--accent X] [--secondary X] [--eyes X] [--emote NAME...] [--dry-run]
\`list\` shows every character, preset, colour and emote.
`;

export type AvatarDeps = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** Replaces spawning `post` in tests; absent, post-kit runs the real binary. */
  run?: Runner;
};

/** What post said, as an exit status and the two streams. */
type PostResult = { status: number; stdout: string; stderr: string };

type Parsed = { positional: string[]; request: PickerRequest; plain: boolean; dryRun: boolean };

const VALUE_FLAGS = new Set(['--variant', '--accent', '--secondary', '--eyes', '--emote']);

/** Flags and values, `--flag value` or `--flag=value`; `--emote` takes every name that follows. */
function parseArgs(argv: readonly string[]): Parsed | string {
  const positional: string[] = [];
  const emotes: string[] = [];
  const values: Record<string, string> = {};
  let plain = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === '--plain') plain = true;
    else if (flag === '--dry-run') dryRun = true;
    else if (VALUE_FLAGS.has(flag)) {
      const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
      const first = inline ?? argv[++i];
      if (first === undefined || (inline === undefined && first.startsWith('--'))) {
        return `${flag} needs a value`;
      }
      if (flag === '--emote') {
        emotes.push(...first.split(',').filter((e) => e !== ''));
        while (
          inline === undefined &&
          argv[i + 1] !== undefined &&
          !argv[i + 1]?.startsWith('--')
        ) {
          emotes.push(...(argv[++i] as string).split(',').filter((e) => e !== ''));
        }
      } else values[flag] = first;
    } else if (arg.startsWith('-')) return `unknown option ${arg}`;
    else positional.push(arg);
  }
  const request: PickerRequest = { character: positional[0] ?? '' };
  if (values['--variant'] !== undefined) {
    const n = Number(values['--variant']);
    if (!/^\d+$/.test(values['--variant']) || !Number.isSafeInteger(n)) {
      return `--variant needs a whole number, not "${values['--variant']}"`;
    }
    request.variant = n;
  }
  if (values['--accent'] !== undefined) request.accent = values['--accent'];
  if (values['--secondary'] !== undefined) request.secondary = values['--secondary'];
  if (values['--eyes'] !== undefined) request.eyes = values['--eyes'];
  if (emotes.length > 0) request.emotes = emotes;
  return { positional, request, plain, dryRun };
}

const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
const fg = (hex: string) => `\x1b[38;2;${channel(hex, 1)};${channel(hex, 3)};${channel(hex, 5)}m`;
const bg = (hex: string) => `\x1b[48;2;${channel(hex, 1)};${channel(hex, 3)};${channel(hex, 5)}m`;

/** A frame as truecolor half-block cells in Porch's sprite palette, one terminal row per two. */
export function frameAnsi(rows: readonly string[]): string {
  return toHalfBlocks(framePixels(rows), SPRITE_PALETTE)
    .map(
      (row) =>
        `${row
          .map((cell) =>
            cell === null
              ? ' '
              : `${fg(cell.fg)}${cell.bg === null ? '\x1b[49m' : bg(cell.bg)}${cell.ch}`,
          )
          .join('')}\x1b[0m`,
    )
    .join('\n');
}

/** A frame as the digits it is drawn in, `.` for transparent. */
export const framePlain = (rows: readonly string[]) => rows.join('\n');

function preview(pack: AvatarPack, summary: string, plain: boolean): string {
  const lines = [summary, '', 'body (idle, 16x16)'];
  lines.push(plain ? framePlain(pack.body.idle) : frameAnsi(pack.body.idle));
  lines.push('', 'head (idle, 8x8)');
  lines.push(plain ? framePlain(pack.head.idle) : frameAnsi(pack.head.idle));
  if (plain) {
    const used = [
      ...new Set((pack.body.idle.join('') + pack.head.idle.join('')).replaceAll('.', '')),
    ].sort();
    lines.push(
      '',
      `colours used: ${used.join(' ')} ("." is transparent; \`porch-next avatar list\` names the digits)`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Post's success reply is one JSON object that echoes the whole avatar; keep only its warnings. */
function postVerdict(stdout: string): { warnings: string[] } | undefined {
  try {
    const v = JSON.parse(stdout) as { ok?: unknown; warnings?: unknown };
    if (v.ok !== true) return undefined;
    const warnings = Array.isArray(v.warnings) ? v.warnings.map((w) => String(w)) : [];
    return { warnings };
  } catch {
    return undefined;
  }
}

export async function runAvatar(argv: readonly string[], deps: AvatarDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    deps.stdout(AVATAR_USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub === 'list') {
    deps.stdout(listText());
    return 0;
  }
  if (sub !== 'preview' && sub !== 'set') {
    deps.stderr(`porch-next avatar: unknown subcommand ${sub}\n${AVATAR_USAGE}`);
    return 2;
  }
  const parsed = parseArgs(rest);
  if (typeof parsed === 'string') {
    deps.stderr(`porch-next avatar ${sub}: ${parsed}\n${AVATAR_USAGE}`);
    return 2;
  }
  if (parsed.positional.length !== 1) {
    deps.stderr(
      `porch-next avatar ${sub}: name one character or preset (see \`porch-next avatar list\`)\n`,
    );
    return 2;
  }
  if (sub === 'preview' && parsed.request.emotes !== undefined) {
    deps.stderr(
      'porch-next avatar preview: --emote applies to `set` (emotes are not drawn here)\n',
    );
    return 2;
  }
  const built = buildAvatar(parsed.request);
  if (!built.ok) {
    deps.stderr(`porch-next avatar ${sub}: ${built.error}\n`);
    return 2;
  }
  if (sub === 'preview') {
    const plain = parsed.plain || (deps.env.NO_COLOR ?? '') !== '';
    deps.stdout(preview(built.pack, built.summary, plain));
    return 0;
  }
  if (parsed.dryRun) {
    deps.stdout(built.text);
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), 'porch-avatar-'));
  try {
    const file = join(dir, 'avatar.json');
    writeFileSync(file, built.text);
    const bin = deps.env.PORCH_POST_BIN ?? 'post';
    const out = await setAvatarFile(file, {
      executable: bin,
      env: deps.env,
      ...(deps.run === undefined ? {} : { run: deps.run }),
    });
    const r: PostResult = {
      status: out.code ?? 1,
      stdout: out.stdout,
      stderr:
        out.failed !== undefined && out.stderr === ''
          ? (out.detail ?? `post did not finish (${out.failed})`)
          : out.stderr,
    };
    const verdict = postVerdict(r.stdout);
    if (r.status === 0 && verdict !== undefined) {
      deps.stdout(`avatar set: ${built.summary}\n`);
      for (const w of verdict.warnings) deps.stdout(`post warning: ${w}\n`);
      if (r.stderr !== '') deps.stderr(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
      return 0;
    }
    if (r.stdout !== '') deps.stdout(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
    if (r.stderr !== '') deps.stderr(r.stderr.endsWith('\n') ? r.stderr : `${r.stderr}\n`);
    if (r.status === 0) deps.stdout(`avatar set: ${built.summary}\n`);
    else
      deps.stderr(
        `porch-next avatar set: post refused it (exit ${r.status}); nothing was stored.\n`,
      );
    return r.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
