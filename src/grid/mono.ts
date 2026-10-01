/**
 * Pixel art for a terminal that asked for no colour (`NO_COLOR`). The host's monochrome pair maps
 * each pixel light or dark by its own luminance, which turns a sprite into a solid light silhouette:
 * the contract forbids solid white blocks, and a face, its hair and its body all merge into one
 * blob. This redraws the art as line work before it is rasterised:
 *
 * - a pixel is lit where it borders transparency or a darker pixel (the outline of the figure and
 *   of every region inside it: the hairline, the eyes, the collar);
 * - inside a bright region, one pixel in four is lit (an ordered-dither texture), so pale skin
 *   reads as lighter than dark hair without becoming a solid block;
 * - everything else is left transparent, which the ground shows through as dark.
 *
 * The result holds one lit value and transparency only, so the host's mapping draws it exactly.
 */

/** Neighbours darker than this much less luminance count as a different region. */
const EDGE_STEP = 0.02;
/** Interior pixels brighter than this get the dither texture. */
const BRIGHT = 0.35;

/**
 * `px` redrawn as line work: `lit` where the pixel is an edge or textured, null elsewhere.
 * `lum` gives a pixel's relative luminance (0 dark to 1 light).
 */
export function lineArt<P>(
  px: readonly (readonly (P | null)[])[],
  lum: (p: P) => number,
  lit: P,
): (P | null)[][] {
  const at = (x: number, y: number): P | null => px[y]?.[x] ?? null;
  return px.map((row, y) =>
    row.map((p, x) => {
      if (p === null) return null;
      const l = lum(p);
      const edge = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx = 0, dy = 0]) => {
        const q = at(x + dx, y + dy);
        return q === null || lum(q) < l - EDGE_STEP;
      });
      if (edge) return lit;
      return l > BRIGHT && x % 2 === 0 && y % 2 === 0 ? lit : null;
    }),
  );
}

/**
 * `px` as a checkerboard dither: every other pixel of the art lit, the rest transparent. This is for
 * strokes too thin for line work (two pixels or fewer, where every pixel is an edge, so `lineArt`
 * lights them all and a letter comes out as a solid light slab). Rasterised as half blocks, each
 * cell has one lit half (`▀▄▀▄`), so the shapes read at half density and never as a solid block.
 */
export function dither<P>(px: readonly (readonly (P | null)[])[], lit: P): (P | null)[][] {
  return px.map((row, y) => row.map((p, x) => (p !== null && (x + y) % 2 === 0 ? lit : null)));
}
