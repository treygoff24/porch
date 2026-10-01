/**
 * The crew strip when two members of a channel share a name: the hint (their directory) is carried
 * on the member and drawn in gray after the name; a unique name has none (RUNTIME-SPEC.md).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { crewFor } from '../../src/app/stage/crew.ts';
import { createStage } from '../../src/app/stage/stage.ts';
import { T } from '../../src/app/stage/theme.ts';
import { IdleSteps, lines, Rig } from './rig.ts';

const seenDir = mkdtempSync(join(tmpdir(), 'porch-same-name-'));
writeFileSync(join(seenDir, 'attract-seen'), 'test\n');
afterAll(() => rmSync(seenDir, { recursive: true, force: true }));

describe('crew with a shared name', () => {
  it('carries the hint for the shared name and none for a unique one, and draws it gray', () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.join('wisp');
    rig.join('mochi');
    rig.names.set('p-wisp', 'Bolt');
    const hints = new Map([
      ['p-bolt', '~/Code/porch'],
      ['p-wisp', '~/Code/atlas'],
    ]);
    const s = rig.state(100, 32, { hints: () => hints });
    const crew = crewFor('commons', s);
    expect(crew.map((m) => [m.name, m.hint])).toEqual([
      ['Trey', ''],
      ['Bolt', '~/Code/porch'],
      ['Bolt', '~/Code/atlas'],
      ['Mochi', ''],
    ]);
    const g = rig.draw(createStage({ stateDir: () => seenDir, timers: new IdleSteps() }), 100, 32, {
      state: s,
    });
    const text = lines(g).join('\n');
    expect(text).toContain('~/Code');
    const row = lines(g).findIndex((l) => l.includes('~/Code'));
    const col = lines(g)[row]?.indexOf('~/Code') ?? 0;
    expect(g.at(col, row)?.fg).toBe(T.gray);
  });
});
