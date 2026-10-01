/**
 * Avatar packs, format 1 (build plan I1): the validator that reports rule ids, and the canonical
 * form post stores. The rule ids and the evaluation order are the contract `contract/avatars/`
 * freezes, and post's Rust validator reports the same ids for the same bytes.
 *
 * Evaluation order: `input-too-large`, `json-syntax` and `duplicate-key` stop validation and are
 * reported alone. Otherwise every broken rule is reported, except that a member breaking a type,
 * null or grammar rule is not looked into further, and a rule that depends on it is skipped (an
 * emote whose `ms` is bad has no total to judge). `emote-freeze-too-large` and
 * `canonical-too-large` are judged only when nothing else broke.
 */
import { byteLength, canonicalJson } from './canonical.ts';
import { freezeEmote } from './freeze.ts';
import { type JsonValue, parseJsonBytes } from './json.ts';
import {
  type AvatarPack,
  BODY,
  type EmoteDef,
  type EmoteStep,
  type Frames,
  HEAD,
  MOTIONS,
  type Motion,
  NAME_GRAMMAR,
  PARTICLES,
  type ParticleKind,
  STANDARD_POSES,
} from './types.ts';

export const MAX_INPUT_BYTES = 32768;
export const MAX_CANONICAL_BYTES = 16384;
export const MAX_FREEZE_BYTES = 1280;
export const MAX_EMOTES = 16;
export const MAX_STEPS = 16;
export const MIN_MS = 60;
export const MAX_MS = 2000;
export const MAX_EMOTE_MS = 4000;

const TOP_MEMBERS = new Set(['format', 'accent', 'body', 'head', 'emotes']);
const STEP_MEMBERS = new Set(['pose', 'ms', 'motion', 'particle']);
const PIXEL_ROW = /^[0-9a-f.]*$/;
const ACCENT = /^[0-9a-f]$/;

type Obj = Map<string, JsonValue>;

/**
 * Validate `bytes` as a format-1 avatar pack. `rules` is the set of broken rule ids, sorted; the
 * pack is returned only when it is empty. Reads at most one byte past the limit, as post does.
 */
export function parseAvatar(bytes: Uint8Array): { pack: AvatarPack | null; rules: string[] } {
  if (bytes.length > MAX_INPUT_BYTES) return { pack: null, rules: ['input-too-large'] };
  const parsed = parseJsonBytes(bytes);
  if (!parsed.ok) {
    return { pack: null, rules: [parsed.error === 'duplicate' ? 'duplicate-key' : 'json-syntax'] };
  }
  const rules = new Set<string>();
  const pack = checkPack(parsed.value, rules);
  if (rules.size === 0 && pack !== null) {
    for (const name of Object.keys(pack.emotes ?? {})) {
      const frozen = freezeEmote(pack, name);
      if (frozen === null || frozen.payloadBytes > MAX_FREEZE_BYTES) {
        rules.add('emote-freeze-too-large');
      }
    }
    if (rules.size === 0 && byteLength(canonicalAvatar(pack)) > MAX_CANONICAL_BYTES) {
      rules.add('canonical-too-large');
    }
  }
  return rules.size === 0 ? { pack, rules: [] } : { pack: null, rules: [...rules].sort() };
}

/** The pack as compact JSON with sorted members; post stores these bytes plus one newline. */
export function canonicalAvatar(pack: AvatarPack): string {
  return canonicalJson(pack);
}

/**
 * The member's value if it is present, not null, and of the wanted type; otherwise the rule it
 * breaks is recorded and undefined is returned, so the caller looks no further.
 */
function member<T extends JsonValue['t']>(
  o: Obj,
  name: string,
  t: T,
  rules: Set<string>,
  required: boolean,
): Extract<JsonValue, { t: T }> | undefined {
  const v = o.get(name);
  if (v === undefined) {
    if (required) rules.add('missing-field');
    return undefined;
  }
  return typed(v, t, rules);
}

function typed<T extends JsonValue['t']>(
  v: JsonValue,
  t: T,
  rules: Set<string>,
): Extract<JsonValue, { t: T }> | undefined {
  if (v.t === 'null') {
    rules.add('null-value');
    return undefined;
  }
  if (v.t !== t) {
    rules.add('type-mismatch');
    return undefined;
  }
  return v as Extract<JsonValue, { t: T }>;
}

function unknownMembers(o: Obj, allowed: ReadonlySet<string>, rules: Set<string>) {
  for (const k of o.keys()) if (!allowed.has(k)) rules.add('unknown-field');
}

function checkPack(root: JsonValue, rules: Set<string>): AvatarPack | null {
  const top = typed(root, 'obj', rules);
  if (top === undefined) return null;
  const o = top.v;
  unknownMembers(o, TOP_MEMBERS, rules);

  const format = member(o, 'format', 'num', rules, true);
  if (format !== undefined) {
    if (!format.int) rules.add('not-integer');
    else if (format.v !== 1) rules.add('format-unsupported');
  }

  const accent = member(o, 'accent', 'str', rules, true);
  if (accent !== undefined && !ACCENT.test(accent.v)) rules.add('accent-grammar');

  const body = checkFrames(o, 'body', BODY, rules);
  const head = checkFrames(o, 'head', HEAD, rules);
  const emotes = checkEmotes(o, rules);

  if (rules.size > 0 || body === null || head === null || accent === undefined) return null;
  const pack: AvatarPack = { format: 1, accent: accent.v, body, head };
  if (emotes !== undefined) pack.emotes = emotes;
  return pack;
}

function checkFrames(
  o: Obj,
  which: 'body' | 'head',
  spec: { size: number; maxFrames: number },
  rules: Set<string>,
): Frames | null {
  const m = member(o, which, 'obj', rules, true);
  if (m === undefined) return null;
  if (m.v.size > spec.maxFrames) rules.add(`${which}-frame-count`);
  if (!m.v.has('idle')) rules.add('missing-field');
  const frames: Record<string, string[]> = {};
  for (const [name, v] of m.v) {
    if (!NAME_GRAMMAR.test(name)) {
      rules.add('frame-name-grammar');
      continue;
    }
    const arr = typed(v, 'arr', rules);
    if (arr === undefined) continue;
    const rows: string[] = [];
    // The row count is the frame's own property and is always judged. A row's width is judged
    // only when the row is a string of pixel characters: a row breaking a type or grammar rule
    // is not looked into further.
    let sized = arr.v.length === spec.size;
    for (const item of arr.v) {
      const row = typed(item, 'str', rules);
      if (row === undefined) continue;
      rows.push(row.v);
      if (!PIXEL_ROW.test(row.v)) {
        rules.add('pixel-char');
        continue;
      }
      if (row.v.length !== spec.size) sized = false;
    }
    if (!sized) rules.add(`${which}-frame-size`);
    frames[name] = rows;
  }
  return m.v.has('idle') ? (frames as unknown as Frames) : null;
}

function checkEmotes(o: Obj, rules: Set<string>): Record<string, EmoteDef> | undefined {
  const m = member(o, 'emotes', 'obj', rules, false);
  if (m === undefined) return undefined;
  if (m.v.size > MAX_EMOTES) rules.add('emote-count');
  // Poses are judged against the body frames the pack declares, whatever their content.
  const bodyNames = bodyFrameNames(o);
  const out: Record<string, EmoteDef> = {};
  for (const [name, v] of m.v) {
    if (!NAME_GRAMMAR.test(name)) {
      rules.add('emote-name-grammar');
      continue;
    }
    const e = typed(v, 'obj', rules);
    if (e === undefined) continue;
    unknownMembers(e.v, new Set(['steps']), rules);
    const steps = member(e.v, 'steps', 'arr', rules, true);
    if (steps === undefined) continue;
    if (steps.v.length === 0 || steps.v.length > MAX_STEPS) rules.add('emote-step-count');
    const parsed: EmoteStep[] = [];
    let total = 0;
    let totalKnown = true;
    for (const sv of steps.v) {
      const step = checkStep(sv, bodyNames, rules);
      if (step === null || step.ms === undefined) {
        totalKnown = false;
        continue;
      }
      total += step.ms;
      parsed.push(step as EmoteStep);
    }
    if (totalKnown && total > MAX_EMOTE_MS) rules.add('emote-duration');
    out[name] = { steps: parsed };
  }
  return out;
}

function bodyFrameNames(o: Obj): ReadonlySet<string> | null {
  const b = o.get('body');
  return b?.t === 'obj' ? new Set(b.v.keys()) : null;
}

/** A step, or null when its type is wrong; `ms` is absent when the ms member broke a rule. */
function checkStep(
  v: JsonValue,
  bodyNames: ReadonlySet<string> | null,
  rules: Set<string>,
): (Omit<EmoteStep, 'ms'> & { ms?: number }) | null {
  const s = typed(v, 'obj', rules);
  if (s === undefined) return null;
  unknownMembers(s.v, STEP_MEMBERS, rules);
  const step: Omit<EmoteStep, 'ms'> & { ms?: number } = { pose: '' };

  const pose = member(s.v, 'pose', 'str', rules, true);
  if (pose !== undefined) {
    step.pose = pose.v;
    if (!NAME_GRAMMAR.test(pose.v)) rules.add('frame-name-grammar');
    else if (bodyNames !== null && !bodyNames.has(pose.v) && !STANDARD_POSES.includes(pose.v)) {
      rules.add('emote-pose-unknown');
    }
  }

  const ms = member(s.v, 'ms', 'num', rules, true);
  if (ms !== undefined) {
    if (!ms.int) rules.add('not-integer');
    else if (ms.v < MIN_MS || ms.v > MAX_MS) rules.add('step-ms-range');
    else step.ms = ms.v;
  }

  const motion = member(s.v, 'motion', 'str', rules, false);
  if (motion !== undefined) {
    if (!(MOTIONS as readonly string[]).includes(motion.v)) rules.add('step-motion');
    else step.motion = motion.v as Motion;
  }

  const particle = member(s.v, 'particle', 'str', rules, false);
  if (particle !== undefined) {
    if (!(PARTICLES as readonly string[]).includes(particle.v)) rules.add('step-particle');
    else step.particle = particle.v as ParticleKind;
  }
  return step;
}
