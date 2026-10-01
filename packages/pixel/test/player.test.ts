/**
 * The emote player as a pure function of time (I3, "Player semantics"): which step is active at
 * every step boundary, the 125 ms sub-tick motions, particles, the head target, and reduced motion.
 */
import { describe, expect, it } from 'vitest';
import { type FrozenEmote, freezeEmote, particleSprite, playEmote } from '../src/index.ts';

const row16 = (c: string) => c.repeat(16);
const frame16 = (c: string) => Array.from({ length: 16 }, () => row16(c)).join('/');
const frame8 = (c: string) => Array.from({ length: 8 }, () => c.repeat(8)).join('/');

/** Frames filled with one colour each, so the frame drawn can be read off any pixel. */
const EMOTE: FrozenEmote = {
  name: 'test',
  source: 'custom',
  library: 'builtin-1',
  steps: [
    { pose: 'wave', motion: 'hop', ms: 300 },
    { pose: 'idle', motion: 'shake', particle: 'heart', ms: 500 },
    { pose: 'celebrate', motion: 'flip', ms: 250 },
    { pose: 'missing', motion: 'blink', particle: 'spark', ms: 400 },
  ],
  frames: {
    body: { idle: frame16('1'), wave: frame16('2'), celebrate: frame16('3') },
    head: { idle: frame8('4'), wave: frame8('5') },
  },
};

describe('playEmote timing', () => {
  const p = playEmote(EMOTE, 'body', 'full');
  const colour = (t: number) => p.frameAt(t)?.px[0]?.[0];

  it('lasts the sum of its steps', () => {
    expect(p.durationMs).toBe(1450);
  });

  it('is null before it starts and from durationMs on', () => {
    expect(p.frameAt(-1)).toBeNull();
    expect(p.frameAt(-0.001)).toBeNull();
    expect(p.frameAt(1450)).toBeNull();
    expect(p.frameAt(1449.999)).not.toBeNull();
    expect(p.frameAt(Number.NaN)).toBeNull();
  });

  it('switches step exactly at each boundary (start inclusive, end exclusive)', () => {
    expect(colour(0)).toBe(2);
    expect(colour(299)).toBe(2);
    expect(colour(300)).toBe(1);
    expect(colour(799)).toBe(1);
    expect(colour(800)).toBe(3);
    expect(colour(1049)).toBe(3);
    // The fourth step's pose is not in the frames, so idle is drawn.
    expect(colour(1050)).toBe(1);
    expect(colour(1449)).toBe(1);
  });

  it('hops 2 pixels on even sub-ticks, counted from the step start', () => {
    expect(p.frameAt(0)?.dy).toBe(-2);
    expect(p.frameAt(124)?.dy).toBe(-2);
    expect(p.frameAt(125)?.dy).toBe(0);
    expect(p.frameAt(250)?.dy).toBe(-2);
    expect(p.frameAt(299)?.dy).toBe(-2);
    expect(p.frameAt(0)?.dx).toBe(0);
  });

  it('shakes +1 then -1, restarting its sub-tick count at its own step', () => {
    expect(p.frameAt(300)?.dx).toBe(1);
    expect(p.frameAt(424)?.dx).toBe(1);
    expect(p.frameAt(425)?.dx).toBe(-1);
    expect(p.frameAt(550)?.dx).toBe(1);
    expect(p.frameAt(300)?.dy).toBe(0);
  });

  it('flips for the whole step and only that step', () => {
    expect(p.frameAt(799)?.flipX).toBe(false);
    expect(p.frameAt(800)?.flipX).toBe(true);
    expect(p.frameAt(1049)?.flipX).toBe(true);
    expect(p.frameAt(1050)?.flipX).toBe(false);
  });

  it('blinks: visible on even sub-ticks, hidden on odd', () => {
    expect(p.frameAt(1050)?.visible).toBe(true);
    expect(p.frameAt(1174)?.visible).toBe(true);
    expect(p.frameAt(1175)?.visible).toBe(false);
    expect(p.frameAt(1300)?.visible).toBe(true);
    expect(p.frameAt(1425)?.visible).toBe(false);
    expect(p.frameAt(0)?.visible).toBe(true);
  });

  it('shows a particle during its step only, rising a cell row every 250 ms', () => {
    expect(p.frameAt(299)?.particles).toEqual([]);
    const at = (t: number) => p.frameAt(t)?.particles[0];
    expect(at(300)).toMatchObject({ kind: 'heart', x: 12, y: -1 });
    expect(at(549)).toMatchObject({ x: 12, y: -1 });
    expect(at(550)).toMatchObject({ x: 12, y: -3 });
    expect(at(799)).toMatchObject({ x: 12, y: -3 });
    expect(p.frameAt(800)?.particles).toEqual([]);
    expect(at(1050)).toMatchObject({ kind: 'spark', y: -1 });
    expect(at(1300)).toMatchObject({ kind: 'spark', y: -3 });
    expect(at(300)?.px).toEqual(particleSprite('heart'));
  });

  it('never re-pairs half-block rows: every vertical offset is even', () => {
    for (let t = 0; t < p.durationMs; t += 5) {
      const f = p.frameAt(t);
      expect(Math.abs(f?.dy ?? 0) % 2).toBe(0);
      for (const q of f?.particles ?? []) expect(Math.abs(q.y + 1) % 2).toBe(0);
    }
  });
});

describe('playEmote on a head', () => {
  it('draws head frames, falls back to the head idle, and anchors particles to 8 pixels', () => {
    const p = playEmote(EMOTE, 'head', 'full');
    expect(p.frameAt(0)?.px).toHaveLength(8);
    expect(p.frameAt(0)?.px[0]?.[0]).toBe(5);
    // The head has no celebrate frame.
    expect(p.frameAt(800)?.px[0]?.[0]).toBe(4);
    expect(p.frameAt(300)?.particles[0]).toMatchObject({ x: 4, y: -1 });
  });
});

describe('reduced motion', () => {
  it("shows the final step's frame and particle, still, for every t in range", () => {
    const p = playEmote(EMOTE, 'body', 'reduced');
    expect(p.durationMs).toBe(1450);
    for (const t of [0, 125, 299, 300, 1049, 1449]) {
      const f = p.frameAt(t);
      expect(f).toMatchObject({ dx: 0, dy: 0, flipX: false, visible: true });
      expect(f?.px[0]?.[0]).toBe(1);
      expect(f?.particles).toHaveLength(1);
      expect(f?.particles[0]).toMatchObject({ kind: 'spark', x: 12, y: -1 });
    }
    expect(p.frameAt(1450)).toBeNull();
    expect(p.frameAt(-1)).toBeNull();
  });

  it('shows no particle when the final step has none', () => {
    const f = playEmote({ ...EMOTE, steps: EMOTE.steps.slice(0, 3) }, 'body', 'reduced').frameAt(0);
    expect(f?.particles).toEqual([]);
    expect(f?.px[0]?.[0]).toBe(3);
  });
});

describe('particle sprites', () => {
  it('are at most 5×5 pixels, in the colours I3 fixes', () => {
    const colours = { heart: 13, spark: 8, zzz: 3, question: 3, exclaim: 9 } as const;
    for (const [kind, c] of Object.entries(colours)) {
      const px = particleSprite(kind as keyof typeof colours);
      expect(px.length).toBeLessThanOrEqual(5);
      for (const row of px) expect(row.length).toBeLessThanOrEqual(5);
      const used = new Set(px.flat().filter((v) => v !== null));
      expect([...used]).toEqual([c]);
    }
  });
});

describe('playing a real freeze', () => {
  it('replays a built-in exactly as frozen from a pack', () => {
    const pack = {
      format: 1 as const,
      accent: '4',
      body: { idle: Array.from({ length: 16 }, () => row16('4')) },
      head: { idle: Array.from({ length: 8 }, () => '4'.repeat(8)) },
    };
    const frozen = freezeEmote(pack, 'celebrate');
    expect(frozen).not.toBeNull();
    if (frozen === null) return;
    const p = playEmote(frozen.emote, 'body', 'full');
    expect(p.durationMs).toBe(1000);
    expect(p.frameAt(0)).toMatchObject({ dy: -2 });
    expect(p.frameAt(0)?.particles[0]?.kind).toBe('spark');
    expect(p.frameAt(750)?.particles).toEqual([]);
  });
});
