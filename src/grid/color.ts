/**
 * Colour for a terminal that asked for none. With `NO_COLOR` set (non-empty, per no-color.org),
 * every cell is drawn in one monochrome pair, each colour going dark or light by its luminance.
 * Text is kept readable: when its ink and its background land on the same shade, the ink takes the
 * other one, so a lit region (a selected lane, a chip) reads as inverse. Half-block pixels are
 * mapped each by its own luminance and never forced, so pixel art keeps its shape. Attributes (bold,
 * dim, italic, underline) are kept as they are. Colour never carries meaning alone in Porch, so
 * every state still has its word or glyph.
 */

/** The monochrome pair. */
export const MONO_DARK = '#000000';
export const MONO_LIGHT = '#d8d8d8';

/** Whether the environment asks for no colour: `NO_COLOR` set and not empty. */
export function noColorRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NO_COLOR;
  return v !== undefined && v !== '';
}

/** `#rrggbb` (or `#rgb`) as 0-255 channels. Anything else reads as black. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = /^[0-9a-fA-F]{6}$/.test(h) ? Number.parseInt(h, 16) : 0;
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Relative luminance, 0 (black) to 1 (white), per WCAG. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Colours brighter than this are drawn light. The meta grey (#8f9aa2) is about 0.32. */
const LIGHT_ABOVE = 0.18;

const HALF_BLOCKS = new Set(['▀', '▄']);

function shade(hex: string): string {
  return luminance(hex) > LIGHT_ABOVE ? MONO_LIGHT : MONO_DARK;
}

/** A cell's colours under `NO_COLOR`. `ch` is the cell's glyph: half blocks are pixels, not text. */
export function monochrome(fg: string, bg: string, ch = ' '): { fg: string; bg: string } {
  const b = shade(bg);
  const f = shade(fg);
  if (HALF_BLOCKS.has(ch) || f !== b) return { fg: f, bg: b };
  return { fg: b === MONO_LIGHT ? MONO_DARK : MONO_LIGHT, bg: b };
}
