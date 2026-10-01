/**
 * The stage under NO_COLOR (review fix): every state the strip draws still reads in the monochrome
 * pair. Each frame goes through the host's own monochrome mapping (`monoView`), and each state must
 * both differ from the strip at rest and keep its word or glyph visible (ink on the other shade from
 * its background): an emote's ✦ label, READY! and the read mark, the SIGNED! power-up, the attract
 * screen. At the three capture sizes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PRESS_ANY_KEY } from '../../src/app/stage/attract.ts';
import { SIGNED_PLATE } from '../../src/app/stage/power-up.ts';
import { createStage, type PorchStage, READY } from '../../src/app/stage/stage.ts';
import { emote, IdleSteps, message, monoView, Rig } from './rig.ts';

const SIZES = [
  [40, 52],
  [100, 32],
  [160, 44],
] as const;

const dir = mkdtempSync(join(tmpdir(), 'porch-nocolor-'));
const seen = join(dir, 'seen');
mkdirSync(seen);
writeFileSync(join(seen, 'attract-seen'), 'test\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function crew(): Rig {
  const rig = new Rig();
  for (const who of ['bolt', 'wisp', 'mochi'] as const) rig.join(who);
  rig.load('commons', [
    message('bolt', 'rewriting the parser'),
    message('mochi', 'baking the release notes'),
  ]);
  return rig;
}
const stageIn = (d: string): PorchStage =>
  createStage({ stateDir: () => d, timers: new IdleSteps() });

/** Step the clock `ms` into the running burst; the frame there. */
/** Phone width shows heads (T6 picks heads there); wider screens show bodies. */
const fitFor = (cols: number) => (cols === 40 ? 'heads' : 'bodies');

function at(rig: Rig, stage: PorchStage, cols: number, rows: number, ms: number) {
  let start: number | undefined;
  for (let t = rig.tick(); t !== undefined; t = rig.tick()) {
    start ??= t;
    if (t - start >= ms) break;
  }
  return monoView(rig.draw(stage, cols, rows, { fit: fitFor(cols) }));
}

describe('the stage in monochrome', () => {
  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: every state keeps its word or glyph and differs from rest`, () => {
      const rest = (() => {
        const rig = crew();
        return monoView(rig.draw(stageIn(seen), cols, rows, { fit: fitFor(cols) }));
      })();
      expect(rest.text).toContain('Bolt');
      expect(rest.text).not.toContain('╔');

      const states: [string, () => ReturnType<typeof monoView>, string][] = [
        [
          'emote',
          () => {
            const rig = crew();
            const stage = stageIn(seen);
            rig.draw(stage, cols, rows, { fit: fitFor(cols) });
            stage.event(
              { kind: 'arrival', channel: 'commons', records: [emote('bolt', 'beep-boop')] },
              rig.state(),
            );
            return at(rig, stage, cols, rows, 375);
          },
          // Heads have no label row: there the emote is the head's own motion, checked by the
          // frame differing from rest. Bodies carry the ✦ label too.
          cols === 40 ? 'Bolt' : '✦ beep-boop',
        ],
        [
          'READY!',
          () => {
            const rig = crew();
            const stage = stageIn(seen);
            rig.draw(stage, cols, rows, { fit: fitFor(cols) });
            stage.event(
              { kind: 'sent', channel: 'commons', id: 'm-1', mode: 'casual' },
              rig.state(),
            );
            stage.event(
              { kind: 'seen', channel: 'commons', id: 'm-1', participant: 'p-bolt' },
              rig.state(),
            );
            return at(rig, stage, cols, rows, 0);
          },
          READY,
        ],
        [
          'read mark',
          () => {
            const rig = crew();
            const stage = stageIn(seen);
            rig.draw(stage, cols, rows, { fit: fitFor(cols) });
            stage.event(
              { kind: 'sent', channel: 'commons', id: 'm-2', mode: 'casual' },
              rig.state(),
            );
            stage.event(
              { kind: 'seen', channel: 'commons', id: 'm-2', participant: 'p-bolt' },
              rig.state(),
            );
            while (rig.tick() !== undefined) rig.draw(stage, cols, rows, { fit: fitFor(cols) });
            return monoView(rig.draw(stage, cols, rows, { fit: fitFor(cols) }));
          },
          'Bolt ✓',
        ],
        [
          'power-up',
          () => {
            const rig = crew();
            const stage = stageIn(seen);
            rig.draw(stage, cols, rows, { fit: fitFor(cols) });
            stage.event(
              { kind: 'sent', channel: 'commons', id: 'm-3', mode: 'signed' },
              rig.state(),
            );
            return at(rig, stage, cols, rows, 125);
          },
          '╔═',
        ],
        [
          'attract',
          () => {
            const fresh = mkdtempSync(join(dir, 'fresh-'));
            const rig = crew();
            const stage = stageIn(fresh);
            rig.draw(stage, cols, rows, { fit: fitFor(cols) });
            while (rig.tick() !== undefined) rig.draw(stage, cols, rows, { fit: fitFor(cols) });
            return monoView(rig.draw(stage, cols, rows, { fit: fitFor(cols) }));
          },
          PRESS_ANY_KEY,
        ],
      ];
      for (const [name, frame, word] of states) {
        const f = frame();
        expect(f.key, `${name} looks like rest in monochrome`).not.toBe(rest.key);
        expect(f.text, `${name}: ${word} not visible in monochrome`).toContain(word);
      }
    });

  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: the SIGNED! plate's letters stay lit inside its frame in monochrome`, () => {
      const rig = crew();
      const stage = stageIn(seen);
      rig.draw(stage, cols, rows, { fit: fitFor(cols) });
      stage.event({ kind: 'sent', channel: 'commons', id: 'm-4', mode: 'signed' }, rig.state());
      const frame = at(rig, stage, cols, rows, 125).text.split('\n');
      const top = frame.findIndex((l) => l.includes('╔'));
      const bottom = frame.findIndex((l) => l.includes('╚'));
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeGreaterThan(top);
      const left = frame[top]?.indexOf('╔') ?? -1;
      const right = frame[top]?.indexOf('╗') ?? -1;
      const inside = frame.slice(top + 1, bottom).map((l) => l.slice(left + 1, right));
      const lit = inside.join('').replace(/[^▀▄█]/g, '').length;
      const dark = inside.join('').replace(/[^ ]/g, '').length;
      // The letters are lit pixels on a dark plate: both present, so the word has a shape.
      expect(lit, inside.join('\n')).toBeGreaterThan(20);
      expect(dark).toBeGreaterThan(lit / 2);
      expect(SIGNED_PLATE).toBe('SIGNED!');
    });
});
