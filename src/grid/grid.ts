/**
 * The cell grid every Porch frame is drawn into (build plan ruling 3, interface I5): a direct port
 * of the Arcade prototype's renderer (`prototypes/arcade/index.html:89-166, 235-246`), with widths
 * from `string-width` instead of the prototype's code-point guesses. A frame is plain data, so it
 * can be tested as text without a renderer; `GridHost` (`src/host/grid-host.ts`) copies the cells
 * that changed since the last frame into OpenTUI's buffer, and `toHtml()` lays it out for a PNG
 * capture.
 *
 * The rules I5 fixes:
 * - A wide grapheme at `x` fills `x` (`w: 2`) and a continuation cell at `x+1` (`ch: ''`, `w: 0`).
 *   Writing over either half turns the other half into a space with the same background, so a frame
 *   never holds half a character. A wide grapheme that would cross the clip or the grid edge is
 *   written as a space.
 * - A combining mark belongs to its grapheme and never takes a cell of its own.
 * - A control character (C0, ESC, DEL, C1) is never written: U+FFFD goes in its place. A tab in
 *   `text` advances to the next multiple of four columns from where that call started.
 * - `blit` keeps the background already in a cell wherever a half-block cell's `bg` is null.
 * - The hit region registered last wins.
 */
import { monochrome } from './color.ts';
import { graphemes, hasControl, REPLACEMENT, width } from './text.ts';

export type Cell = {
  ch: string;
  fg: string;
  bg: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  w: 0 | 1 | 2;
};

/** How to draw. An unset `fg` is the ground's ink there; an unset `bg` keeps the cell's background. */
export type Style = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

export type Rect = { x: number; y: number; w: number; h: number };

/** What a click on a hit region means; the scene that registered it interprets `id`. */
export type HitAction = { id: string; data?: unknown };

/** The screen under everything: the cell a fresh grid holds at `x`, `y` (a single-width glyph). */
export type Ground = (x: number, y: number) => Cell;

/**
 * One half-block cell: two pixels stacked (I3's rasteriser). `▀` draws the top pixel in `fg` over
 * the bottom one in `bg`; `▄` draws the bottom pixel only. A null `bg` keeps the background the grid
 * already holds there; a null cell draws nothing. There is no `█`: equal pixels are `▀` with `fg`
 * equal to `bg`.
 */
export type HalfBlockCell = { ch: '▀' | '▄'; fg: string; bg: string | null } | null;

export type BoxKind = 'single' | 'double' | 'heavy' | 'dashed' | 'dotted';
const SETS: Record<BoxKind, readonly [string, string, string, string, string, string]> = {
  single: ['┌', '┐', '└', '┘', '─', '│'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
  heavy: ['┏', '┓', '┗', '┛', '━', '┃'],
  dashed: ['┌', '┐', '└', '┘', '┄', '┆'],
  dotted: ['┌', '┐', '└', '┘', '┈', '┊'],
};

type Clip = { x0: number; y0: number; x1: number; y1: number };
type HitRegion = Clip & { action: HitAction };

/** Body text on the glass: Loom's `data` ink (`~/Code/loom/src/cockpit/theme.ts`). */
export const DEFAULT_INK = '#dfe6ea';

/** A ground of one colour, or of `base` with every odd row in `scan` (the arcade's scanlines). */
export function scanlines(base: string, scan: string = base, ink: string = DEFAULT_INK): Ground {
  return (_x, y) => ({ ch: ' ', fg: ink, bg: y % 2 === 1 ? scan : base, w: 1 });
}

/** Whether two cells draw the same thing (glyph, width, colours and attributes). */
export function sameCell(a: Readonly<Cell>, b: Readonly<Cell>): boolean {
  return (
    a.ch === b.ch &&
    a.w === b.w &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    (a.bold === true) === (b.bold === true) &&
    (a.dim === true) === (b.dim === true) &&
    (a.italic === true) === (b.italic === true) &&
    (a.underline === true) === (b.underline === true)
  );
}

export type HtmlOptions = {
  /** Pixel width of one column. */
  cellWidth?: number;
  /** Pixel height of one row. */
  cellHeight?: number;
  /** Font size in pixels. */
  fontSize?: number;
  /** Draw in the `NO_COLOR` monochrome pair. */
  noColor?: boolean;
};

/** The prototype's font stack (`prototypes/arcade/index.html:20`). */
const FONT_STACK =
  'ui-monospace,"SF Mono",Menlo,"JetBrains Mono","Cascadia Mono","DejaVu Sans Mono",monospace';

function isPrintableAscii(g: string): boolean {
  if (g.length !== 1) return false;
  const c = g.charCodeAt(0);
  return c >= 0x20 && c < 0x7f;
}

export class Grid {
  readonly cols: number;
  readonly rows: number;
  private readonly cells: Cell[][];
  private readonly ground: Ground;
  private clip: Clip;
  private readonly hits: HitRegion[] = [];

  constructor(cols: number, rows: number, ground: Ground) {
    this.cols = Math.max(0, Math.floor(cols));
    this.rows = Math.max(0, Math.floor(rows));
    this.ground = ground;
    this.cells = [];
    for (let y = 0; y < this.rows; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < this.cols; x++) {
        const g = ground(x, y);
        const ch = isPrintableAscii(g.ch) || (!hasControl(g.ch) && width(g.ch) === 1) ? g.ch : ' ';
        row.push({ ...g, ch, w: 1 });
      }
      this.cells.push(row);
    }
    this.clip = { x0: 0, y0: 0, x1: this.cols, y1: this.rows };
  }

  /** The cell at `x`, `y` (a continuation cell included), or undefined outside the grid. */
  at(x: number, y: number): Readonly<Cell> | undefined {
    return this.cells[y]?.[x];
  }

  /** Draw inside `r` only (intersected with any clip already in force) while `fn` runs. */
  withClip(r: Rect, fn: () => void): void {
    const old = this.clip;
    this.clip = {
      x0: Math.max(old.x0, r.x),
      y0: Math.max(old.y0, r.y),
      x1: Math.min(old.x1, r.x + r.w),
      y1: Math.min(old.y1, r.y + r.h),
    };
    try {
      fn();
    } finally {
      this.clip = old;
    }
  }

  /** Turn the other half of a wide grapheme that `x` is part of into a space, before `x` is written. */
  private unpair(row: Cell[], x: number): void {
    const c = row[x];
    if (c === undefined) return;
    const other = c.w === 0 ? row[x - 1] : c.w === 2 ? row[x + 1] : undefined;
    if (other === undefined) return;
    other.ch = ' ';
    other.w = 1;
    delete other.bold;
    delete other.dim;
    delete other.italic;
    delete other.underline;
  }

  /**
   * Write one already-measured grapheme, clipped, and return the columns written. A wide one cut by
   * a clip or grid edge becomes a space in the column that is inside: the last column at the right
   * edge, the first at the left.
   */
  private write(x: number, y: number, g: string, w: 1 | 2, style: Style): 0 | 1 | 2 {
    const c = this.clip;
    if (y < c.y0 || y >= c.y1 || x >= c.x1 || x + w <= c.x0) return 0;
    if (x < c.x0) return this.write(c.x0, y, ' ', 1, style);
    const row = this.cells[y];
    const cell = row?.[x];
    if (row === undefined || cell === undefined) return 0;
    let ch = g;
    let cw = w;
    if (cw === 2 && x + 1 >= c.x1) {
      ch = ' ';
      cw = 1;
    }
    this.unpair(row, x);
    if (cw === 2) this.unpair(row, x + 1);
    cell.ch = ch;
    cell.w = cw;
    cell.fg = style.fg ?? this.ground(x, y).fg;
    if (style.bg !== undefined) cell.bg = style.bg;
    setFlag(cell, 'bold', style.bold);
    setFlag(cell, 'dim', style.dim);
    setFlag(cell, 'italic', style.italic);
    setFlag(cell, 'underline', style.underline);
    if (cw === 2 && x + 1 < row.length) row[x + 1] = { ...cell, ch: '', w: 0 };
    return cw;
  }

  /**
   * One grapheme at `x`, `y` (the first grapheme of `grapheme`, if given more). A control is written
   * as U+FFFD; a zero-width grapheme (a lone combining mark) takes no cell and writes nothing.
   */
  put(x: number, y: number, grapheme: string, style: Style = {}): void {
    if (isPrintableAscii(grapheme)) {
      this.write(x, y, grapheme, 1, style);
      return;
    }
    const g = graphemes(grapheme)[0];
    if (g === undefined) return;
    if (hasControl(g)) {
      this.write(x, y, REPLACEMENT, 1, style);
      return;
    }
    const w = width(g);
    if (w !== 0) this.write(x, y, g, w, style);
  }

  /**
   * A line of text from `x`, at most `maxCols` columns and never past the clip's right edge. A tab
   * advances to the next multiple of four columns from `x`; any other control is written as U+FFFD
   * (a newline included: lines are `wrap`'s job). A wide grapheme that would cross the limit is
   * written as a space and ends the text. Returns the columns actually written: none on a row
   * outside the grid or the clip, and only those inside the clip on a row it cuts.
   */
  text(x: number, y: number, s: string, style: Style = {}, maxCols?: number): number {
    const end = Math.min(
      maxCols === undefined ? Number.POSITIVE_INFINITY : x + Math.max(0, Math.floor(maxCols)),
      this.clip.x1,
    );
    let cx = x;
    let written = 0;
    for (const g of graphemes(s)) {
      if (cx >= end) break;
      if (g === '\t') {
        const stop = Math.min(x + (Math.floor((cx - x) / 4) + 1) * 4, end);
        while (cx < stop) written += this.write(cx++, y, ' ', 1, style);
        continue;
      }
      const control = !isPrintableAscii(g) && hasControl(g);
      const w = control ? 1 : width(g);
      if (w === 0) continue;
      if (cx + w > end) {
        written += this.write(cx, y, ' ', 1, style);
        break;
      }
      written += this.write(cx, y, control ? REPLACEMENT : g, w, style);
      cx += w;
    }
    return written;
  }

  /** Fill `r` with `ch` (a space by default) in `style`. */
  fill(r: Rect, style: Style & { ch?: string }): void {
    const { ch = ' ', ...rest } = style;
    const step = Math.max(1, width(ch));
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x + step <= r.x + r.w; x += step) this.put(x, y, ch, rest);
  }

  /** A frame of box-drawing characters around the edge of `r`. */
  box(r: Rect, kind: BoxKind, style: Style): void {
    const { x, y, w, h } = r;
    if (w < 2 || h < 2) return;
    const [tl, tr, bl, br, horiz, vert] = SETS[kind];
    for (let xx = x + 1; xx < x + w - 1; xx++) {
      this.put(xx, y, horiz, style);
      this.put(xx, y + h - 1, horiz, style);
    }
    for (let yy = y + 1; yy < y + h - 1; yy++) {
      this.put(x, yy, vert, style);
      this.put(x + w - 1, yy, vert, style);
    }
    this.put(x, y, tl, style);
    this.put(x + w - 1, y, tr, style);
    this.put(x, y + h - 1, bl, style);
    this.put(x + w - 1, y + h - 1, br, style);
  }

  /** `w` columns of one character in a row. */
  rule(x: number, y: number, w: number, ch: string, style: Style): void {
    const step = Math.max(1, width(ch));
    for (let i = 0; i + step <= w; i += step) this.put(x + i, y, ch, style);
  }

  /** Half-block cells (two pixel rows per cell row) with their top-left at `x`, `y`. */
  blit(x: number, y: number, cells: readonly (readonly HalfBlockCell[])[]): void {
    for (let cy = 0; cy < cells.length; cy++) {
      const row = cells[cy] ?? [];
      for (let cx = 0; cx < row.length; cx++) {
        const c = row[cx];
        if (c === null || c === undefined) continue;
        this.write(x + cx, y + cy, c.ch, 1, c.bg === null ? { fg: c.fg } : { fg: c.fg, bg: c.bg });
      }
    }
  }

  /**
   * Make `r` clickable, as far as it lies inside the clip in force (a region scrolled out of view
   * cannot be clicked). A region registered later sits on top of earlier ones.
   */
  hit(r: Rect, action: HitAction): void {
    const c = this.clip;
    const region = {
      x0: Math.max(c.x0, r.x),
      y0: Math.max(c.y0, r.y),
      x1: Math.min(c.x1, r.x + r.w),
      y1: Math.min(c.y1, r.y + r.h),
      action,
    };
    if (region.x0 < region.x1 && region.y0 < region.y1) this.hits.push(region);
  }

  /** The action of the region registered last that covers cell `x`, `y`, or null. */
  hitAt(x: number, y: number): HitAction | null {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const r = this.hits[i];
      if (r !== undefined && x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1) return r.action;
    }
    return null;
  }

  /** Every row as its text, continuation cells left out, trailing spaces kept. */
  toText(): string {
    return this.cells.map((row) => row.map((c) => (c.w === 0 ? '' : c.ch)).join('')).join('\n');
  }

  /** Visit every cell that starts a glyph (continuation cells are skipped). */
  forEachCell(fn: (cell: Readonly<Cell>, x: number, y: number) => void): void {
    for (let y = 0; y < this.rows; y++) {
      const row = this.cells[y] ?? [];
      for (let x = 0; x < this.cols; x++) {
        const c = row[x];
        if (c !== undefined && c.w !== 0) fn(c, x, y);
      }
    }
  }

  /**
   * The grid as a standalone HTML page for a PNG capture: one fixed-size cell per grapheme, two
   * cells wide for a wide one, so a glyph never shifts the columns after it (Loom's
   * `src/cockpit/capture.ts`). Half blocks are painted as two coloured halves rather than set in the
   * font: a terminal draws them to fill the cell exactly, and a browser font would leave a gap
   * between the line box and the glyph.
   */
  toHtml(opts: HtmlOptions = {}): string {
    const cw = opts.cellWidth ?? 9;
    const chh = opts.cellHeight ?? 18;
    const fs = opts.fontSize ?? 15;
    const paint = (c: Readonly<Cell>) => (opts.noColor === true ? monochrome(c.fg, c.bg, c.ch) : c);
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let html = '';
      const row = this.cells[y] ?? [];
      for (let x = 0; x < this.cols; x++) {
        const c = row[x];
        if (c === undefined || c.w === 0) continue;
        const { fg, bg } = paint(c);
        const wpx = c.w * cw;
        const size = c.w === 2 ? `width:${wpx}px;` : '';
        if (c.ch === '▀' || c.ch === '▄') {
          const top = c.ch === '▄' ? bg : fg;
          const bottom = c.ch === '▀' ? bg : fg;
          html += `<b style="${size}background:linear-gradient(${top} 50%,${bottom} 50%)"></b>`;
          continue;
        }
        const attrs = [
          `color:${fg}`,
          `background:${bg}`,
          c.bold === true ? 'font-weight:700' : '',
          c.italic === true ? 'font-style:italic' : '',
          c.dim === true ? 'opacity:.6' : '',
          c.underline === true ? 'text-decoration:underline' : '',
        ]
          .filter((a) => a !== '')
          .join(';');
        html += `<b style="${size}${attrs}">${escapeHtml(c.ch)}</b>`;
      }
      lines.push(`<div class="l">${html}</div>`);
    }
    return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${opts.noColor === true ? '#000' : this.ground(0, 0).bg}}
.f{width:${this.cols * cw}px;height:${this.rows * chh}px;overflow:hidden;font:${fs}px/${chh}px ${FONT_STACK}}
.l{height:${chh}px;white-space:pre;overflow:hidden}
b{display:inline-block;font-weight:400;width:${cw}px;height:${chh}px;overflow:hidden;white-space:pre;vertical-align:top;text-align:center}
</style><div class="f">${lines.join('')}</div>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setFlag(
  cell: Cell,
  key: 'bold' | 'dim' | 'italic' | 'underline',
  on: boolean | undefined,
): void {
  if (on === true) cell[key] = true;
  else delete cell[key];
}
