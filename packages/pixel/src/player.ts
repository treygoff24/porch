/**
 * The emote player (build plan I3, "Player semantics"): a pure function of time. The caller keeps
 * the clock; `frameAt(t)` says what to draw `t` milliseconds after the emote started, or null when
 * the emote is not playing and the resting sprite from the sender's current avatar belongs there.
 *
 * - Step `i` is active for `start_i <= t < start_i + ms_i`; `t < 0` and `t >= durationMs` are null.
 * - Within a step, sub-tick `k = floor((t - start_i) / 125)`, about 8 frames a second:
 *   `hop` lifts the sprite 2 pixels (one cell row, so half-block pairs never re-pair) on even `k`;
 *   `shake` moves it +1 pixel on even `k` and -1 on odd; `flip` mirrors it for the whole step;
 *   `blink` hides it on odd `k` (the arcade flicker, not the idle eye blink).
 * - A particle lives for its step only and rises one cell row every 250 ms from just above the
 *   sprite's top-right corner. The stage clips it.
 * - Reduced motion: every `t` in range shows the final step's frame and particle, still.
 */
import { frozenPixels } from './palette.ts';
import type { FrozenEmote, Motion, ParticleKind, Pixel } from './types.ts';

/**
 * A particle to draw over the sprite. `x` and `y` are where its bottom-left pixel goes, in pixels
 * relative to the sprite's top-left, exactly as I3 states them (`y` is negative: above the sprite);
 * its top-left is therefore at `(x, y - px.length + 1)`.
 */
export type Particle = { kind: Exclude<ParticleKind, 'none'>; px: Pixel[][]; x: number; y: number };

/**
 * One frame of an emote. `px` is the frame as recorded, not mirrored: draw it mirrored when
 * `flipX` (see `mirrorX`), offset by `dx`, `dy` pixels, and not at all when `visible` is false.
 */
export type SpriteFrame = {
  px: Pixel[][];
  dx: number;
  dy: number;
  flipX: boolean;
  visible: boolean;
  particles: Particle[];
};

export type EmotePlayer = { durationMs: number; frameAt(tMs: number): SpriteFrame | null };

export const SUB_TICK_MS = 125;

/**
 * Particle sprites, at most 5×5 pixels, in their fixed colours: heart pink (d), spark lemon (8),
 * zzz and question pale (3), exclaim orange (9). Each is drawn to read at one cell per two pixels.
 */
const PARTICLE_ART: Readonly<Record<Exclude<ParticleKind, 'none'>, readonly string[]>> = {
  heart: ['dd.dd', 'ddddd', 'ddddd', '.ddd.', '..d..'],
  spark: ['..8..', '..8..', '88.88', '..8..', '..8..'],
  zzz: ['33333', '...3.', '..3..', '.3...', '33333'],
  question: ['.33.', '3..3', '..3.', '....', '..3.'],
  exclaim: ['99', '99', '99', '..', '99'],
};

export function particleSprite(kind: Exclude<ParticleKind, 'none'>): Pixel[][] {
  return PARTICLE_ART[kind].map((row) =>
    [...row].map((c) => (c === '.' ? null : Number.parseInt(c, 16))),
  );
}

export function playEmote(
  emote: FrozenEmote,
  target: 'body' | 'head',
  motion: 'full' | 'reduced',
): EmotePlayer {
  const size = target === 'body' ? 16 : 8;
  const map = emote.frames[target];
  const cache = new Map<string, Pixel[][]>();
  const frameFor = (pose: string): Pixel[][] => {
    const name = Object.hasOwn(map, pose) ? pose : 'idle';
    let px = cache.get(name);
    if (px === undefined) {
      const s = map[name];
      // A playable record always resolves; a blank frame keeps a bad caller from crashing a frame.
      px =
        s === undefined
          ? Array.from({ length: size }, () => new Array<Pixel>(size).fill(null))
          : frozenPixels(s);
      cache.set(name, px);
    }
    return px.map((row) => [...row]);
  };
  const starts: number[] = [];
  let durationMs = 0;
  for (const s of emote.steps) {
    starts.push(durationMs);
    durationMs += s.ms;
  }
  const particlesFor = (kind: ParticleKind | undefined, k: number): Particle[] =>
    kind === undefined || kind === 'none'
      ? []
      : [{ kind, px: particleSprite(kind), x: size - 4, y: -1 - 2 * Math.floor(k / 2) }];

  const frameAt = (t: number): SpriteFrame | null => {
    if (!(t >= 0 && t < durationMs)) return null;
    if (motion === 'reduced') {
      const last = emote.steps[emote.steps.length - 1];
      if (last === undefined) return null;
      return {
        px: frameFor(last.pose),
        dx: 0,
        dy: 0,
        flipX: false,
        visible: true,
        particles: particlesFor(last.particle, 0),
      };
    }
    let i = 0;
    while (i + 1 < starts.length && t >= (starts[i + 1] ?? Number.POSITIVE_INFINITY)) i += 1;
    const step = emote.steps[i];
    if (step === undefined) return null;
    const k = Math.floor((t - (starts[i] ?? 0)) / SUB_TICK_MS);
    const even = k % 2 === 0;
    const m: Motion = step.motion ?? 'none';
    return {
      px: frameFor(step.pose),
      dx: m === 'shake' ? (even ? 1 : -1) : 0,
      dy: m === 'hop' && even ? -2 : 0,
      flipX: m === 'flip',
      visible: m === 'blink' ? even : true,
      particles: particlesFor(step.particle, k),
    };
  };
  return { durationMs, frameAt };
}
