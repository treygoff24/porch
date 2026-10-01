/**
 * The half-block rasteriser (I3): the four pairing rules, no full block ever, and agreement with the
 * app's own `halfBlocks` (`src/grid/pixel.ts`), which works on colours instead of palette indices.
 */
import { describe, expect, it } from 'vitest';
import { halfBlocks } from '../../../src/grid/pixel.ts';
import { mirrorX, type Pixel, SPRITE_PALETTE, toHalfBlocks } from '../src/index.ts';

const P = SPRITE_PALETTE;

describe('toHalfBlocks', () => {
  it('maps each pair of pixel rows by the four rules', () => {
    expect(
      toHalfBlocks(
        [
          [4, 4, null, null],
          [6, 4, 6, null],
        ],
        P,
      ),
    ).toEqual([
      [
        { ch: '▀', fg: P[4], bg: P[6] },
        { ch: '▀', fg: P[4], bg: P[4] },
        { ch: '▄', fg: P[6], bg: null },
        null,
      ],
    ]);
    expect(toHalfBlocks([[4], [null]], P)).toEqual([[{ ch: '▀', fg: P[4], bg: null }]]);
  });

  it('makes a 16×16 body 8 rows of 16 cells and an 8×8 head 4 rows of 8', () => {
    const body = Array.from({ length: 16 }, () => new Array<Pixel>(16).fill(3));
    const head = Array.from({ length: 8 }, () => new Array<Pixel>(8).fill(3));
    const b = toHalfBlocks(body, P);
    expect(b).toHaveLength(8);
    expect(b.every((r) => r.length === 16)).toBe(true);
    expect(toHalfBlocks(head, P)).toHaveLength(4);
  });

  it('never emits a full block, and agrees with the grid rasteriser on every pixel pairing', () => {
    // Every (top, bottom) pair of the 16 palette indices and transparent: 17 × 17 columns of one
    // cell row each.
    const values: Pixel[] = [null, ...SPRITE_PALETTE.map((_, i) => i)];
    const top: Pixel[] = [];
    const bottom: Pixel[] = [];
    for (const t of values) {
      for (const b of values) {
        top.push(t);
        bottom.push(b);
      }
    }
    const px = [top, bottom];
    // The fixture really covers all 16 indices and transparent, in both rows, in every pairing.
    expect(new Set(top).size).toBe(17);
    expect(new Set(bottom).size).toBe(17);
    expect(new Set(top.map((t, i) => `${t}/${bottom[i]}`)).size).toBe(289);

    const cells = toHalfBlocks(px, P);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveLength(289);
    for (const c of cells[0] ?? []) expect(c?.ch).not.toBe('█');
    const colours = px.map((row) => row.map((v) => (v === null ? null : (P[v] ?? null))));
    expect(cells).toEqual(halfBlocks(colours));
  });
});

describe('mirrorX', () => {
  it('reverses each row and leaves the input alone', () => {
    const px: Pixel[][] = [
      [1, 2, null],
      [null, 3, 4],
    ];
    expect(mirrorX(px)).toEqual([
      [null, 2, 1],
      [4, 3, null],
    ]);
    expect(px[0]).toEqual([1, 2, null]);
  });
});
