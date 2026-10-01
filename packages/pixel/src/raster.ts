/**
 * The half-block rasteriser (build plan I3): one terminal cell holds two stacked pixels. For each
 * pair of pixel rows, both opaque gives `▀` with the top as `fg` and the bottom as `bg` (equal
 * colours included, so `█` is never emitted); only the top gives `▀` with `bg: null`; only the
 * bottom gives `▄` with `bg: null`; neither gives null. A null `bg` takes whatever background the
 * grid already holds there, so scanlines show through a sprite's transparent half.
 *
 * The cells drop straight into Porch's `Grid.blit`. This is the same algorithm as the app's
 * `halfBlocks` (`src/grid/pixel.ts`), which works on colours rather than palette indices; the
 * package keeps its own copy so it stands alone when Loom adopts it, and
 * `test/raster.test.ts` holds the two equal.
 */
import type { Pixel } from './types.ts';

export type HalfBlockCell = { ch: '▀' | '▄'; fg: string; bg: string | null } | null;

export function toHalfBlocks(
  px: readonly (readonly Pixel[])[],
  palette: readonly string[],
): HalfBlockCell[][] {
  const colour = (p: Pixel | undefined) =>
    p === null || p === undefined ? null : (palette[p] ?? null);
  const width = px.reduce((m, row) => Math.max(m, row.length), 0);
  const out: HalfBlockCell[][] = [];
  for (let y = 0; y < px.length; y += 2) {
    const row: HalfBlockCell[] = [];
    for (let x = 0; x < width; x++) {
      const t = colour(px[y]?.[x]);
      const b = colour(px[y + 1]?.[x]);
      if (t !== null) row.push({ ch: '▀', fg: t, bg: b });
      else if (b !== null) row.push({ ch: '▄', fg: b, bg: null });
      else row.push(null);
    }
    out.push(row);
  }
  return out;
}

/** A frame mirrored left to right, for a step whose motion is `flip`. */
export function mirrorX(px: readonly (readonly Pixel[])[]): Pixel[][] {
  return px.map((row) => [...row].reverse());
}
