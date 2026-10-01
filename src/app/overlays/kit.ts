/**
 * What every overlay shares: the arcade card it sits in, key tests, a one-line text field, and a
 * scrolling list. Overlays own every key while open (keybinding layer 4), so each `key` returns
 * 'handled'; Esc closes. Colour never carries meaning alone: the selected row is marked `▶`.
 */
import type { Grid, Rect } from '../../grid/grid.ts';
import { halfBlocks, pixText } from '../../grid/pixel.ts';
import { graphemes, textWidth } from '../../grid/text.ts';
import { chip } from '../ink.ts';
import { monoPixels } from '../mono-art.ts';
import type { Key } from '../registry.ts';
import { centre, trunc } from '../stage/text.ts';
import { T } from '../stage/theme.ts';

export const isEnter = (k: Key) =>
  k.name === 'return' || k.name === 'enter' || k.name === 'linefeed';
export const isEsc = (k: Key) => k.name === 'escape';
export const isUp = (k: Key) => k.name === 'up' && !k.ctrl;
export const isDown = (k: Key) => k.name === 'down' && !k.ctrl;
export const chord = (k: Key, letter: string) => k.ctrl && !k.alt && k.name === letter;

/** The text a key types, when it types one printable grapheme (or a pasted run of them). */
export function typed(k: Key): string | undefined {
  if (k.ctrl || k.alt) return undefined;
  const t = k.text ?? (k.name === 'space' ? ' ' : k.name.length === 1 ? k.name : undefined);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: typed text never carries controls
  if (t === undefined || t === '' || /[\u0000-\u001f\u007f-\u009f]/.test(t)) return undefined;
  return t;
}

/** A one-line field's text after `k`, or undefined when `k` does not edit it. */
export function edit(text: string, k: Key): string | undefined {
  if (k.name === 'backspace') return graphemes(text).slice(0, -1).join('');
  if (chord(k, 'u')) return '';
  const t = typed(k);
  return t === undefined ? undefined : text + t;
}

/**
 * The card: the area dimmed to the cabinet's glass with scanlines, a double frame in `colour`, and
 * a title. A pixel-font title sits above the frame when there is room; otherwise the title is a
 * plate on the frame's top edge. `mono` (`NO_COLOR`) draws the pixel title as line work, so it
 * never becomes solid light blocks. Returns the rect inside the frame.
 */
export function card(
  g: Grid,
  area: Rect,
  title: string,
  colour: string,
  opts: { maxW?: number; pixel?: boolean; mono?: boolean } = {},
): Rect {
  g.fill(area, { bg: T.glass });
  for (let y = area.y + 1; y < area.y + area.h; y += 2)
    g.fill({ x: area.x, y, w: area.w, h: 1 }, { bg: T.scan });
  let top = area.y;
  const pix = pixText(title, colour);
  const pixelRoom = opts.pixel !== false && area.h >= 16 && pix.w <= area.w - 4;
  if (pixelRoom) {
    g.blit(
      area.x + Math.floor((area.w - pix.w) / 2),
      top,
      halfBlocks(opts.mono === true ? monoPixels(pix.px) : pix.px),
    );
    top += pix.h / 2 + 1;
  }
  const w = Math.min(area.w, opts.maxW ?? area.w);
  const x = area.x + Math.floor((area.w - w) / 2);
  const box = { x, y: top, w, h: area.y + area.h - top };
  g.box(box, 'double', { fg: colour });
  const plate = ` ${title} `;
  // NO_COLOR: the plate is bold underlined words in its colour on the frame, never a lit bar.
  g.text(x + 2, top, trunc(plate, w - 4), chip(colour, T.glass, opts.mono === true));
  return { x: x + 2, y: top + 1, w: Math.max(0, w - 4), h: Math.max(0, box.h - 2) };
}

/** A hint along the inside bottom edge of a card's frame. */
export function footer(g: Grid, inner: Rect, hint: string): void {
  g.text(inner.x, inner.y + inner.h, trunc(` ${hint} `, inner.w), { fg: T.gray });
}

/** The first row to show so that `sel` stays in a window of `rows` rows. */
export function scrollFor(sel: number, rows: number, count: number, prev = 0): number {
  if (rows <= 0) return 0;
  let top = Math.min(prev, Math.max(0, count - rows));
  if (sel < top) top = sel;
  if (sel >= top + rows) top = sel - rows + 1;
  return Math.max(0, top);
}

/** The field line: a prompt, the text, and a block caret. */
export function field(
  g: Grid,
  x: number,
  y: number,
  w: number,
  prompt: string,
  text: string,
): void {
  const p = g.text(x, y, prompt, { fg: T.cyan, bold: true }, w);
  const room = w - p - 1;
  const shown =
    textWidth(text) > room
      ? `…${graphemes(text)
          .slice(-(room - 1))
          .join('')}`
      : text;
  const t = g.text(x + p, y, shown, { fg: T.white }, room);
  g.put(x + p + t, y, '▏', { fg: T.cyan });
}

export { centre, trunc };
