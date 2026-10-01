/** The shapes of build plan interface I3, shared by every module in the package. */

export type PaletteIndex = number; // 0..15
export type Pixel = PaletteIndex | null; // null = transparent
export type FrameRows = readonly string[]; // as authored
export type Frames = { readonly idle: FrameRows } & Readonly<Record<string, FrameRows>>;
export type Motion = 'hop' | 'shake' | 'flip' | 'blink' | 'none';
export type ParticleKind = 'heart' | 'spark' | 'zzz' | 'question' | 'exclaim' | 'none';
export type EmoteStep = { pose: string; motion?: Motion; particle?: ParticleKind; ms: number };
export type EmoteDef = { steps: readonly EmoteStep[] };
export type AvatarPack = {
  format: 1;
  accent: string;
  body: Frames;
  head: Frames;
  emotes?: Readonly<Record<string, EmoteDef>>;
};
export type FrozenEmote = {
  name: string;
  source: 'custom' | 'builtin';
  library: string;
  at?: string;
  steps: readonly EmoteStep[];
  frames: { body: Readonly<Record<string, string>>; head: Readonly<Record<string, string>> };
};

export const STANDARD_POSES: readonly string[] = [
  'idle',
  'talk',
  'wave',
  'think',
  'celebrate',
  'sleep',
];
export const MOTIONS: readonly Motion[] = ['hop', 'shake', 'flip', 'blink', 'none'];
export const PARTICLES: readonly ParticleKind[] = [
  'heart',
  'spark',
  'zzz',
  'question',
  'exclaim',
  'none',
];

/** Frame names, emote names and step poses (I1). */
export const NAME_GRAMMAR = /^[a-z][a-z0-9-]{0,23}$/;

export const BODY = { size: 16, maxFrames: 16 } as const;
export const HEAD = { size: 8, maxFrames: 8 } as const;
