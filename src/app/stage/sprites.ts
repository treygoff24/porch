/**
 * Drawing one avatar on the grid: a resting frame from the member's current pack, or one frame of
 * a frozen emote from `@estate/pixel`'s player, rasterised to half blocks (I3). The impersonation
 * cap applies to every sprite drawn here, resting or emoting, because it is a rendering rule
 * (I3): a non-owner frame cannot dress in cyan, lemon or red.
 *
 * Coordinates: `x`, `y` are the cell where the frame's top-left pixel pair goes. A frame's offsets
 * are in pixels; two pixels are one cell row, so a hop (`dy = -2`) is exactly one row up and never
 * re-pairs half blocks. Everything is clipped to `clip` (the stage strip), which is where particles
 * that rise off the top disappear.
 */
import {
  type AvatarPack,
  applyImpersonationCap,
  framePixels,
  mirrorX,
  type PaletteIndex,
  type Particle,
  type Pixel,
  SPRITE_PALETTE,
  type SpriteFrame,
  toHalfBlocks,
} from '@estate/pixel';
import type { Grid, Rect } from '../../grid/grid.ts';
import { monoSprite } from '../mono-art.ts';

export type Target = 'body' | 'head';

/** Cell size of a target: a body is 16×16 pixels (16 columns, 8 rows); a head 8×8 (8 by 4). */
export const SIZE: Readonly<Record<Target, { w: number; h: number }>> = {
  body: { w: 16, h: 8 },
  head: { w: 8, h: 4 },
};

/** The member's resting frame for a target (always `idle`; the pack is valid, so it exists). */
export function restingPixels(pack: AvatarPack, target: Target): Pixel[][] {
  return framePixels(pack[target].idle);
}

/** Whose sprite it is; `mono` draws it as line work for `NO_COLOR` (`AppState.noColor`). */
export type Who = { isOwner: boolean; accent: PaletteIndex; mono?: boolean };

/**
 * Draw a sprite. `frame` is an emote frame from the player, or undefined for the resting sprite
 * `rest`. `lift` adds rows of lift (a READY hop) on top of the frame's own offset.
 */
export function drawSprite(
  g: Grid,
  x: number,
  y: number,
  target: Target,
  rest: Pixel[][],
  who: Who,
  clip: Rect,
  frame?: SpriteFrame,
  lift = 0,
): void {
  const px = frame === undefined ? rest : frame.flipX ? mirrorX(frame.px) : frame.px;
  const dx = frame?.dx ?? 0;
  const dy = Math.trunc((frame?.dy ?? 0) / 2) - lift;
  g.withClip(clip, () => {
    if (frame === undefined || frame.visible) {
      const capped = applyImpersonationCap(px, target, who, who.accent);
      g.blit(
        x + dx,
        y + dy,
        toHalfBlocks(who.mono === true ? monoSprite(capped) : capped, SPRITE_PALETTE),
      );
    }
    // Rows of the strip above the sprite's resting top: where a particle has room to start.
    const headroom = Math.max(0, y - clip.y);
    for (const p of frame?.particles ?? [])
      drawParticle(g, x + dx, y + dy, p, who.mono === true, headroom);
  });
}

/**
 * A particle with its bottom-left pixel at (`p.x`, `p.y`) relative to the sprite's top-left pixel
 * (I3). Its top row is padded to an even pixel row so it pairs into half blocks exactly where the
 * player put it, not half a pixel off.
 *
 * The player anchors a particle above the sprite, but a bodies strip has no rows above its sprite
 * and a heads strip has one, so the clip used to swallow it whole. The stage starts it as far down
 * as it needs to be whole inside the strip (over the sprite's top-right corner: an overlay) and
 * lets it rise from there; the strip's top edge still clips it as it climbs out.
 */
function drawParticle(
  g: Grid,
  sx: number,
  sy: number,
  p: Particle,
  mono: boolean,
  headroom: number,
): void {
  const pad = (h: number): number => (h % 2 !== 0 ? 1 : 0);
  // Where it starts (y = -1): cell rows it needs above the sprite, less the rows the strip has.
  const startRows = (p.px.length + pad(-1 - p.px.length + 1)) / 2;
  const inset = Math.max(0, startRows - headroom);
  let top = p.y - p.px.length + 1;
  let rows: Pixel[][] = p.px;
  if (pad(top) === 1) {
    rows = [new Array<Pixel>(p.px[0]?.length ?? 0).fill(null), ...p.px];
    top -= 1;
  }
  g.blit(
    sx + p.x,
    sy + top / 2 + inset,
    toHalfBlocks(mono ? monoSprite(rows) : rows, SPRITE_PALETTE),
  );
}
