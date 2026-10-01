/**
 * Text measured in terminal columns, never in string length. Widths come from `string-width` over
 * `Intl.Segmenter` grapheme clusters, as Loom does (`~/Code/loom/src/tui/format.ts:350-363`), so a
 * family emoji, a flag, a skin tone or a keycap is one unit of two columns, and a CJK character is
 * two. Wrapping is the Arcade prototype's (`prototypes/arcade/index.html:169-189`) with those widths.
 */
import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * What draws nothing and acts on the terminal instead: C0 controls (ESC, newline and tab included,
 * since a grid cell can hold none of them), DEL, and C1. OpenTUI keeps an escape it is given in the
 * cell it writes, so text from another participant that carries one would reach the terminal as a
 * sequence (Loom's `src/cockpit/post/wire.ts:74-86`). The grid never writes one: it writes U+FFFD in
 * its place (I5), so a control is visible as a replacement mark rather than silently lost.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const HAS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** What the grid writes in place of a control character. */
export const REPLACEMENT = '\ufffd';

/** Whether `s` holds any C0 or C1 control character. */
export function hasControl(s: string): boolean {
  return HAS_CONTROL.test(s);
}

/** `s` with every C0 or C1 control character replaced by U+FFFD. */
export function replaceControls(s: string): string {
  return s.replace(CONTROLS, REPLACEMENT);
}

/** The grapheme clusters of `s`: what a person reads as one character. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (seg) => seg.segment);
}

/**
 * Columns one grapheme takes: 0 (a lone combining mark, a zero-width joiner), 1, or 2. A combining
 * mark after a base character is part of that grapheme and adds nothing. A control is 1, because
 * the grid draws it as U+FFFD.
 */
export function width(g: string): 0 | 1 | 2 {
  // The common case, printable ASCII, without the library call.
  if (g.length === 1) {
    const c = g.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 1;
  }
  if (hasControl(g)) return 1;
  const w = stringWidth(g);
  return w <= 0 ? 0 : w === 1 ? 1 : 2;
}

/** Columns a whole string takes. */
export function textWidth(s: string): number {
  let w = 0;
  for (const g of graphemes(s)) w += width(g);
  return w;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * `s` broken into lines of at most `cols` columns. Paragraphs split at newlines (CRLF or LF); words
 * break at whitespace (tabs included), and a word longer than a line breaks between graphemes (never
 * inside one). Any other control becomes U+FFFD, as the grid would draw it.
 *
 * A line that starts with a bullet or a number keeps a hanging indent under its text, but only while
 * that prefix takes at most half the line; a wider one (`123456. ` in four columns) is wrapped as
 * plain words. Any width of one column or more works: at 1 to 3 no prefix hangs, and at 1 a wide
 * grapheme, which cannot fit, takes a line of its own (the only line wider than `cols`; the grid
 * draws its one column as a space). Less than one column gives no lines.
 */
export function wrap(s: string, cols: number): string[] {
  const limit = Math.floor(cols);
  if (!(limit >= 1)) return [];
  const out: string[] = [];
  for (const raw of s.split(/\r?\n/)) {
    const para = replaceControls(raw.replace(/\t/g, ' '));
    const bullet = BULLET.exec(para)?.[0] ?? '';
    const lead = textWidth(bullet) * 2 <= limit ? bullet : '';
    const hang = ' '.repeat(textWidth(lead));
    const tokens = para
      .slice(lead.length)
      .split(/\s+/)
      .filter((t) => t !== '');
    if (tokens.length === 0) {
      out.push(lead.trimEnd());
      continue;
    }
    let line = lead;
    let used = textWidth(lead);
    let empty = true;
    for (const tok of tokens) {
      const tw = textWidth(tok);
      if (!empty && used + 1 + tw > limit) {
        out.push(line);
        line = hang;
        used = hang.length;
        empty = true;
      }
      if (!empty) {
        line += ' ';
        used += 1;
      }
      if (used + tw > limit) {
        for (const g of graphemes(tok)) {
          const w = width(g);
          if (used + w > limit && used > hang.length) {
            out.push(line);
            line = hang;
            used = hang.length;
          }
          line += g;
          used += w;
        }
      } else {
        line += tok;
        used += tw;
      }
      empty = false;
    }
    out.push(line);
  }
  return out;
}
