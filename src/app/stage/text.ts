import { graphemes, textWidth, width } from '../../grid/text.ts';

/** `s` cut to at most `cols` columns, ending in `…` when anything was cut. */
export function trunc(s: string, cols: number): string {
  if (cols <= 0) return '';
  if (textWidth(s) <= cols) return s;
  let out = '';
  let used = 0;
  for (const g of graphemes(s)) {
    const w = width(g);
    if (used + w > cols - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

/** The column at which `s` sits centred in `w` columns starting at `x`. */
export function centre(x: number, w: number, s: string): number {
  return x + Math.max(0, Math.floor((w - textWidth(s)) / 2));
}
