/** Small drawing helpers shared by the app's views. */
import type { Grid, Style } from '../grid/grid.ts';
import { graphemes, textWidth } from '../grid/text.ts';

/**
 * Text at `x` up to `maxX` (exclusive), returning the column after it, so spans can follow each
 * other. (`Grid.text` returns the columns it wrote, which a clip can shorten.)
 */
export function say(g: Grid, x: number, y: number, s: string, style: Style, maxX: number): number {
  const room = Math.max(0, maxX - x);
  if (room === 0 || s === '') return x;
  g.text(x, y, s, style, room);
  return x + Math.min(textWidth(s), room);
}

/** `s` cut to `cols` columns, with an ellipsis when it was cut. */
export function clip(s: string, cols: number): string {
  if (cols <= 0) return '';
  if (textWidth(s) <= cols) return s;
  let out = '';
  let used = 0;
  for (const g of graphemes(s)) {
    const w = textWidth(g);
    if (used + w > cols - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

/**
 * A sender label in `cols`, keeping what tells two senders apart. `lineage [participant]` gives
 * up the lineage first (`claude… [test-nova02]`); with no room for any of it, the participant id
 * alone (clipped only when even that is too long). Any other label is clipped from the end.
 */
export function fitLabel(label: string, cols: number): string {
  if (textWidth(label) <= cols) return label;
  const m = /^(.*\S)\s+\[([^\]]+)\]$/.exec(label);
  if (m === null) return clip(label, cols);
  const lineage = m[1] ?? '';
  const participant = m[2] ?? '';
  const suffix = `[${participant}]`;
  const room = cols - textWidth(suffix) - 1;
  if (room >= 4) return `${clip(lineage, room)} ${suffix}`;
  return clip(participant, cols);
}

/** `s` right-aligned so it ends at `maxX`; returns where it starts. */
export function sayRight(
  g: Grid,
  maxX: number,
  y: number,
  s: string,
  style: Style,
  minX: number,
): number {
  const w = Math.min(textWidth(s), Math.max(0, maxX - minX));
  const x = maxX - w;
  g.text(x, y, s, style, w);
  return x;
}

/**
 * A chip's style: `ink` words on a `face` fill. Under `NO_COLOR` the host's monochrome pair would
 * draw any lit face as a solid light bar (inverse video), which the contract forbids, so a chip
 * there is its words in the face's colour (lit in the pair), bold and underlined, on whatever
 * background is already under it: the mode chip's mono path. The one exception is the
 * failed-signature banner, which keeps its reverse video as safety emphasis (coordinator ruling,
 * T9 fix round 2; `stream.ts`).
 */
export function chip(face: string, ink: string, mono: boolean): Style {
  return mono ? { fg: face, bold: true, underline: true } : { fg: ink, bg: face, bold: true };
}
