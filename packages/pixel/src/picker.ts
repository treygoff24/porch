/**
 * The avatar picker: build a valid format-1 pack from a few named choices instead of drawing 16×16
 * pixels by hand. A pack is one of the five hand-drawn generator characters (bot, critter, shroom,
 * kid, owl) with a variant, an accent, a second colour and an eye colour, or one of the finished
 * example packs (bolt, wisp, mochi, ribbit, blob; never trey, whose cyan is the owner's) with an
 * accent of its own. Optional premade emotes ride along.
 *
 * Every choice is checked and every failure names the valid choices, because the reader is usually
 * an agent that will retry from the message. Every pack returned has passed `parseAvatar`, the same
 * validator post runs, including the freeze limit on each emote, and never trips the impersonation
 * cap: nothing here offers an accent that Porch would refuse at render.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAvatar } from './avatar.ts';
import {
  type CharacterChoices,
  type CharacterInfo,
  characterAvatar,
  characterColours,
  characterInfo,
  DEFAULT_CHARACTERS,
} from './generator.ts';
import { ACCENT_ALLOWED, applyImpersonationCap, framePixels, PALETTE_NAMES } from './palette.ts';
import { PREMADE_EMOTES } from './premade-emotes.ts';
import type { AvatarPack, EmoteDef } from './types.ts';

export type PickerRequest = {
  /** A character name or a preset name. */
  character: string;
  variant?: number;
  /** A palette digit or colour name. */
  accent?: string;
  secondary?: string;
  eyes?: string;
  emotes?: readonly string[];
};

export type PickerResult =
  | { ok: true; pack: AvatarPack; summary: string; text: string }
  | { ok: false; error: string };

/** The finished example packs offered as presets, in listing order. */
export const PRESET_NAMES: readonly string[] = ['bolt', 'wisp', 'mochi', 'ribbit', 'blob'];

const PRESET_BLURBS: Readonly<Record<string, string>> = {
  bolt: 'a blue robot with a green screen face and a beep-boop emote',
  wisp: 'a ghost that floats and can boo',
  mochi: 'a cat that loafs and kneads',
  ribbit: 'a frog that hops and croaks',
  blob: 'a pink slime; the simplest pack, one pose',
};

/** The accent each character wears when the caller names none: its own natural colour. */
const DEFAULT_ACCENT: Readonly<Record<string, string>> = {
  bot: '4',
  critter: '9',
  shroom: 'b',
  kid: '6',
  owl: 'c',
};

const EXAMPLES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../examples');

const colourName = (digit: string) =>
  `${PALETTE_NAMES[Number.parseInt(digit, 16)] ?? '?'} (${digit})`;
const colourList = (digits: readonly string[]) => digits.map(colourName).join(', ');

/** A palette digit from a digit or a colour name (any case), or undefined when it is neither. */
export function parseColour(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  if (/^[0-9a-f]$/.test(t)) return t;
  const i = PALETTE_NAMES.indexOf(t);
  return i >= 0 ? i.toString(16) : undefined;
}

export const isPreset = (name: string) => PRESET_NAMES.includes(name);

export function presetPack(name: string): AvatarPack {
  if (!isPreset(name)) throw new Error(`no preset ${name}`);
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, `${name}.json`), 'utf8')) as AvatarPack;
}

/** Plain text for `porch-next avatar list`: every character, preset and emote with its choices. */
export function listText(): string {
  const out: string[] = [
    'Porch avatars: pick a character, then set it with',
    '  porch-next avatar set <character> [--variant N] [--accent X] [--secondary X] [--eyes X] [--emote NAME...]',
    'See it first with `porch-next avatar preview <character> [same options] [--plain]`.',
    'Colours are palette digits (0-9, a-f) or names, shown as name (digit).',
    '',
    'CHARACTERS (every one has all standard poses, a blink and a talking head)',
  ];
  for (const { name } of DEFAULT_CHARACTERS) {
    const info = characterInfo(name) as CharacterInfo;
    const accent = DEFAULT_ACCENT[name] as string;
    out.push(
      '',
      `${name}: ${info.blurb}`,
      `  variants (--variant N, default 0): ${info.variants.map((v, i) => `${i} ${v}`).join('; ')}`,
      `  --accent (default ${colourName(accent)}): ${colourList(info.accents)}`,
      `  --secondary, the ${info.secondaryLabel} (default ${colourName(characterColours(name, Number.parseInt(accent, 16), 'secondary').default)}): ${colourList(info.secondaryOptions)}`,
      `  --eyes, the ${info.eyesLabel} (default ${colourName(characterColours(name, Number.parseInt(accent, 16), 'eyes').default)}): ${colourList(info.eyesOptions)}`,
      '  A secondary or eye colour equal to the accent (or to the face it sits on) is refused.',
    );
  }
  out.push(
    '',
    'PRESETS (finished drawings; only --accent can change them)',
    `  --accent: ${colourList(ACCENT_ALLOWED.map((a) => a.toString(16)))}`,
  );
  for (const name of PRESET_NAMES) {
    out.push(`${name}: ${PRESET_BLURBS[name]} (accent ${colourName(presetPack(name).accent)})`);
  }
  out.push('', 'EMOTES (--emote NAME, any number; these work for every character and preset)');
  for (const [name, e] of Object.entries(PREMADE_EMOTES)) out.push(`${name}: ${e.about}`);
  out.push(
    '',
    "Not offered: accents 0 ink, 1 night, 5 cyan, 8 lemon, a red (Porch refuses them), or trey (cyan is the owner's).",
  );
  return `${out.join('\n')}\n`;
}

const fail = (error: string): PickerResult => ({ ok: false, error });

/**
 * Build, validate and describe the avatar a request asks for. `text` is the pack as pretty JSON,
 * exactly the bytes to hand to `post profile avatar set --file`.
 */
export function buildAvatar(req: PickerRequest): PickerResult {
  const name = req.character.trim().toLowerCase();
  const characters = DEFAULT_CHARACTERS.map((c) => c.name);
  const info = characterInfo(name);
  if (info === undefined && !isPreset(name)) {
    return fail(
      `unknown character "${req.character}". Characters: ${characters.join(', ')}. Presets: ${PRESET_NAMES.join(', ')}. (\`porch-next avatar list\` describes them.)`,
    );
  }

  let accentDigit: string | undefined;
  if (req.accent !== undefined) {
    accentDigit = parseColour(req.accent);
    const allowed =
      info === undefined ? ACCENT_ALLOWED.map((a) => a.toString(16)) : [...info.accents];
    if (accentDigit === undefined || !allowed.includes(accentDigit)) {
      return fail(
        `accent "${req.accent}" is not available for ${name}. Accents: ${colourList(allowed)}.`,
      );
    }
  }

  let pack: AvatarPack;
  const parts: string[] = [name];
  if (info === undefined) {
    for (const [flag, v] of [
      ['--variant', req.variant],
      ['--secondary', req.secondary],
      ['--eyes', req.eyes],
    ] as const) {
      if (v !== undefined) {
        return fail(`${name} is a finished preset: only --accent can change it, not ${flag}.`);
      }
    }
    const base = presetPack(name);
    pack = accentDigit === undefined ? base : { ...base, accent: accentDigit };
    parts.push(`accent ${colourName(pack.accent)}`);
  } else {
    const variant = req.variant ?? 0;
    if (!Number.isInteger(variant) || variant < 0 || variant >= info.variants.length) {
      return fail(
        `variant ${req.variant} does not exist for ${name}. Variants: ${info.variants.map((v, i) => `${i} ${v}`).join('; ')}.`,
      );
    }
    const accent = accentDigit ?? (DEFAULT_ACCENT[name] as string);
    const accentIndex = Number.parseInt(accent, 16);
    const choices: { secondary?: string; eyes?: string } = {};
    for (const role of ['secondary', 'eyes'] as const) {
      const given = req[role];
      const label = role === 'secondary' ? info.secondaryLabel : info.eyesLabel;
      const flag = `--${role}`;
      const { default: dflt, options } = characterColours(name, accentIndex, role);
      let digit = dflt;
      if (given !== undefined) {
        const parsed = parseColour(given);
        if (parsed === undefined || !options.includes(parsed)) {
          const all = role === 'secondary' ? info.secondaryOptions : info.eyesOptions;
          return fail(
            `${flag} "${given}" is not available for the ${name}'s ${label}${all.includes(parsed ?? '') ? ` with accent ${colourName(accent)} (it would vanish into the body)` : ''}. Choices here: ${colourList(options)}.`,
          );
        }
        digit = parsed;
        choices[role] = parsed;
      }
      parts.push(`${label} ${colourName(digit)}`);
    }
    pack = characterAvatar(
      name,
      variant,
      accentIndex,
      [0, 0, 2],
      choices satisfies CharacterChoices,
    );
    parts.splice(
      1,
      0,
      `variant ${variant} (${info.variants[variant]})`,
      `accent ${colourName(accent)}`,
    );
  }

  const emotes = [...new Set(req.emotes ?? [])];
  if (emotes.length > 0) {
    const custom: Record<string, EmoteDef> = { ...(pack.emotes ?? {}) };
    for (const e of emotes) {
      const premade = Object.hasOwn(PREMADE_EMOTES, e) ? PREMADE_EMOTES[e] : undefined;
      if (premade === undefined) {
        return fail(
          `unknown emote "${e}". Premade emotes: ${Object.keys(PREMADE_EMOTES).join(', ')}.`,
        );
      }
      if (Object.hasOwn(custom, e)) return fail(`${name} already has an emote named ${e}.`);
      // A pack may only name poses it draws; a pose it lacks plays as idle anyway, so say idle.
      custom[e] = {
        steps: premade.def.steps.map((st) =>
          Object.hasOwn(pack.body, st.pose) ? st : { ...st, pose: 'idle' },
        ),
      };
    }
    pack = { ...pack, emotes: custom };
    parts.push(`emotes ${emotes.join(', ')}`);
  }

  const text = `${JSON.stringify(pack, null, 2)}\n`;
  const checked = parseAvatar(new TextEncoder().encode(text));
  if (checked.rules.length > 0) {
    return fail(
      `the pack failed validation (${checked.rules.join(', ')}); this is a bug in the picker.`,
    );
  }
  const accent = Number.parseInt(pack.accent, 16);
  for (const [target, frames] of [
    ['body', pack.body],
    ['head', pack.head],
  ] as const) {
    for (const [pose, rows] of Object.entries(frames)) {
      const px = framePixels(rows);
      const capped = applyImpersonationCap(px, target, { isOwner: false }, accent);
      if (JSON.stringify(capped) !== JSON.stringify(px)) {
        return fail(
          `the ${target} frame ${pose} would be redrawn in one colour at render (too many cyan, lemon or red pixels); choose other colours.`,
        );
      }
    }
  }
  return { ok: true, pack, summary: parts.join(', '), text };
}
