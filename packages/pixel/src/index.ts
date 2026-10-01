/**
 * `@estate/pixel`: the avatar format, the sprite palette, the emote library, the freeze and the
 * player, and the half-block rasteriser (build plan interface I3). Pure TypeScript with no UI
 * dependencies, so Porch and later Loom can share it. The format and emote records are frozen by
 * the corpus in `contract/`; post's Rust validator reports the same rule ids for the same bytes.
 */
export {
  canonicalAvatar,
  MAX_CANONICAL_BYTES,
  MAX_EMOTE_MS,
  MAX_EMOTES,
  MAX_FREEZE_BYTES,
  MAX_INPUT_BYTES,
  MAX_MS,
  MAX_STEPS,
  MIN_MS,
  parseAvatar,
} from './avatar.ts';
export { BUILTIN_EMOTES, BUILTIN_LIBRARY } from './builtin.ts';
export { canonicalJson } from './canonical.ts';
export { freezeEmote, frozenPayload } from './freeze.ts';
export { defaultAvatar } from './generator.ts';
export {
  ACCENT_ALLOWED,
  ACCENT_REFUSED,
  applyImpersonationCap,
  framePixels,
  frozenPixels,
  hash32,
  IMPERSONATION_LIMIT,
  PALETTE_NAMES,
  resolveAccent,
  SPRITE_PALETTE,
} from './palette.ts';
export type { PickerRequest, PickerResult } from './picker.ts';
export { buildAvatar, isPreset, listText, PRESET_NAMES, parseColour } from './picker.ts';
export type { EmotePlayer, Particle, SpriteFrame } from './player.ts';
export { particleSprite, playEmote, SUB_TICK_MS } from './player.ts';
export type { PremadeEmote } from './premade-emotes.ts';
export { PREMADE_EMOTES } from './premade-emotes.ts';
export type { HalfBlockCell } from './raster.ts';
export { mirrorX, toHalfBlocks } from './raster.ts';
export type { EmoteEnvelope, EmoteRecordVerdict } from './record.ts';
export { MAX_HEADER_BYTES, parseEmoteRecord } from './record.ts';
export type {
  AvatarPack,
  EmoteDef,
  EmoteStep,
  FrameRows,
  Frames,
  FrozenEmote,
  Motion,
  PaletteIndex,
  ParticleKind,
  Pixel,
} from './types.ts';
export { MOTIONS, NAME_GRAMMAR, PARTICLES, STANDARD_POSES } from './types.ts';
