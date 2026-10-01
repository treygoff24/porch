/**
 * The 3×5 pixel font and the half-block rasteriser (I3): one cell is two stacked pixels, `▀` with
 * the top pixel as foreground and the bottom as background (equal colours included: no `█`), `▄`
 * when only the bottom is set, and a null `bg` wherever a pixel is transparent.
 */
import { describe, expect, it } from 'vitest';
import { Grid, scanlines } from '../src/grid/grid.ts';
import { drawPix, halfBlocks, pixText, pixWidth, spritePixels } from '../src/grid/pixel.ts';

const R = '#ff0000';
const B = '#0000ff';

describe('half blocks', () => {
  it('maps each pair of pixel rows to one cell by the four rules', () => {
    const cells = halfBlocks([
      [R, R, null, null, R],
      [B, R, B, null, null],
    ]);
    expect(cells).toEqual([
      [
        { ch: '▀', fg: R, bg: B },
        { ch: '▀', fg: R, bg: R },
        { ch: '▄', fg: B, bg: null },
        null,
        { ch: '▀', fg: R, bg: null },
      ],
    ]);
  });

  it('treats a missing last pixel row as transparent', () => {
    expect(halfBlocks([[R]])).toEqual([[{ ch: '▀', fg: R, bg: null }]]);
  });

  it('draws a 16×16 sprite as 16 columns by 8 rows', () => {
    const rows = Array.from({ length: 16 }, () => 'a'.repeat(16));
    const cells = halfBlocks(spritePixels(rows, { a: R }));
    expect(cells).toHaveLength(8);
    const solid = { ch: '▀', fg: R, bg: R };
    expect(
      cells.every(
        (row) =>
          row.length === 16 &&
          row.every((c) => c !== null && c.ch === solid.ch && c.fg === R && c.bg === R),
      ),
    ).toBe(true);
    expect(JSON.stringify(cells)).not.toContain('█');
  });
});

describe('the pixel font', () => {
  it('sets letters 3 pixels wide with 1 pixel between, and rounds the height to whole cells', () => {
    const img = pixText('HI', R);
    expect(img.w).toBe(7);
    expect(img.h).toBe(6);
    expect(pixWidth('HI')).toBe(7);
    const row = (y: number) => (img.px[y] ?? []).map((p) => (p === null ? '.' : '#')).join('');
    expect([0, 1, 2, 3, 4, 5].map(row)).toEqual([
      '#.#.###',
      '#.#..#.',
      '###..#.',
      '#.#..#.',
      '#.#.###',
      '.......',
    ]);
  });

  it('scales, colours by font row, upper-cases, and draws an unknown character as ?', () => {
    const img = pixText('a', (r) => (r === 0 ? R : B), { sx: 2, sy: 2 });
    expect(img.w).toBe(6);
    expect(img.h).toBe(10);
    expect(img.px[0]?.[2]).toBe(R);
    expect(img.px[4]?.[0]).toBe(B);
    expect(pixText('~', R).px).toEqual(pixText('?', R).px);
    expect(pixWidth('A B', 2)).toBe(2 * (4 + 2 + 4) - 2);
  });

  it('puts a shadow behind the letters, never over them', () => {
    const img = pixText('I', R, { shadow: B });
    expect(img.w).toBe(4);
    expect(img.px[0]?.slice(0, 3)).toEqual([R, R, R]);
    expect(img.px[1]?.[3]).toBe(B);
  });

  it('blits into the grid through drawPix', () => {
    const g = new Grid(8, 3, scanlines('#000000'));
    drawPix(g, 0, 0, 'I', R);
    expect(g.toText().split('\n')).toEqual(['▀▀▀     ', ' ▀      ', '▀▀▀     ']);
    expect(g.at(1, 0)).toMatchObject({ ch: '▀', fg: R, bg: R });
  });
});
