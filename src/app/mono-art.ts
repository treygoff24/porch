/**
 * The app's art under `NO_COLOR` (`AppState.noColor`): sprites, heads and pixel titles redrawn as
 * line work (`src/grid/mono.ts`) so none of them becomes a solid light block in the monochrome pair.
 */
import { type Pixel, SPRITE_PALETTE } from '@estate/pixel';
import { luminance, MONO_LIGHT } from '../grid/color.ts';
import { dither, lineArt } from '../grid/mono.ts';
import type { Pixels } from '../grid/pixel.ts';

/** The sprite palette's `pale`: lit in the monochrome pair. */
const PALE = 3;

const lum = (p: number) => luminance(SPRITE_PALETTE[p] ?? '#000000');

/** Palette pixels (a sprite frame) as line work in `pale`. */
export function monoSprite(px: readonly (readonly Pixel[])[]): Pixel[][] {
  return lineArt(px, lum, PALE);
}

/** Colour pixels (a pixel-font title) as line work in the light half of the pair. */
export function monoPixels(px: Pixels): Pixels {
  return lineArt(px, luminance, MONO_LIGHT);
}

/** Colour pixels whose strokes are two pixels or thinner (a title at scale 2) as a dither. */
export function monoThinPixels(px: Pixels): Pixels {
  return dither(px, MONO_LIGHT);
}
