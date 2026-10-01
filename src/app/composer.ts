/**
 * The composer's text editing, as pure functions on text and a caret (plan T6, "The composer";
 * keybinding layer 9). The caret is a UTF-16 index that always sits on a grapheme boundary, so an
 * edit never splits an emoji, a flag or a combining mark.
 *
 * Lines wrap at word boundaries like message bodies do, and each visual line remembers where in the
 * text it starts, so ↑ and ↓ move the caret between visual lines of a multi-line draft and report
 * the edge instead of moving when there is no line to go to.
 */
import { graphemes, textWidth } from '../grid/text.ts';

export type Edit = { text: string; caret: number };

/** Grapheme boundaries of `text`, 0 and `text.length` included. */
function boundaries(text: string): number[] {
  const out = [0];
  let at = 0;
  for (const g of graphemes(text)) {
    at += g.length;
    out.push(at);
  }
  return out;
}

/** The boundary at or before `i`. */
export function snap(text: string, i: number): number {
  let best = 0;
  for (const b of boundaries(text)) {
    if (b > i) break;
    best = b;
  }
  return best;
}

export function insert(e: Edit, s: string): Edit {
  const clean = cleanInput(s);
  if (clean === '') return e;
  return {
    text: e.text.slice(0, e.caret) + clean + e.text.slice(e.caret),
    caret: e.caret + clean.length,
  };
}

/**
 * Typed or pasted text as the composer keeps it: CRLF and CR become LF, a tab becomes a space,
 * and any other control character is dropped (a paste never smuggles an escape into a message).
 */
export function cleanInput(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(INPUT_CONTROLS, '');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: controls are what this removes
const INPUT_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function backspace(e: Edit): Edit {
  if (e.caret === 0) return e;
  const b = boundaries(e.text);
  const prev = b.filter((x) => x < e.caret).at(-1) ?? 0;
  return { text: e.text.slice(0, prev) + e.text.slice(e.caret), caret: prev };
}

export function deleteForward(e: Edit): Edit {
  const next = boundaries(e.text).find((x) => x > e.caret);
  if (next === undefined) return e;
  return { text: e.text.slice(0, e.caret) + e.text.slice(next), caret: e.caret };
}

export function left(e: Edit): Edit {
  const prev = boundaries(e.text)
    .filter((x) => x < e.caret)
    .at(-1);
  return prev === undefined ? e : { ...e, caret: prev };
}

export function right(e: Edit): Edit {
  const next = boundaries(e.text).find((x) => x > e.caret);
  return next === undefined ? e : { ...e, caret: next };
}

/** Start and end of the logical line (between newlines) holding the caret. */
function logicalLine(e: Edit): { start: number; end: number } {
  const start = e.text.lastIndexOf('\n', e.caret - 1) + 1;
  const nl = e.text.indexOf('\n', e.caret);
  return { start, end: nl === -1 ? e.text.length : nl };
}

export function home(e: Edit): Edit {
  return { ...e, caret: logicalLine(e).start };
}

export function end(e: Edit): Edit {
  return { ...e, caret: logicalLine(e).end };
}

/** Delete from the caret back to the start of the word before it (Ctrl+W, Alt+Backspace). */
export function deleteWord(e: Edit): Edit {
  let i = e.caret;
  while (i > 0 && /\s/.test(e.text[i - 1] ?? '')) i--;
  while (i > 0 && !/\s/.test(e.text[i - 1] ?? '')) i--;
  i = snap(e.text, i);
  return { text: e.text.slice(0, i) + e.text.slice(e.caret), caret: i };
}

/** One visual line: the text from `start` to `end` (a newline or a wrap point is not included). */
export type VisualLine = { start: number; end: number; text: string };

/**
 * The draft as it is drawn in `width` columns: logical lines split at newlines, each wrapped at
 * the last space that fits, or between graphemes when a word is wider than the line. A trailing
 * newline gives an empty last line, so the caret has somewhere to be.
 */
export function visualLines(text: string, width: number): VisualLine[] {
  const cols = Math.max(1, width);
  const out: VisualLine[] = [];
  let at = 0;
  for (const para of text.split('\n')) {
    const gs = graphemes(para);
    let start = at;
    let line = '';
    let used = 0;
    let lastSpace = -1; // index into `line` after the space, and its offset in the text
    let lastSpaceOffset = -1;
    let offset = at;
    for (const g of gs) {
      const w = textWidth(g);
      if (used + w > cols && line !== '') {
        if (lastSpace > 0 && g !== ' ') {
          out.push({ start, end: lastSpaceOffset, text: line.slice(0, lastSpace) });
          line = line.slice(lastSpace);
          start = lastSpaceOffset;
          used = textWidth(line);
        } else {
          out.push({ start, end: offset, text: line });
          line = '';
          start = offset;
          used = 0;
        }
        lastSpace = -1;
      }
      line += g;
      used += w;
      offset += g.length;
      if (g === ' ') {
        lastSpace = line.length;
        lastSpaceOffset = offset;
      }
    }
    out.push({ start, end: offset, text: line });
    at = offset + 1;
  }
  return out;
}

/** The visual line holding the caret, and the caret's column in it. */
export function caretPosition(
  lines: readonly VisualLine[],
  caret: number,
): { row: number; col: number } {
  for (let row = lines.length - 1; row >= 0; row--) {
    const line = lines[row];
    if (line !== undefined && caret >= line.start) {
      const before = line.text.slice(0, Math.min(caret - line.start, line.text.length));
      return { row, col: textWidth(before) };
    }
  }
  return { row: 0, col: 0 };
}

/** The offset in `line` nearest to `col` columns from its start, on a grapheme boundary. */
function offsetAtColumn(line: VisualLine, col: number): number {
  let used = 0;
  let at = line.start;
  for (const g of graphemes(line.text)) {
    const w = textWidth(g);
    if (used + w > col) break;
    used += w;
    at += g.length;
  }
  return at;
}

/**
 * ↑ or ↓ inside a multi-line draft: the caret moves to the same column of the neighbouring visual
 * line. At the first line (↑) or the last (↓) it stays, and `edge` says so.
 */
export function vertical(e: Edit, width: number, dir: -1 | 1): { edit: Edit; edge: boolean } {
  const lines = visualLines(e.text, width);
  const { row, col } = caretPosition(lines, e.caret);
  const target = lines[row + dir];
  if (target === undefined) return { edit: e, edge: true };
  return { edit: { ...e, caret: offsetAtColumn(target, col) }, edge: false };
}

/** The `@word` being typed at the caret, if any: where it starts and what follows the `@`. */
export function mentionAt(e: Edit): { start: number; query: string } | undefined {
  const before = e.text.slice(0, e.caret);
  const m = /(^|\s)@([A-Za-z0-9._-]*)$/.exec(before);
  if (m === null) return undefined;
  const query = m[2] ?? '';
  return { start: e.caret - query.length - 1, query };
}

/** Replace the `@word` at the caret with `@completion ` . */
export function completeMention(e: Edit, completion: string): Edit {
  const at = mentionAt(e);
  if (at === undefined) return e;
  const inserted = `@${completion} `;
  return {
    text: e.text.slice(0, at.start) + inserted + e.text.slice(e.caret),
    caret: at.start + inserted.length,
  };
}
