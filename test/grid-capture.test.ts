/**
 * The capture pipeline as another lane calls it: a grid it drew itself (half-block pixels blitted,
 * as the pixel lane's sheet will be) goes in, and a PNG of the grid's size comes out, without
 * `scripts/capture.ts` knowing the scene. Skipped where no Chromium is on PATH.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CELL_H, CELL_W, captureGrid, findChromium } from '../scripts/capture.ts';
import { Grid, halfBlocks, scanlines } from '../src/grid/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'porch-capture-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(file: string): { width: number; height: number; signature: string } {
  const b = readFileSync(file);
  return {
    signature: b.subarray(0, 8).toString('hex'),
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
  };
}

describe.skipIf(findChromium() === undefined)('captureGrid', () => {
  it('writes a PNG of a grid drawn outside the script, sized to the grid', async () => {
    const grid = new Grid(12, 4, scanlines('#05080b', '#0a0f14'));
    const red = '#ff3355';
    grid.blit(
      1,
      1,
      halfBlocks([
        [red, null, red],
        [red, red, null],
      ]),
    );
    grid.text(5, 1, 'sheet');
    const png = await captureGrid(grid, join(dir, 'nested', 'sheet.png'), { html: true });
    expect(png).toBe(join(dir, 'nested', 'sheet.png'));
    expect(pngSize(png)).toEqual({
      signature: '89504e470d0a1a0a',
      width: 12 * CELL_W,
      height: 4 * CELL_H,
    });
    // The page beside it holds the blitted pixels as half-block cells.
    expect(readFileSync(join(dir, 'nested', 'sheet.html'), 'utf8')).toContain(
      `linear-gradient(${red} 50%`,
    );
  }, 60_000);
});
