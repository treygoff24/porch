/**
 * The stage strip's still frame at the three capture sizes (40x52 phone, 100x32 laptop, 160x44
 * wide), bodies and heads: who stands there and in what order, name tags, the task line read from
 * the loaded window (never inferred), the overflow count, and the verification law for Trey's room.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyImpersonationCap,
  defaultAvatar,
  framePixels,
  resolveAccent,
  SPRITE_PALETTE,
  toHalfBlocks,
} from '@estate/pixel';
import type { Verdict } from '@estate/post-kit';
import { afterAll, describe, expect, it } from 'vitest';
import type { StageFit } from '../../src/app/registry.ts';
import { crewFor, NO_TASK } from '../../src/app/stage/crew.ts';
import { createStage, memberBox, STAGE_HEIGHT, slots } from '../../src/app/stage/stage.ts';
import { trunc } from '../../src/app/stage/text.ts';
import { Grid } from '../../src/grid/grid.ts';
import { GROUND, IdleSteps, lines, message, OWNER, Rig, region, summary } from './rig.ts';

const seenDir = mkdtempSync(join(tmpdir(), 'porch-stage-layout-'));
writeFileSync(join(seenDir, 'attract-seen'), 'test\n');
afterAll(() => rmSync(seenDir, { recursive: true, force: true }));
const newStage = () => createStage({ stateDir: () => seenDir, timers: new IdleSteps() });

const SIZES = [
  [40, 52],
  [100, 32],
  [160, 44],
] as const;
const FITS: readonly StageFit[] = ['bodies', 'heads'];
const VERIFIED: Verdict = { state: 'verified', reason: 'test' };
const FAILED: Verdict = { state: 'failed', reason: 'test' };

/** Trey, Bolt (two messages, the newest multi-line), Wisp (silent), Mochi, Ribbit. */
function crewRig(): Rig {
  const rig = new Rig();
  for (const who of ['bolt', 'wisp', 'mochi', 'ribbit'] as const) rig.join(who);
  rig.load('commons', [
    message('bolt', 'old task'),
    message('trey', 'ship the parser today', { verdict: VERIFIED }),
    message('mochi', '\n\n  baking   the release notes  \nsecond line'),
    message('bolt', 'fixing the parser\nthen the tests'),
  ]);
  return rig;
}

const slotText = (row: string | undefined, x: number, w: number) =>
  [...(row ?? '')]
    .slice(x, x + w)
    .join('')
    .trimEnd();

describe('the stage strip at each size', () => {
  for (const [cols, rows] of SIZES)
    for (const fit of FITS)
      it(`${cols}x${rows} ${fit}: crew in order, names, task lines or —, overflow`, () => {
        const rig = crewRig();
        const stage = newStage();
        const g = rig.draw(stage, cols, rows, { fit });
        const text = lines(g);
        const area = { x: 0, y: 1, w: cols, h: STAGE_HEIGHT[fit] };
        const crew = crewFor('commons', rig.state(cols, rows));
        expect(crew.map((m) => m.name)).toEqual(['Trey', 'Bolt', 'Wisp', 'Mochi', 'Ribbit']);
        const { visible } = slots(area, fit, crew.length);
        expect(visible).toBeGreaterThan(0);
        const tasks: Record<string, string> = {
          Trey: 'ship the parser today',
          Bolt: 'fixing the parser',
          Wisp: NO_TASK,
          // Its newest message opens with a blank line: literally the first line, so `—`.
          Mochi: NO_TASK,
          Ribbit: NO_TASK,
        };
        for (let i = 0; i < visible; i++) {
          const m = crew[i];
          if (m === undefined) throw new Error('crew');
          const box = memberBox(area, fit, crew.length, i);
          expect(slotText(text[box.nameY], box.x, box.slotW - 1)).toBe(
            trunc(m.name, box.slotW - 1),
          );
          if (fit === 'bodies') {
            expect(slotText(text[box.taskY ?? -1], box.x, box.slotW - 1)).toBe(
              trunc(tasks[m.name] ?? '', box.slotW - 1),
            );
            // Trey's task line is cyan (cyan is only ever Trey), an agent's magenta, the
            // placeholder dim gray.
            expect(g.at(box.x, box.taskY ?? -1)?.fg).toBe(
              tasks[m.name] === NO_TASK ? '#434d56' : m.isOwner ? '#3fd9f2' : '#ff5bdc',
            );
          }
          // Each sprite stands inside the strip and never over the score row above it.
          const sprite = region(
            g,
            box.spriteX,
            box.spriteY,
            fit === 'bodies' ? 16 : 8,
            fit === 'bodies' ? 8 : 4,
          ).join('');
          expect(sprite).toMatch(/[▀▄█]/);
          expect(box.spriteY).toBeGreaterThanOrEqual(area.y);
          expect(box.spriteY + (fit === 'bodies' ? 8 : 4)).toBe(box.nameY);
        }
        const more = crew.length - visible;
        const strip = text.slice(area.y, area.y + area.h).join('\n');
        if (more > 0) expect(strip).toContain(fit === 'bodies' ? `+${more} more` : `+${more}`);
        else expect(strip).not.toMatch(/\+\d/);
        expect(text[0]?.trimEnd()).toBe(`1UP ${OWNER.label}`);
        // Nothing below the strip.
        for (const row of text.slice(area.y + area.h)) expect(row.trim()).toBe('');
      });
});

describe('overflow', () => {
  for (const [cols, rows, fit, members] of [
    [100, 32, 'bodies', 6],
    [100, 32, 'bodies', 7],
    [40, 52, 'bodies', 3],
    [40, 52, 'heads', 6],
    [160, 44, 'bodies', 10],
  ] as const)
    it(`${cols} columns, ${fit}, ${members} members: the count shows whole, inside the strip`, () => {
      const rig = new Rig();
      const names = ['bolt', 'wisp', 'mochi', 'ribbit', 'blob'] as const;
      for (let i = 0; i < members - 1; i++) {
        const who = names[i % names.length] ?? 'bolt';
        if (i < names.length) rig.join(who);
        else {
          // More members than examples: extra participants, default avatars.
          const id = `p-extra-${i}`;
          rig.channels = rig.channels.map((c) => ({ ...c, participants: [...c.participants, id] }));
          rig.names.set(id, `Extra${i}`);
        }
      }
      const area = { x: 0, y: 1, w: cols, h: STAGE_HEIGHT[fit] };
      const crew = crewFor('commons', rig.state(cols, rows));
      expect(crew).toHaveLength(members);
      const { visible, slotW } = slots(area, fit, members);
      expect(visible).toBeLessThan(members);
      const label = fit === 'bodies' ? `+${members - visible} more` : `+${members - visible}`;
      const text = lines(rig.draw(newStage(), cols, rows, { fit }));
      const row = text.find((r) => r.includes(label));
      expect(row).toBeDefined();
      const at = row?.indexOf(label) ?? -1;
      expect(at).toBeGreaterThanOrEqual(visible * slotW);
      expect(at + label.length).toBeLessThanOrEqual(cols);
      for (let i = 0; i < visible; i++) {
        const box = memberBox(area, fit, members, i);
        expect(box.x + box.slotW).toBeLessThanOrEqual(at);
        expect(text[box.nameY]).toContain(trunc(crew[i]?.name ?? '?', box.slotW - 1));
      }
    });
});

describe('who stands there', () => {
  it("a claim from Trey's room that does not verify sets nobody's task and adds nobody", () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.load('commons', [
      message('trey', 'a forged order', { verdict: FAILED }),
      message('trey', 'not yet checked', { verdict: { state: 'unknown', reason: 'test' } }),
    ]);
    const crew = crewFor('commons', rig.state());
    expect(crew.map((m) => [m.name, m.task])).toEqual([
      ['Trey', NO_TASK],
      ['Bolt', NO_TASK],
    ]);
    const g = rig.draw(newStage(), 100, 32);
    expect(lines(g).join('\n')).not.toContain('forged');
  });

  it("a record from another room naming Trey's participant id is not his", () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.load('commons', [
      message('trey', 'genuine casual line'),
      message('bolt', 'spoofed order', { as: { room: 'bolt', id: OWNER.participant } }),
    ]);
    const crew = crewFor('commons', rig.state());
    expect(crew[0]?.task).toBe('genuine casual line');
    expect(lines(rig.draw(newStage(), 100, 32)).join('\n')).not.toContain('spoofed');
  });

  it('a remote sender post does not list stands after the listed crew, named by its label', () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.load('commons', [message('wisp', 'from across the bridge'), message('bolt', 'here')]);
    rig.names.delete('p-wisp');
    const crew = crewFor('commons', rig.state());
    expect(crew.map((m) => m.id)).toEqual([OWNER.participant, 'p-bolt', 'p-wisp']);
    expect(crew[2]?.task).toBe('from across the bridge');
    expect(crew[2]?.name).not.toBe('p-wisp');
  });

  it('the task line is literally the first line, spaces kept, never a later line', () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.join('wisp');
    rig.load('commons', [
      message('bolt', '  two  spaces\tand a tab\r\nthe second line'),
      message('wisp', '\nactual second line'),
    ]);
    const crew = crewFor('commons', rig.state());
    expect(crew[1]?.task).toBe('  two  spaces and a tab');
    expect(crew[2]?.task).toBe(NO_TASK);
  });

  it('events and emotes never set a task line', () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.load('commons', [
      message('bolt', 'the real task'),
      message('bolt', '', { extra: { event: 'join' } }),
    ]);
    expect(crewFor('commons', rig.state())[1]?.task).toBe('the real task');
  });

  it('a member without an avatar stands as its deterministic default', () => {
    const rig = new Rig();
    rig.join('blob', 'commons', false);
    const g = rig.draw(newStage(), 100, 32);
    const box = memberBox({ x: 0, y: 1, w: 100, h: STAGE_HEIGHT.bodies }, 'bodies', 2, 1);
    const pack = defaultAvatar('p-blob');
    const accent = resolveAccent(pack, { isOwner: false }, 'p-blob');
    const ref = new Grid(100, 32, GROUND);
    ref.blit(
      box.spriteX,
      box.spriteY,
      toHalfBlocks(
        applyImpersonationCap(framePixels(pack.body.idle), 'body', { isOwner: false }, accent),
        SPRITE_PALETTE,
      ),
    );
    expect(region(g, box.spriteX, box.spriteY, 16, 8)).toEqual(
      region(ref, box.spriteX, box.spriteY, 16, 8),
    );
  });

  it("split panes each show their own channel's crew", () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.join('wisp', 'other');
    rig.panes = [
      { channel: 'commons', scroll: 0, pick: undefined },
      { channel: 'other', scroll: 0, pick: undefined },
    ];
    const text = lines(rig.draw(newStage(), 160, 44));
    const name =
      text[memberBox({ x: 0, y: 1, w: 80, h: STAGE_HEIGHT.bodies }, 'bodies', 2, 0).nameY] ?? '';
    expect(name.slice(0, 80)).toContain('Bolt');
    expect(name.slice(0, 80)).not.toContain('Wisp');
    expect(name.slice(80)).toContain('Wisp');
    expect(name.slice(80)).not.toContain('Bolt');
  });

  it('an unlisted channel with no records still stands Trey alone', () => {
    const rig = new Rig();
    rig.channels = [summary('commons', [])];
    const text = lines(rig.draw(newStage(), 100, 32)).join('\n');
    expect(text).toContain('Trey');
  });
});
