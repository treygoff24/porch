/**
 * Pixel art on the grid: the Arcade prototype's 3×5 pixel font and its half-block blitter
 * (`prototypes/arcade/index.html:191-248`). One cell holds two full-colour pixels stacked: `▀` with
 * the top pixel as foreground and the bottom as background (equal colours included: there is no
 * `█`), `▄` when only the bottom pixel is set. A transparent pixel keeps whatever background is
 * underneath. `halfBlocks` is the rasteriser I3 specifies, shared with `@estate/pixel`.
 */
import type { Grid, HalfBlockCell } from './grid.ts';

/** Rows of pixels: a colour, or null for transparent. */
export type Pixels = (string | null)[][];
export type PixImage = { px: Pixels; w: number; h: number };

type Glyph = readonly [string, string, string, string, string];

export const FONT: Readonly<Record<string, Glyph>> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['###', '#.#', '#.#', '#.#', '#.#'],
  O: ['###', '#.#', '#.#', '#.#', '###'],
  P: ['###', '#.#', '###', '#..', '#..'],
  Q: ['###', '#.#', '#.#', '###', '..#'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  '!': ['.#.', '.#.', '.#.', '...', '.#.'],
  '-': ['...', '...', '###', '...', '...'],
  '.': ['...', '...', '...', '...', '.#.'],
  ':': ['...', '.#.', '...', '.#.', '...'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  "'": ['.#.', '.#.', '...', '...', '...'],
};

export type PixTextOptions = {
  /** Horizontal scale: each font pixel becomes `sx` pixels. */
  sx?: number;
  /** Vertical scale. */
  sy?: number;
  /** A drop shadow in this colour, one scaled pixel down and right. */
  shadow?: string;
};

/**
 * `s` set in the pixel font (upper-cased; an unknown character draws as `?`). `colors` is one
 * colour, or a colour per font row (0-4), for gradients. The height is rounded up to an even number
 * of pixels so the image is a whole number of cell rows.
 */
export function pixText(
  s: string,
  colors: string | ((fontRow: number) => string),
  o: PixTextOptions = {},
): PixImage {
  const sx = Math.max(1, Math.floor(o.sx ?? 1));
  const sy = Math.max(1, Math.floor(o.sy ?? 1));
  const glyphs: (Glyph | null)[] = [];
  let cols = 0;
  for (const ch of s.toUpperCase()) {
    const g = ch === ' ' ? null : (FONT[ch] ?? FONT['?'] ?? null);
    glyphs.push(g);
    cols += (g === null ? 2 : 4) * sx;
  }
  cols = Math.max(0, cols - sx);
  const offX = o.shadow !== undefined ? sx : 0;
  const offY = o.shadow !== undefined ? sy : 0;
  let h = 5 * sy + offY;
  if (h % 2 === 1) h += 1;
  const w = cols + offX;
  const px: Pixels = [];
  for (let y = 0; y < h; y++) px.push(new Array<string | null>(w).fill(null));
  const colorAt = (r: number) => (typeof colors === 'function' ? colors(r) : colors);
  const pass = (dx: number, dy: number, colorFn: (r: number) => string) => {
    let x0 = 0;
    for (const g of glyphs) {
      if (g === null) {
        x0 += 2 * sx;
        continue;
      }
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 3; c++) {
          if (g[r]?.[c] !== '#') continue;
          for (let a = 0; a < sy; a++) {
            for (let b = 0; b < sx; b++) {
              const X = x0 + c * sx + b + dx;
              const Y = r * sy + a + dy;
              const line = px[Y];
              if (line === undefined || X >= w) continue;
              // The shadow never covers a letter; the letters cover the shadow.
              if ((dx === 0 && dy === 0) || line[X] === null) line[X] = colorFn(r);
            }
          }
        }
      }
      x0 += 4 * sx;
    }
  };
  if (o.shadow !== undefined) {
    const shadow = o.shadow;
    pass(offX, offY, () => shadow);
  }
  pass(0, 0, colorAt);
  return { px, w, h };
}

/** Columns `s` takes in the pixel font at horizontal scale `sx` (without a shadow). */
export function pixWidth(s: string, sx = 1): number {
  let c = 0;
  for (const ch of s) c += (ch === ' ' ? 2 : 4) * sx;
  return Math.max(0, c - sx);
}

/**
 * Pixels as half-block cells, two pixel rows per cell row (I3's rasteriser): both pixels set gives
 * `▀` with the top as `fg` and the bottom as `bg`, even when they are the same colour; only the top
 * gives `▀` with `bg: null`; only the bottom gives `▄` with `bg: null`; neither gives null. A null
 * `bg` takes whatever background the grid already holds. `█` is never emitted.
 */
export function halfBlocks(px: Pixels): HalfBlockCell[][] {
  const out: HalfBlockCell[][] = [];
  const width = px.reduce((m, row) => Math.max(m, row.length), 0);
  for (let y = 0; y < px.length; y += 2) {
    const row: HalfBlockCell[] = [];
    for (let x = 0; x < width; x++) {
      const t = px[y]?.[x] ?? null;
      const b = px[y + 1]?.[x] ?? null;
      if (t !== null) row.push({ ch: '▀', fg: t, bg: b });
      else if (b !== null) row.push({ ch: '▄', fg: b, bg: null });
      else row.push(null);
    }
    out.push(row);
  }
  return out;
}

/** `s` in the pixel font, blitted at `x`, `y`. Returns the image for its size. */
export function drawPix(
  grid: Grid,
  x: number,
  y: number,
  s: string,
  colors: string | ((fontRow: number) => string),
  o: PixTextOptions = {},
): PixImage {
  const img = pixText(s, colors, o);
  grid.blit(x, y, halfBlocks(img.px));
  return img;
}

/**
 * A sprite written as rows of palette keys (`.` transparent), as pixels. Each row is split into
 * characters, so keys are single characters.
 */
export function spritePixels(rows: readonly string[], palette: Readonly<Record<string, string>>) {
  return rows.map((row) => [...row].map((k) => (k === '.' ? null : (palette[k] ?? null))));
}
