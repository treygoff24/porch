import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { captureFeatures } from './captures.ts';

it('captures images, polls and recovery at all three required sizes', async () => {
  await captureFeatures();
  for (const size of ['40x52', '100x32', '160x44']) {
    for (const prefix of ['features', 'features-recovery']) {
      const png = readFileSync(`docs/captures/${prefix}-${size}.png`);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  }
}, 60000);
