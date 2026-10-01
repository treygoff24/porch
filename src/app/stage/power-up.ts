/**
 * The power-up: a signed send's moment (the contract's signature interaction). A pixel-font
 * SIGNED! plate in a double frame over the stage strip, in power gold, which is used for nothing
 * else. It opens with one flash of white for two frames and then holds gold until the burst ends:
 * a single flash, not a strobe. Reduced motion holds the gold plate without the flash; off draws
 * nothing (the stream's own badge still says the send is signed).
 */
import type { Grid, Rect } from '../../grid/grid.ts';
import { halfBlocks, pixText } from '../../grid/pixel.ts';
import { chip } from '../ink.ts';
import { monoPixels } from '../mono-art.ts';
import { T } from './theme.ts';

/** Seven frames at 8 fps. */
export const POWER_UP_MS = 875;
/** Frames of flash white at the start. */
const FLASH_FRAMES = 2;

export const SIGNED_PLATE = 'SIGNED!';

/**
 * Draw the plate centred in `area`; `k` is the burst's sub-tick, or undefined for reduced motion.
 * `mono` (`NO_COLOR`) draws the pixel lettering as line work, and the small fallback word as bold
 * underlined gold words rather than a lit plate.
 */
export function drawPowerUp(g: Grid, area: Rect, k: number | undefined, mono = false): void {
  const colour = k !== undefined && k < FLASH_FRAMES ? T.flash : T.gold;
  const big = area.w >= 70 && area.h >= 7;
  const plate = pixText(SIGNED_PLATE, colour, big ? { sx: 2, sy: 2 } : {});
  const w = plate.w + 6;
  const h = plate.h / 2 + 2;
  if (w > area.w || h > area.h) {
    // Too small for the pixel plate: the word alone, framed, still in gold.
    const word = ` ✦ ${SIGNED_PLATE} ✦ `;
    const x = area.x + Math.max(0, Math.floor((area.w - word.length) / 2));
    const y = area.y + Math.floor(area.h / 2);
    g.text(x, y, word, chip(colour, T.glass, mono), area.w);
    return;
  }
  const x = area.x + Math.floor((area.w - w) / 2);
  const y = area.y + Math.floor((area.h - h) / 2);
  g.withClip(area, () => {
    g.fill({ x, y, w, h }, { bg: T.glass });
    g.box({ x, y, w, h }, 'double', { fg: colour, bg: T.glass, bold: true });
    g.blit(x + 3, y + 1, halfBlocks(mono ? monoPixels(plate.px) : plate.px));
  });
}
