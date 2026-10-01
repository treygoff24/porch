/**
 * Reading an emote record (build plan I2, "Reading a record"). A record is a `.emote` file as post
 * writes it: a JSON header, `\n---\n`, then a body that readers ignore. The verdict decides what a
 * renderer does:
 *
 * - `omitted`: the envelope is unreadable, so history leaves the record out. Envelope checks run in
 *   a fixed order and the first failure is the rule: separator, header size, JSON, fields, event,
 *   and (only when the caller names the file's id) id match.
 * - `bubble`: the envelope is fine but the payload is not; the renderer draws the generic bubble
 *   (`✦ <sender> <name>`). One payload rule is reported, the first found.
 * - `playable`: the frozen payload plays as recorded. It is never re-resolved against a built-in
 *   table, so an unknown `library` version still plays.
 *
 * Cases the plan leaves open, as this reader decides them (for comparison with post's reader;
 * `test/format.test.ts` pins each one):
 * - The header is parsed strictly, as a whole: a header that is not one JSON object, that repeats a
 *   member name anywhere (including inside `emote`), or that nests more than 127 containers is
 *   `omitted` with `envelope-json`.
 * - `id`, `from`, `channel` and `sent` must be strings; absent, null or another type is
 *   `envelope-fields`. An absent, null or non-string `event` is `envelope-event`.
 * - Every other envelope member is ignored, whatever its value, null included: the record plays.
 * - `emote` absent or null is `payload-missing`; any other non-object is `type-mismatch`.
 * - Inside the payload, null is never its own rule: a null `name`, `source`, `library`, `at`,
 *   `steps` or `frames`, a null step, and a null `pose`, `ms`, `motion` or `particle` are all
 *   `type-mismatch`, as is a null frame string. Absent `pose` or `ms` is `missing-field`.
 * - `ms` is judged by value (`250.0` and `2.5e2` are 250); a fractional `ms` is `type-mismatch`,
 *   since `not-integer` is an avatar rule and not among I2's payload reasons.
 * - `library` must be `builtin-` then a positive integer without leading zeros (`builtin-9` plays;
 *   `builtin-0`, `builtin-01` and `builtin-one` are `payload-library-grammar`).
 *
 * Avatars differ on null: `parseAvatar` reports `null-value` for a null member value or array
 * element anywhere in a pack.
 */
import { byteLength } from './canonical.ts';
import { frozenPayload } from './freeze.ts';
import { type JsonValue, parseJsonBytes } from './json.ts';
import {
  type EmoteStep,
  type FrozenEmote,
  MOTIONS,
  type Motion,
  NAME_GRAMMAR,
  PARTICLES,
  type ParticleKind,
} from './types.ts';

export const MAX_HEADER_BYTES = 4096;
const SEPARATOR = [0x0a, 0x2d, 0x2d, 0x2d, 0x0a]; // "\n---\n"
const PAYLOAD_MEMBERS = new Set(['name', 'source', 'library', 'at', 'steps', 'frames']);
const STEP_MEMBERS = new Set(['pose', 'ms', 'motion', 'particle']);
const LIBRARY_GRAMMAR = /^builtin-[1-9][0-9]*$/;
const BODY_STRING = /^([0-9a-f.]{16}\/){15}[0-9a-f.]{16}$/;
const HEAD_STRING = /^([0-9a-f.]{8}\/){7}[0-9a-f.]{8}$/;

export type EmoteRecordVerdict = {
  verdict: 'playable' | 'bubble' | 'omitted';
  emote: FrozenEmote | null;
  rule: string | null;
};

/** What a bubble needs to say: the sender and, when the name is well formed, the emote name. */
export type EmoteEnvelope = { id: string; from: string; channel: string; sent: string };

/**
 * Classify one record. `fileId`, when given, is the filename stem the record was read from; the
 * header's `id` must then equal it (`envelope-id-mismatch`). Corpus filenames are descriptions, so
 * the corpus test leaves it out.
 */
export function parseEmoteRecord(
  bytes: Uint8Array,
  opts: { fileId?: string } = {},
): EmoteRecordVerdict & { envelope: EmoteEnvelope | null; name: string | null } {
  const omitted = (rule: string) => ({
    verdict: 'omitted' as const,
    emote: null,
    rule,
    envelope: null,
    name: null,
  });
  const cut = indexOf(bytes, SEPARATOR);
  if (cut < 0) return omitted('envelope-separator');
  if (cut > MAX_HEADER_BYTES) return omitted('envelope-header-too-large');
  const parsed = parseJsonBytes(bytes.subarray(0, cut));
  if (!parsed.ok || parsed.value.t !== 'obj') return omitted('envelope-json');
  const h = parsed.value.v;
  const field = (k: string) => {
    const v = h.get(k);
    return v?.t === 'str' ? v.v : undefined;
  };
  const id = field('id');
  const from = field('from');
  const channel = field('channel');
  const sent = field('sent');
  if (id === undefined || from === undefined || channel === undefined || sent === undefined) {
    return omitted('envelope-fields');
  }
  if (field('event') !== 'emote') return omitted('envelope-event');
  if (opts.fileId !== undefined && opts.fileId !== id) return omitted('envelope-id-mismatch');
  const envelope = { id, from, channel, sent };

  const payload = h.get('emote');
  const nameValue = payload?.t === 'obj' ? payload.v.get('name') : undefined;
  const name =
    nameValue?.t === 'str' && NAME_GRAMMAR.test(nameValue.v)
      ? nameValue.v
      : (null as string | null);
  const result = readPayload(payload);
  if (typeof result === 'string') {
    return { verdict: 'bubble', emote: null, rule: result, envelope, name };
  }
  return { verdict: 'playable', emote: result, rule: null, envelope, name };
}

/** The frozen emote, or the first payload rule it breaks. */
function readPayload(payload: JsonValue | undefined): FrozenEmote | string {
  if (payload === undefined || payload.t === 'null') return 'payload-missing';
  if (payload.t !== 'obj') return 'type-mismatch';
  const p = payload.v;
  for (const k of p.keys()) if (!PAYLOAD_MEMBERS.has(k)) return 'payload-unknown-field';
  for (const k of ['name', 'source', 'library', 'steps', 'frames']) {
    if (!p.has(k)) return 'missing-field';
  }
  const str = (k: string) => {
    const v = p.get(k);
    return v?.t === 'str' ? v.v : undefined;
  };
  const name = str('name');
  const source = str('source');
  const library = str('library');
  const at = p.has('at') ? str('at') : '';
  const stepsV = p.get('steps');
  const framesV = p.get('frames');
  if (
    name === undefined ||
    source === undefined ||
    library === undefined ||
    at === undefined ||
    stepsV?.t !== 'arr' ||
    framesV?.t !== 'obj'
  ) {
    return 'type-mismatch';
  }
  if (!NAME_GRAMMAR.test(name)) return 'payload-name-grammar';
  if (source !== 'custom' && source !== 'builtin') return 'payload-source';
  if (!LIBRARY_GRAMMAR.test(library)) return 'payload-library-grammar';

  const steps = readSteps(stepsV.v);
  if (typeof steps === 'string') return steps;

  const frames = readFrames(framesV.v);
  if (typeof frames === 'string') return frames;
  for (const s of steps) {
    for (const map of [frames.body, frames.head]) {
      if (!Object.hasOwn(map, s.pose) && !Object.hasOwn(map, 'idle')) {
        return 'payload-pose-unresolved';
      }
    }
  }

  const emote: FrozenEmote = { name, source, library, steps, frames };
  if (p.has('at')) emote.at = at;
  if (byteLength(frozenPayload(emote)) > 1280) return 'payload-too-large';
  return emote;
}

function readSteps(items: readonly JsonValue[]): EmoteStep[] | string {
  if (items.length === 0 || items.length > 16) return 'emote-step-count';
  const steps: EmoteStep[] = [];
  let total = 0;
  for (const item of items) {
    if (item.t !== 'obj') return 'type-mismatch';
    const s = item.v;
    for (const k of s.keys()) if (!STEP_MEMBERS.has(k)) return 'payload-unknown-field';
    const pose = s.get('pose');
    const ms = s.get('ms');
    if (pose === undefined || ms === undefined) return 'missing-field';
    if (pose.t !== 'str' || ms.t !== 'num' || !ms.int) return 'type-mismatch';
    if (!NAME_GRAMMAR.test(pose.v)) return 'frame-name-grammar';
    if (ms.v < 60 || ms.v > 2000) return 'step-ms-range';
    const step: EmoteStep = { pose: pose.v, ms: ms.v };
    const motion = s.get('motion');
    if (motion !== undefined) {
      if (motion.t !== 'str') return 'type-mismatch';
      if (!(MOTIONS as readonly string[]).includes(motion.v)) return 'step-motion';
      step.motion = motion.v as Motion;
    }
    const particle = s.get('particle');
    if (particle !== undefined) {
      if (particle.t !== 'str') return 'type-mismatch';
      if (!(PARTICLES as readonly string[]).includes(particle.v)) return 'step-particle';
      step.particle = particle.v as ParticleKind;
    }
    total += ms.v;
    steps.push(step);
  }
  if (total > 4000) return 'emote-duration';
  return steps;
}

function readFrames(f: Map<string, JsonValue>): FrozenEmote['frames'] | string {
  const body = f.get('body');
  const head = f.get('head');
  if (f.size !== 2 || body === undefined || head === undefined) return 'payload-frames';
  if (body.t !== 'obj' || head.t !== 'obj') return 'type-mismatch';
  if (body.v.size < 1 || body.v.size > 16 || head.v.size < 1 || head.v.size > 8) {
    return 'payload-frames';
  }
  const out = { body: {} as Record<string, string>, head: {} as Record<string, string> };
  for (const [which, map, grammar] of [
    ['body', body.v, BODY_STRING],
    ['head', head.v, HEAD_STRING],
  ] as const) {
    for (const [k, v] of map) {
      if (!NAME_GRAMMAR.test(k)) return 'frame-name-grammar';
      if (v.t !== 'str') return 'type-mismatch';
      if (!grammar.test(v.v)) return 'payload-frame-string';
      out[which][k] = v.v;
    }
  }
  return out;
}

function indexOf(hay: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
