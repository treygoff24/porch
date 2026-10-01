/**
 * Freezing an emote (build plan I1, "Freeze"): the payload an emote record carries, holding the
 * sender's frames as they were when the emote was sent, so history replays correctly after the
 * sender redraws their avatar and on a host that has no copy of it.
 */
import { BUILTIN_EMOTES, BUILTIN_LIBRARY } from './builtin.ts';
import { byteLength, canonicalJson } from './canonical.ts';
import type { AvatarPack, EmoteStep, Frames, FrozenEmote } from './types.ts';

/**
 * Freeze emote `name` for a sender whose pack is `pack`. A custom emote of that name wins over the
 * built-in, for this sender only; an unknown name gives null (post refuses the send).
 * `payloadBytes` is the size of the canonical `{frames, steps}` payload, which must be at most 1280.
 */
export function freezeEmote(
  pack: AvatarPack,
  name: string,
): { emote: FrozenEmote; payloadBytes: number } | null {
  const custom = Object.hasOwn(pack.emotes ?? {}, name) ? pack.emotes?.[name] : undefined;
  const builtin = Object.hasOwn(BUILTIN_EMOTES, name) ? BUILTIN_EMOTES[name] : undefined;
  const def = custom ?? builtin;
  if (def === undefined) return null;
  const steps: EmoteStep[] = def.steps.map((s) => ({ ...s }));
  const frames = { body: resolved(pack.body, steps), head: resolved(pack.head, steps) };
  const emote: FrozenEmote = {
    name,
    source: custom !== undefined ? 'custom' : 'builtin',
    library: BUILTIN_LIBRARY,
    steps,
    frames,
  };
  return { emote, payloadBytes: byteLength(frozenPayload(emote)) };
}

/** The canonical `{frames, steps}` payload of a frozen emote, the bytes the 1280 limit counts. */
export function frozenPayload(emote: Pick<FrozenEmote, 'frames' | 'steps'>): string {
  return canonicalJson({ frames: emote.frames, steps: emote.steps });
}

/** Each distinct frame the steps resolve to (the pose, else idle), as rows joined with `/`. */
function resolved(frames: Frames, steps: readonly EmoteStep[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps) {
    const name = Object.hasOwn(frames, s.pose) ? s.pose : 'idle';
    const rows = frames[name] ?? frames.idle;
    out[name] = rows.join('/');
  }
  return out;
}
