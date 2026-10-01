/**
 * Emote particles on the stage, in full motion. Trey's live test (2026-10-01) saw a custom emote
 * with `particle: spark` hop with no sparks at all: the bodies strip has no rows above its sprite,
 * so every particle, anchored above the sprite, was clipped away. A particle must show.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EmoteStep, PARTICLES, SPRITE_PALETTE } from '@estate/pixel';
import { afterAll, describe, expect, it } from 'vitest';
import { createStage, memberBox, STAGE_HEIGHT } from '../../src/app/stage/stage.ts';
import type { Grid, Rect } from '../../src/grid/grid.ts';
import { emote, IdleSteps, Rig } from './rig.ts';

const seenDir = mkdtempSync(join(tmpdir(), 'porch-particles-seen-'));
writeFileSync(join(seenDir, 'attract-seen'), 'test\n');
afterAll(() => rmSync(seenDir, { recursive: true, force: true }));

const COLOURS = { heart: 0xd, spark: 0x8, zzz: 0x3, question: 0x3, exclaim: 0x9 } as const;

/** Play a one-step emote of `particle` (or none) in `fit`; return every frame's stage grid. */
function play(
  fit: 'bodies' | 'heads',
  particle: EmoteStep['particle'],
  motion: 'full' | 'reduced' = 'full',
  ms = 400,
): { frames: Grid[]; area: Rect } {
  const rig = new Rig();
  rig.motion = motion;
  rig.join('mochi');
  const stage = createStage({ stateDir: () => seenDir, timers: new IdleSteps() });
  rig.draw(stage, 100, 32, { fit });
  const base = emote('mochi', 'celebrate').raw.emote?.emote;
  if (base == null) throw new Error('fixture is not playable');
  const step: EmoteStep = { pose: 'celebrate', ms, ...(particle ? { particle } : {}) };
  const e = emote('mochi', 'glow', { payload: { ...base, name: 'glow', steps: [step] } });
  stage.event({ kind: 'arrival', channel: 'commons', records: [e] }, rig.state(100, 32));
  const frames: Grid[] = [];
  while (rig.tick() !== undefined) frames.push(rig.draw(stage, 100, 32, { fit }));
  const area: Rect = { x: 0, y: 1, w: 100, h: STAGE_HEIGHT[fit] };
  return { frames, area };
}

/** Cells that differ between the particle run and a control run with no particle. */
function particleCells(
  fit: 'bodies' | 'heads',
  kind: EmoteStep['particle'],
  motion?: 'full' | 'reduced',
) {
  const withP = play(fit, kind, motion);
  const control = play(fit, undefined, motion);
  expect(withP.frames.length).toBeGreaterThan(0);
  expect(withP.frames.length).toBe(control.frames.length);
  const box = memberBox(withP.area, fit, 2, 1);
  const lit = withP.frames.map((g, i) => {
    const c = control.frames[i];
    const out: string[] = [];
    for (let y = withP.area.y; y < withP.area.y + withP.area.h; y++)
      for (let x = box.x; x < box.x + box.slotW; x++) {
        const a = g.at(x, y);
        const b = c?.at(x, y);
        if (a?.ch !== b?.ch || a?.fg !== b?.fg || a?.bg !== b?.bg) out.push(`${x},${y}`);
      }
    return out;
  });
  return { lit, g: withP.frames, area: withP.area, box };
}

describe('emote particles in full motion', () => {
  for (const fit of ['bodies', 'heads'] as const)
    for (const kind of PARTICLES.filter((k) => k !== 'none')) {
      it(`${kind} draws cells inside the ${fit} strip, from the first frame, never above it`, () => {
        const { lit, g, area } = particleCells(fit, kind);
        expect(lit[0]?.length).toBeGreaterThan(0);
        // The particle's own colour appears on the stage.
        const hex = SPRITE_PALETTE[COLOURS[kind]];
        const colours = new Set<string>();
        for (const key of lit[0] ?? []) {
          const [x, y] = key.split(',').map(Number) as [number, number];
          const c = g[0]?.at(x, y);
          if (c) colours.add(c.fg).add(c.bg);
        }
        expect(colours.has(hex as string)).toBe(true);
        // Nothing of it reaches the score-bar row above the strip.
        for (const frame of g) expect(frame.toText().split('\n')[area.y - 1]).toMatch(/^1UP/);
      });
    }

  it('reduced motion holds the particle still', () => {
    const { lit } = particleCells('bodies', 'spark', 'reduced');
    // The last frame is the rest after the emote ends: the particle is gone with it.
    const playing = lit.slice(0, -1);
    expect(playing.length).toBeGreaterThan(1);
    expect(playing.every((l) => l.length > 0)).toBe(true);
    expect(new Set(playing.map((l) => l.join('|'))).size).toBe(1);
    expect(lit.at(-1)).toEqual([]);
  });
});
