/**
 * The grid core (interface I5): cells, wide graphemes, combining marks, controls, tabs, clipping,
 * the drawing primitives, transparency, hit regions, and the text and HTML views. No renderer is
 * involved; a frame is plain data.
 */
import { describe, expect, it } from 'vitest';
import { type Cell, Grid, sameCell, scanlines } from '../src/grid/grid.ts';
import { graphemes, replaceControls, textWidth, width, wrap } from '../src/grid/text.ts';

const GROUND = scanlines('#05080b', '#0a0f14', '#dfe6ea');
const BLACK = scanlines('#000000');
const rows = (g: Grid) => g.toText().split('\n');
/** What `fn` returns when run under the clip `r`. */
function clipped(g: Grid, r: { x: number; y: number; w: number; h: number }, fn: () => number) {
  let n = Number.NaN;
  g.withClip(r, () => {
    n = fn();
  });
  return n;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: counting the controls that got through
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Every cell's glyph, continuation cells included, so a stray half is visible. */
function controlsIn(g: Grid): number {
  let n = 0;
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.cols; x++) if (CONTROL.test(g.at(x, y)?.ch ?? '')) n += 1;
  return n;
}

/** Every wide glyph has its continuation right after it, and every continuation has its glyph. */
function expectPaired(g: Grid) {
  for (let y = 0; y < g.rows; y++) {
    for (let x = 0; x < g.cols; x++) {
      const c = g.at(x, y) as Cell;
      if (c.w === 2) expect(g.at(x + 1, y)?.w, `continuation of ${x},${y}`).toBe(0);
      if (c.w === 0) expect(g.at(x - 1, y)?.w, `head of ${x},${y}`).toBe(2);
    }
  }
}

describe('widths and graphemes', () => {
  it('keeps emoji clusters whole and counts display columns, not string length', () => {
    expect(graphemes('a👨‍👩‍👧b')).toEqual(['a', '👨‍👩‍👧', 'b']);
    expect(graphemes('🇺🇸👍🏽1️⃣')).toEqual(['🇺🇸', '👍🏽', '1️⃣']);
    expect(width('a')).toBe(1);
    expect(width('界')).toBe(2);
    expect(width('👨‍👩‍👧')).toBe(2);
    expect(width('🇺🇸')).toBe(2);
    expect(width('▀')).toBe(1);
    expect(width('́')).toBe(0);
    expect(width('é')).toBe(1);
    expect(textWidth('a界👍🏽')).toBe(5);
  });

  it('counts a control as one column, since the grid draws it as U+FFFD', () => {
    expect(width('\x1b')).toBe(1);
    expect(replaceControls('ok\x1b[31m\x07\x9b\x7f')).toBe('ok\ufffd[31m\ufffd\ufffd\ufffd');
  });
});

describe('wrap', () => {
  it('breaks at spaces within the width, and long words between graphemes', () => {
    expect(wrap('the quick brown fox jumps', 10)).toEqual(['the quick', 'brown fox', 'jumps']);
    expect(wrap('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
  });

  it('keeps paragraphs (LF or CRLF), and a hanging indent under a bullet', () => {
    expect(wrap('one\n\ntwo', 10)).toEqual(['one', '', 'two']);
    expect(wrap('one\r\ntwo', 10)).toEqual(['one', 'two']);
    expect(wrap('- alpha beta gamma', 12)).toEqual(['- alpha beta', '  gamma']);
  });

  it('measures wide graphemes by columns and never splits a cluster', () => {
    const lines = wrap('界界界 👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧', 5);
    expect(lines).toEqual(['界界', '界', '👨‍👩‍👧👨‍👩‍👧', '👨‍👩‍👧']);
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(5);
  });

  it('never makes a line wider than its width, whatever the width', () => {
    const texts = [
      '123456. x',
      '- alpha beta gamma',
      '    * deeply indented bullet text',
      '12. 界界界 wide words 👨‍👩‍👧',
      'supercalifragilistic word',
      '1) a',
    ];
    for (const t of texts)
      for (let cols = 2; cols <= 16; cols++)
        for (const line of wrap(t, cols))
          expect(textWidth(line), `${JSON.stringify(t)} at ${cols}`).toBeLessThanOrEqual(cols);
  });

  it('wraps a number too wide to hang under as plain text', () => {
    expect(wrap('123456. x', 4)).toEqual(['1234', '56.', 'x']);
    // A bullet keeps its hanging indent only while it takes at most half the line.
    expect(wrap('1. ab cd', 6)).toEqual(['1. ab', '   cd']);
    expect(wrap('10. ab cd', 6)).toEqual(['10. ab', 'cd']);
  });

  it('defines widths 1 to 3, and gives no lines for less than one column', () => {
    expect(wrap('ab cd', 3)).toEqual(['ab', 'cd']);
    expect(wrap('- abc', 3)).toEqual(['-', 'abc']);
    expect(wrap('abc', 2)).toEqual(['ab', 'c']);
    expect(wrap('ab', 1)).toEqual(['a', 'b']);
    // One column cannot hold a wide grapheme: it takes a line of its own (the grid then draws the
    // column it has as a space).
    expect(wrap('a界b', 1)).toEqual(['a', '界', 'b']);
    expect(wrap('abc', 0)).toEqual([]);
    expect(wrap('abc', -3)).toEqual([]);
    expect(wrap('abc', Number.NaN)).toEqual([]);
  });

  it('replaces control characters in what it wraps, as the grid would draw them', () => {
    expect(wrap('a\x1b[2Jb c', 10)).toEqual(['a\ufffd[2Jb c']);
  });
});

describe('the grid', () => {
  it('starts as its ground, here with every odd row a scanline', () => {
    const g = new Grid(4, 3, GROUND);
    expect(g.at(0, 0)?.bg).toBe('#05080b');
    expect(g.at(0, 1)?.bg).toBe('#0a0f14');
    expect(g.at(3, 2)?.bg).toBe('#05080b');
    expect(g.toText()).toBe('    \n    \n    ');
  });

  it('draws text in the ground ink over the cell background unless told otherwise', () => {
    const g = new Grid(10, 2, GROUND);
    expect(g.text(1, 1, 'hi', { fg: '#3fd9f2', bold: true })).toBe(2);
    expect(g.at(1, 1)).toMatchObject({ ch: 'h', fg: '#3fd9f2', bg: '#0a0f14', bold: true, w: 1 });
    g.text(0, 0, 'x', { bg: '#eeeeee' });
    expect(g.at(0, 0)).toMatchObject({ fg: '#dfe6ea', bg: '#eeeeee' });
    g.put(0, 0, 'y');
    expect(g.at(0, 0)).toMatchObject({ ch: 'y', bg: '#eeeeee' });
    expect(g.at(0, 0)?.bold).toBeUndefined();
  });

  it('puts a wide grapheme in two cells: the glyph and an empty continuation', () => {
    const g = new Grid(6, 1, BLACK);
    expect(g.text(0, 0, 'a界b')).toBe(4);
    expect(g.at(1, 0)).toMatchObject({ ch: '界', w: 2 });
    expect(g.at(2, 0)).toMatchObject({ ch: '', w: 0 });
    expect(rows(g)[0]).toBe('a界b  ');
  });

  it('turns the other half into a space with the same background when either half is written', () => {
    const g = new Grid(6, 1, BLACK);
    g.text(0, 0, '界界界', { bg: '#123456', underline: true });
    g.put(1, 0, 'x');
    expect(rows(g)[0]).toBe(' x界界');
    expect(g.at(0, 0)).toMatchObject({ ch: ' ', w: 1, bg: '#123456' });
    expect(g.at(0, 0)?.underline).toBeUndefined();
    g.put(2, 0, 'y');
    expect(rows(g)[0]).toBe(' xy 界');
    expect(g.at(3, 0)).toMatchObject({ ch: ' ', w: 1, bg: '#123456' });
    // A wide glyph shifted one column over two others unpairs both of them.
    g.text(0, 0, '界界界');
    g.put(1, 0, '日');
    expect(rows(g)[0]).toBe(' 日 界');
    expectPaired(g);
  });

  it('writes a wide glyph that would cross the grid or clip edge as a space', () => {
    const g = new Grid(5, 1, BLACK);
    g.put(4, 0, '界', { bg: '#222222' });
    expect(g.at(4, 0)).toMatchObject({ ch: ' ', w: 1, bg: '#222222' });
    const h = new Grid(6, 1, BLACK);
    h.withClip({ x: 0, y: 0, w: 3, h: 1 }, () => h.put(2, 0, '界'));
    expect(rows(h)[0]).toBe('      ');
    expect(h.at(3, 0)?.w).toBe(1);
    expectPaired(g);
    expectPaired(h);
  });

  it('keeps a combining mark in its grapheme; a lone one takes no cell', () => {
    const g = new Grid(6, 1, BLACK);
    expect(g.text(0, 0, 'éä!')).toBe(3);
    expect(g.at(0, 0)?.ch).toBe('é');
    expect(g.at(1, 0)?.ch).toBe('ä');
    expect(g.at(2, 0)?.ch).toBe('!');
    g.put(5, 0, '́');
    expect(g.at(5, 0)?.ch).toBe(' ');
  });

  it('writes U+FFFD in place of any control, from put and from text', () => {
    const g = new Grid(14, 1, BLACK);
    g.text(0, 0, 'a\x1b[2Jb\x07c\x9bd\ne');
    expect(rows(g)[0]).toBe('a\ufffd[2Jb\ufffdc\ufffdd\ufffde  ');
    g.put(13, 0, '\x1b');
    expect(g.at(13, 0)?.ch).toBe('\ufffd');
    g.put(12, 0, '\r\n');
    expect(g.at(12, 0)?.ch).toBe('\ufffd');
    expect(controlsIn(g)).toBe(0);
  });

  it('expands a tab to the next multiple of four columns from where the text started', () => {
    const g = new Grid(16, 1, BLACK);
    expect(g.text(2, 0, 'a\tb\t\tc')).toBe(13);
    expect(rows(g)[0]).toBe('  a   b       c ');
  });

  it('stops text at maxCols and at the clip; a wide glyph crossing the limit becomes a space', () => {
    const g = new Grid(5, 1, BLACK);
    expect(g.text(0, 0, 'abcdefgh', {}, 3)).toBe(3);
    expect(rows(g)[0]).toBe('abc  ');
    const h = new Grid(5, 1, BLACK);
    expect(h.text(0, 0, 'abc界x', { bg: '#333333' }, 4)).toBe(4);
    expect(rows(h)[0]).toBe('abc  ');
    expect(h.at(3, 0)).toMatchObject({ ch: ' ', bg: '#333333', w: 1 });
    expect(h.at(4, 0)?.bg).toBe('#000000');
  });

  it('returns the columns it actually wrote under clipping: none on a row left out', () => {
    const g = new Grid(8, 3, BLACK);
    // Rows outside the grid.
    expect(g.text(0, 3, 'abc')).toBe(0);
    expect(g.text(0, -1, 'abc')).toBe(0);
    // A row outside the clip.
    expect(clipped(g, { x: 0, y: 1, w: 8, h: 2 }, () => g.text(0, 0, 'abc'))).toBe(0);
    // Columns 2 and 3 only: of 'abc' from column 0, just 'c' lands.
    expect(clipped(g, { x: 2, y: 0, w: 2, h: 1 }, () => g.text(0, 0, 'abc'))).toBe(1);
    expect(rows(g)[0]).toBe('  c     ');
    // Starting left of the grid: only the columns inside count.
    expect(g.text(-2, 1, 'abcd')).toBe(2);
    expect(rows(g)[1]).toBe('cd      ');
    // A tab across the clip's left edge counts only its columns inside.
    expect(clipped(g, { x: 2, y: 2, w: 6, h: 1 }, () => g.text(0, 2, '\tx'))).toBe(3);
    expect(rows(g)[2]).toBe('    x   ');
  });

  it("a wide glyph cut by the clip's left edge becomes a space in the column inside", () => {
    const g = new Grid(6, 1, BLACK);
    expect(clipped(g, { x: 1, y: 0, w: 5, h: 1 }, () => g.text(0, 0, '界b'))).toBe(2);
    expect(rows(g)[0]).toBe('  b   ');
    expect(g.at(1, 0)).toMatchObject({ ch: ' ', w: 1 });
    g.put(0, 0, 'q');
    expect(g.text(-1, 0, '界')).toBe(1);
    expect(g.at(0, 0)).toMatchObject({ ch: ' ', w: 1 });
  });

  it('draws only inside withClip, nested clips intersect, and the clip is restored after', () => {
    const g = new Grid(8, 3, BLACK);
    g.withClip({ x: 2, y: 0, w: 4, h: 2 }, () => {
      g.fill({ x: 0, y: 0, w: 8, h: 3 }, { bg: '#222222', ch: '#' });
      g.withClip({ x: 0, y: 1, w: 8, h: 5 }, () => g.text(0, 1, 'zzzzzzzz'));
    });
    expect(rows(g)).toEqual(['  ####  ', '  zzzz  ', '        ']);
    g.put(0, 2, 'q');
    expect(rows(g)[2]).toBe('q       ');
  });

  it('boxes in each kind, rules and fills', () => {
    const g = new Grid(6, 4, BLACK);
    g.fill({ x: 0, y: 0, w: 6, h: 4 }, { bg: '#101010' });
    g.box({ x: 0, y: 0, w: 6, h: 4 }, 'double', { fg: '#ffffff' });
    g.rule(1, 2, 4, '─', {});
    expect(rows(g)).toEqual(['╔════╗', '║    ║', '║────║', '╚════╝']);
    expect(g.at(2, 1)?.bg).toBe('#101010');
    const corners = (kind: 'single' | 'heavy' | 'dashed' | 'dotted') => {
      const b = new Grid(3, 3, BLACK);
      b.box({ x: 0, y: 0, w: 3, h: 3 }, kind, {});
      return rows(b).join('/');
    };
    expect(corners('single')).toBe('┌─┐/│ │/└─┘');
    expect(corners('heavy')).toBe('┏━┓/┃ ┃/┗━┛');
    expect(corners('dashed')).toBe('┌┄┐/┆ ┆/└┄┘');
    expect(corners('dotted')).toBe('┌┈┐/┊ ┊/└┈┘');
  });

  it('blits half-block cells, taking the existing background where bg is null', () => {
    const g = new Grid(4, 2, GROUND);
    g.fill({ x: 3, y: 0, w: 1, h: 1 }, { bg: '#abcdef' });
    g.blit(0, 0, [
      [
        { ch: '▀', fg: '#ff0000', bg: '#00ff00' },
        { ch: '▄', fg: '#0000ff', bg: null },
        null,
        { ch: '▀', fg: '#ffffff', bg: null },
      ],
      [{ ch: '▀', fg: '#111111', bg: null }],
    ]);
    expect(g.at(0, 0)).toMatchObject({ ch: '▀', fg: '#ff0000', bg: '#00ff00' });
    expect(g.at(1, 0)).toMatchObject({ ch: '▄', fg: '#0000ff', bg: '#05080b' });
    expect(g.at(2, 0)).toMatchObject({ ch: ' ', bg: '#05080b' });
    expect(g.at(3, 0)).toMatchObject({ ch: '▀', bg: '#abcdef' });
    // The scanline shows through on the odd row.
    expect(g.at(0, 1)).toMatchObject({ ch: '▀', bg: '#0a0f14' });
  });

  it('gives a click to the region registered last, clipped to the clip in force', () => {
    const g = new Grid(10, 5, BLACK);
    g.hit({ x: 0, y: 0, w: 10, h: 5 }, { id: 'back' });
    g.hit({ x: 2, y: 1, w: 3, h: 2 }, { id: 'front', data: 7 });
    g.withClip({ x: 0, y: 0, w: 10, h: 1 }, () =>
      g.hit({ x: 0, y: 0, w: 10, h: 3 }, { id: 'header' }),
    );
    expect(g.hitAt(3, 2)).toEqual({ id: 'front', data: 7 });
    expect(g.hitAt(5, 2)?.id).toBe('back');
    expect(g.hitAt(3, 0)?.id).toBe('header');
    expect(g.hitAt(3, 1)?.id).toBe('front');
    expect(g.hitAt(10, 0)).toBeNull();
  });

  it('compares cells by glyph, width, colours and attributes', () => {
    const a: Cell = { ch: 'x', fg: '#fff', bg: '#000', w: 1 };
    expect(sameCell(a, { ...a })).toBe(true);
    expect(sameCell(a, { ...a, bold: false })).toBe(true);
    expect(sameCell(a, { ...a, bold: true })).toBe(false);
    expect(sameCell(a, { ...a, bg: '#001' })).toBe(false);
    expect(sameCell(a, { ...a, ch: 'y' })).toBe(false);
  });

  it('lays out HTML one cell per grapheme, wide ones two cells wide, escaping markup', () => {
    const g = new Grid(5, 1, GROUND);
    g.text(0, 0, '<界>', { fg: '#3fd9f2' });
    g.put(4, 0, '▀', { fg: '#ff0000', bg: '#00ff00' });
    const html = g.toHtml({ cellWidth: 9, cellHeight: 18 });
    expect(html).toContain('>&lt;</b>');
    expect(html).toContain('width:18px;color:#3fd9f2');
    expect(html).toContain('linear-gradient(#ff0000 50%,#00ff00 50%)');
    expect(html.match(/<b /g)?.length).toBe(4);
  });
});
