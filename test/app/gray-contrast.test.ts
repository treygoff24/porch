/**
 * `gray` is the meta text colour (times, ids, hints, footers). The craft floor is 4.5:1 on every
 * surface it is drawn on, including the teal behind Trey's own messages and the raised bars. The
 * single value lives in `src/app/theme.ts`; the stage and demo themes derive from it, and the
 * copies that cannot import it (the pixel package's sheet script, the design docs) must match.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T } from '../../src/app/stage/theme.ts';
import { K } from '../../src/app/theme.ts';
import { K as DEMO } from '../../src/demo/demo-scene.ts';
import { luminance } from '../../src/grid/color.ts';

const FLOOR = 4.5;

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every background `gray` text is drawn on: the ground, the raised bars, Trey's records, the stage. */
const SURFACES = {
  glass: K.glass,
  scan: K.scan,
  panel: T.panel,
  bezel: K.bezel,
  bezelHi: K.bezelHi,
  deep: T.deep,
  youBg: K.youBg,
} as const;

const ROOT = join(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('gray meta text contrast', () => {
  for (const [name, bg] of Object.entries(SURFACES)) {
    it(`gray on ${name} (${bg}) is at least ${FLOOR}:1`, () => {
      expect(contrast(K.gray, bg)).toBeGreaterThanOrEqual(FLOOR);
    });
  }

  it('gray stays distinct from grayDim', () => {
    expect(contrast(K.gray, K.grayDim)).toBeGreaterThanOrEqual(3);
  });

  it('the stage and demo themes use the same gray as the main screen', () => {
    expect(T.gray).toBe(K.gray);
    expect(T.grayDim).toBe(K.grayDim);
    expect(DEMO.gray).toBe(K.gray);
    expect(DEMO.grayDim).toBe(K.grayDim);
  });

  it('the copies that cannot import the theme carry the same value', () => {
    expect(read('packages/pixel/test/sheet.ts')).toContain(`gray: '${K.gray}'`);
    expect(read('DESIGN.md')).toContain(`gray: "${K.gray}"`);
    expect(read('.impeccable/design.json')).toContain(
      `"canonical": "${K.gray}", "source": "K.gray`,
    );
  });
});
