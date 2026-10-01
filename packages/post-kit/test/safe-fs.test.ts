import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { SafeDirectory } from '../src/safe-fs.ts';
import { sandbox } from './helpers.ts';

const s = sandbox();
afterAll(() => s.cleanup());
it('descriptor listing survives path replacement, Unicode names, a failed probe and repeated reads', async () => {
  const original = join(s.root, 'listing');
  mkdirSync(original, { mode: 0o700 });
  const names = ['é🦊.json', 'x'.repeat(240)];
  for (const name of names) writeFileSync(join(original, name), '', { mode: 0o600 });
  const dir = await SafeDirectory.open(original);
  try {
    renameSync(original, join(s.root, 'held'));
    mkdirSync(original, { mode: 0o700 });
    writeFileSync(join(original, 'foreign'), '');
    expect(() => dir.open('missing')).toThrow();
    expect(dir.names().sort()).toEqual([...names].sort());
    expect(dir.names().sort()).toEqual([...names].sort());
  } finally {
    dir.close();
  }
});
