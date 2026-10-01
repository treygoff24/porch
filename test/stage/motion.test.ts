/**
 * Stage motion on a hand-stepped animation clock (plan T7, ruling 4): emote playback from the
 * frozen payload, the generic bubble, replay on pick, the READY! hop from a fake seen stream, and
 * the power-up. Every frame is drawn at the clock's sample time and read back from the grid.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyImpersonationCap,
  framePixels,
  mirrorX,
  playEmote,
  resolveAccent,
  SPRITE_PALETTE,
  toHalfBlocks,
} from '@estate/pixel';
import type { DisplayRecord } from '@estate/post-kit';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createStage,
  HOP_MS,
  HOP_STAGGER_MS,
  memberBox,
  type PorchStage,
  READ_MARK,
  READY,
  STAGE_HEIGHT,
} from '../../src/app/stage/stage.ts';
import { Grid, type Rect } from '../../src/grid/grid.ts';
import {
  CREW,
  emote,
  example,
  GROUND,
  IdleSteps,
  lines,
  message,
  OWNER,
  Rig,
  region,
} from './rig.ts';

const seenDir = mkdtempSync(join(tmpdir(), 'porch-stage-seen-'));
writeFileSync(join(seenDir, 'attract-seen'), 'test\n');
afterAll(() => rmSync(seenDir, { recursive: true, force: true }));

/** A stage whose first-launch screen has already been seen, so it stays out of the way. */
const newStage = (): PorchStage =>
  createStage({ stateDir: () => seenDir, timers: new IdleSteps() });

const STRIP = (cols: number): Rect => ({ x: 0, y: 1, w: cols, h: STAGE_HEIGHT.bodies });

/** A grid holding only one sprite frame at (x, y), clipped to `clip` the way the strip clips. */
function spriteGrid(
  px: (number | null)[][],
  who: { isOwner: boolean; accent: number },
  x: number,
  y: number,
  cols: number,
  rows: number,
  target: 'body' | 'head',
  clip: Rect,
): Grid {
  const ref = new Grid(cols, rows, GROUND);
  ref.withClip(clip, () =>
    ref.blit(
      x,
      y,
      toHalfBlocks(applyImpersonationCap(px, target, who, who.accent), SPRITE_PALETTE),
    ),
  );
  return ref;
}

/** The cells a sprite frame should occupy at (x, y), read back over the rows y..y+h. */
function expectedSprite(
  px: (number | null)[][],
  who: { isOwner: boolean; accent: number },
  x: number,
  y: number,
  cols: number,
  rows: number,
  target: 'body' | 'head' = 'body',
  clip: Rect = { x: 0, y: 0, w: cols, h: rows },
): string[] {
  const ref = spriteGrid(px, who, x, y, cols, rows, target, clip);
  return region(ref, x, y, target === 'body' ? 16 : 8, target === 'body' ? 8 : 4);
}

function arrive(rig: Rig, stage: PorchStage, records: DisplayRecord[], cols = 100, rows = 32) {
  stage.event({ kind: 'arrival', channel: 'commons', records }, rig.state(cols, rows));
}

describe('emote playback', () => {
  it('plays an arriving emote from its frozen frames, sub-tick by sub-tick, then rests and stops', () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    rig.draw(stage, 100, 32); // first sighting: the (empty) window is history
    const e = emote('bolt', 'beep-boop');
    // Bolt changes avatar after sending: the frozen payload, not the current pack, plays.
    rig.avatars.set(CREW.bolt.id, example('wisp'));
    arrive(rig, stage, [e]);
    expect(rig.clock.running).toBe(true);

    const frozen = e.raw.emote?.emote;
    if (frozen == null) throw new Error('fixture is not playable');
    const player = playEmote(frozen, 'body', 'full');
    const who = {
      isOwner: false,
      accent: resolveAccent(example('bolt'), { isOwner: false }, CREW.bolt.id),
    };
    const box = memberBox(STRIP(100), 'bodies', 2, 1);
    let start: number | undefined;
    let sampled = 0;
    let t: number | undefined;
    for (;;) {
      t = rig.tick();
      if (t === undefined) break;
      start ??= t;
      const g = rig.draw(stage, 100, 32);
      const f = player.frameAt(t - start);
      if (f === null) {
        // Rest: Bolt's current avatar now, at its resting spot.
        const restWho = {
          isOwner: false,
          accent: resolveAccent(example('wisp'), { isOwner: false }, CREW.bolt.id),
        };
        expect(region(g, box.spriteX, box.spriteY, 16, 8)).toEqual(
          expectedSprite(
            framePixels(example('wisp').body.idle),
            restWho,
            box.spriteX,
            box.spriteY,
            100,
            32,
          ),
        );
        expect(lines(g)[box.taskY ?? 0]).not.toContain('✦');
        continue;
      }
      sampled += 1;
      expect(start % 125).toBe(0);
      const px = f.flipX ? mirrorX(f.px) : f.px;
      const x = box.spriteX + f.dx;
      const y = box.spriteY + f.dy / 2;
      // Compared over the sprite's resting rows, clipped at the strip's top as the strip clips.
      // A particle overlays the sprite's top-right; test/stage/particles.test.ts covers those frames.
      if (f.visible && f.particles.length === 0)
        expect(region(g, x, box.spriteY, 16, 8)).toEqual(
          region(spriteGrid(px, who, x, y, 100, 32, 'body', STRIP(100)), x, box.spriteY, 16, 8),
        );
      expect(lines(g)[box.taskY ?? 0]).toContain('✦ beep-boop');
    }
    expect(sampled).toBe(Math.ceil(player.durationMs / 125));
    expect(rig.clock.running).toBe(false);
    expect(rig.clock.active).toBe(0);
  });

  it('treats the window it first sees as history, and plays only what arrives after', () => {
    const rig = new Rig();
    rig.join('bolt');
    const old = emote('bolt', 'wave');
    rig.load('commons', [old]);
    const stage = newStage();
    rig.draw(stage, 100, 32);
    arrive(rig, stage, [old]);
    expect(rig.clock.running).toBe(false);
    // A first arrival for a channel never drawn is history too (the initial load).
    rig.join('wisp', 'other');
    stage.event(
      { kind: 'arrival', channel: 'other', records: [emote('wisp', 'wave', { channel: 'other' })] },
      rig.state(),
    );
    expect(rig.clock.running).toBe(false);
    arrive(rig, stage, [old, emote('bolt', 'hop')]);
    expect(rig.clock.running).toBe(true);
  });

  it('queues a second emote from the same sender behind the first instead of cutting it off', () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    rig.draw(stage, 100, 32);
    arrive(rig, stage, [emote('bolt', 'wave'), emote('bolt', 'hop')]);
    const box = memberBox(STRIP(100), 'bodies', 2, 1);
    const labels: string[] = [];
    while (rig.tick() !== undefined) {
      const task = lines(rig.draw(stage, 100, 32))[box.taskY ?? 0] ?? '';
      const label = task.slice(box.x, box.x + box.slotW).trim();
      if (labels.at(-1) !== label) labels.push(label);
    }
    expect(labels).toEqual(['✦ wave', '✦ hop', '—']);
  });

  it('shows the generic bubble for a record whose payload does not play', () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    rig.draw(stage, 100, 32);
    const bad = emote('bolt', 'wave', {
      payload: {
        name: 'wave',
        source: 'builtin',
        library: 'builtin-1',
        steps: [],
        frames: { body: {}, head: {} },
      },
    });
    expect(bad.raw.emote?.verdict).toBe('bubble');
    arrive(rig, stage, [bad]);
    const box = memberBox(STRIP(100), 'bodies', 2, 1);
    rig.tick();
    const g = rig.draw(stage, 100, 32);
    expect(lines(g)[box.taskY ?? 0]).toContain('✦ wave');
    // The sprite stays at rest under a bubble.
    const who = {
      isOwner: false,
      accent: resolveAccent(example('bolt'), { isOwner: false }, CREW.bolt.id),
    };
    expect(region(g, box.spriteX, box.spriteY, 16, 8)).toEqual(
      expectedSprite(
        framePixels(example('bolt').body.idle),
        who,
        box.spriteX,
        box.spriteY,
        100,
        32,
      ),
    );
    while (rig.tick() !== undefined) rig.draw(stage, 100, 32);
    expect(lines(rig.draw(stage, 100, 32))[box.taskY ?? 0]).not.toContain('✦');
    // A name that fails the grammar reads "emoted".
    const nameless = emote('bolt', 'wave', {
      payload: {
        name: 'Bad Name',
        source: 'builtin',
        library: 'builtin-1',
        steps: [{ pose: 'idle', ms: 250 }],
        frames: { body: {}, head: {} },
      },
    });
    arrive(rig, stage, [nameless]);
    rig.tick();
    expect(lines(rig.draw(stage, 100, 32))[box.taskY ?? 0]).toContain('✦ emoted');
  });

  it('plays the head frames when the strip is collapsed to heads', () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    rig.draw(stage, 40, 52, { fit: 'heads' });
    const e = emote('bolt', 'beep-boop');
    arrive(rig, stage, [e], 40, 52);
    const frozen = e.raw.emote?.emote;
    if (frozen == null) throw new Error('fixture');
    const player = playEmote(frozen, 'head', 'full');
    const who = {
      isOwner: false,
      accent: resolveAccent(example('bolt'), { isOwner: false }, CREW.bolt.id),
    };
    const box = memberBox({ x: 0, y: 1, w: 40, h: 6 }, 'heads', 2, 1);
    let start: number | undefined;
    let checked = 0;
    for (let t = rig.tick(); t !== undefined; t = rig.tick()) {
      start ??= t;
      const g = rig.draw(stage, 40, 52, { fit: 'heads' });
      const f = player.frameAt(t - start);
      // A particle overlays the sprite's top-right; test/stage/particles.test.ts covers those frames.
      if (f === null || !f.visible || f.particles.length > 0) continue;
      const px = f.flipX ? mirrorX(f.px) : f.px;
      const x = box.spriteX + f.dx;
      const y = box.spriteY + f.dy / 2;
      if (y < 1) continue; // lifted into the strip's one row of headroom and beyond: clipped
      expect(region(g, x, y, 8, 4)).toEqual(expectedSprite(px, who, x, y, 40, 52, 'head'));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('replays an emote when Trey picks its record, once per pick', () => {
    const rig = new Rig();
    rig.join('bolt');
    const old = emote('bolt', 'wave');
    rig.load('commons', [message('bolt', 'on it'), old]);
    const stage = newStage();
    rig.draw(stage, 100, 32);
    expect(rig.clock.running).toBe(false);
    rig.panes = [{ channel: 'commons', scroll: 0, pick: old.raw.id }];
    rig.draw(stage, 100, 32);
    expect(rig.clock.running).toBe(true);
    while (rig.tick() !== undefined) rig.draw(stage, 100, 32);
    rig.draw(stage, 100, 32); // the same pick again: no replay
    expect(rig.clock.running).toBe(false);
    // Picking a plain message plays nothing.
    rig.panes = [
      { channel: 'commons', scroll: 0, pick: rig.views.get('commons')?.records[0]?.raw.id },
    ];
    rig.draw(stage, 100, 32);
    expect(rig.clock.running).toBe(false);
  });

  it('reduced motion holds the final frame still for the emote, then rests; off plays nothing', () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.motion = 'reduced';
    const stage = newStage();
    rig.draw(stage, 100, 32);
    const e = emote('bolt', 'beep-boop');
    arrive(rig, stage, [e]);
    const box = memberBox(STRIP(100), 'bodies', 2, 1);
    const frames = new Set<string>();
    while (rig.tick() !== undefined)
      frames.add(region(rig.draw(stage, 100, 32), box.spriteX - 2, 1, 22, 11).join('\n'));
    // One still frame while it shows, and the resting frame after.
    expect(frames.size).toBe(2);

    const off = new Rig();
    off.join('bolt');
    off.motion = 'off';
    const stage2 = newStage();
    off.draw(stage2, 100, 32);
    stage2.event(
      { kind: 'arrival', channel: 'commons', records: [emote('bolt', 'wave')] },
      off.state(),
    );
    expect(off.clock.running).toBe(false);
  });

  it('plays nothing for a channel no pane shows', () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.join('bolt', 'elsewhere');
    const stage = newStage();
    rig.draw(stage, 100, 32);
    stage.event({ kind: 'arrival', channel: 'elsewhere', records: [] }, rig.state());
    stage.event(
      {
        kind: 'arrival',
        channel: 'elsewhere',
        records: [emote('bolt', 'wave', { channel: 'elsewhere' })],
      },
      rig.state(),
    );
    expect(rig.clock.running).toBe(false);
  });

  it('any key skips every flourish to its end state and passes the key on', () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    const rest = rig.draw(stage, 100, 32).toText();
    arrive(rig, stage, [emote('bolt', 'beep-boop')]);
    rig.tick();
    expect(rig.draw(stage, 100, 32).toText()).not.toBe(rest);
    const before = rig.frames;
    expect(
      stage.key({ name: 'a', ctrl: false, alt: false, shift: false, text: 'a' }, rig.state()),
    ).toBe('pass');
    expect(rig.frames).toBe(before + 1);
    expect(rig.draw(stage, 100, 32).toText()).toBe(rest);
    // The clock samples the restoring state once more and stops.
    while (rig.tick() !== undefined) expect(rig.draw(stage, 100, 32).toText()).toBe(rest);
    expect(rig.clock.running).toBe(false);
    // With nothing moving, a key changes nothing and asks for no frame.
    const quiet = rig.frames;
    expect(
      stage.key({ name: 'b', ctrl: false, alt: false, shift: false, text: 'b' }, rig.state()),
    ).toBe('pass');
    expect(rig.frames).toBe(quiet);
  });
});

describe('READY! hop from the seen stream', () => {
  function crewed() {
    const rig = new Rig();
    rig.join('bolt');
    rig.join('wisp');
    rig.join('mochi');
    const stage = newStage();
    rig.draw(stage, 100, 32);
    const sent = message('trey', 'ship it');
    rig.load('commons', [sent]);
    stage.event({ kind: 'sent', channel: 'commons', id: sent.raw.id, mode: 'casual' }, rig.state());
    return { rig, stage, id: sent.raw.id };
  }
  const box = (i: number) => memberBox(STRIP(100), 'bodies', 4, i);

  it('hops each newly seen participant once, one after another, then marks them read', () => {
    const { rig, stage, id } = crewed();
    expect(rig.clock.running).toBe(false); // a casual send has no power-up
    for (const p of [CREW.bolt.id, CREW.wisp.id])
      stage.event({ kind: 'seen', channel: 'commons', id, participant: p }, rig.state());
    // Seen again: nothing new.
    stage.event({ kind: 'seen', channel: 'commons', id, participant: CREW.bolt.id }, rig.state());
    // Lifted: the strip shows the resting sprite one row up, its top row clipped at the edge.
    const liftedRows = (name: 'bolt' | 'wisp' | 'mochi', b: ReturnType<typeof box>) => {
      const who = {
        isOwner: false,
        accent: resolveAccent(example(name), { isOwner: false }, CREW[name].id),
      };
      const px = framePixels(example(name).body.idle);
      return region(
        spriteGrid(px, who, b.spriteX, b.spriteY - 1, 100, 32, 'body', STRIP(100)),
        b.spriteX,
        b.spriteY,
        16,
        8,
      );
    };
    const lifted: Record<string, number[]> = { bolt: [], wisp: [], mochi: [] };
    const ready: Record<string, number[]> = { bolt: [], wisp: [], mochi: [] };
    for (let t = rig.tick(); t !== undefined; t = rig.tick()) {
      const g = rig.draw(stage, 100, 32);
      const rows = lines(g);
      (['bolt', 'wisp', 'mochi'] as const).forEach((name, j) => {
        const b = box(j + 1);
        const shown = region(g, b.spriteX, b.spriteY, 16, 8);
        if (JSON.stringify(shown) === JSON.stringify(liftedRows(name, b))) lifted[name]?.push(t);
        if ((rows[b.taskY ?? 0] ?? '').slice(b.x, b.x + b.slotW).includes(READY))
          ready[name]?.push(t);
      });
    }
    expect(lifted.mochi).toEqual([]);
    expect(ready.mochi).toEqual([]);
    const boltStart = ready.bolt?.[0] ?? Number.NaN;
    const wispStart = ready.wisp?.[0] ?? Number.NaN;
    expect(wispStart - boltStart).toBe(HOP_STAGGER_MS);
    expect(ready.bolt).toHaveLength(HOP_MS / 125);
    expect(lifted.bolt).toEqual([boltStart, boltStart + 125]);
    expect(lifted.wisp).toEqual([wispStart, wispStart + 125]);
    expect(rig.clock.running).toBe(false);
    // End state: read marks for the two who read it, none for the one who has not.
    const rows = lines(rig.draw(stage, 100, 32));
    const tag = (j: number) => (rows[box(j).nameY] ?? '').slice(box(j).x, box(j).x + box(j).slotW);
    expect(tag(1)).toContain(`Bolt ${READ_MARK}`);
    expect(tag(2)).toContain(`Wisp ${READ_MARK}`);
    expect(tag(3)).not.toContain(READ_MARK);
    expect(tag(0)).not.toContain(READ_MARK); // Trey never marks himself
  });

  it("ignores a seen report for an older send, and Trey's own participant", () => {
    const { rig, stage, id } = crewed();
    stage.event(
      { kind: 'seen', channel: 'commons', id: `${id}-old`, participant: CREW.bolt.id },
      rig.state(),
    );
    stage.event(
      { kind: 'seen', channel: 'commons', id, participant: OWNER.participant },
      rig.state(),
    );
    expect(rig.clock.running).toBe(false);
    expect(lines(rig.draw(stage, 100, 32)).join('\n')).not.toContain(READ_MARK);
  });

  it('a newer send clears the marks and starts over', () => {
    const { rig, stage, id } = crewed();
    stage.event({ kind: 'seen', channel: 'commons', id, participant: CREW.bolt.id }, rig.state());
    while (rig.tick() !== undefined) rig.draw(stage, 100, 32);
    expect(lines(rig.draw(stage, 100, 32)).join('\n')).toContain(READ_MARK);
    stage.event({ kind: 'sent', channel: 'commons', id: `${id}z`, mode: 'casual' }, rig.state());
    expect(lines(rig.draw(stage, 100, 32)).join('\n')).not.toContain(READ_MARK);
  });

  it('off motion marks readers at once, with no READY! and nothing animating', () => {
    const { rig, stage, id } = crewed();
    rig.motion = 'off';
    const frames = rig.frames;
    stage.event({ kind: 'seen', channel: 'commons', id, participant: CREW.bolt.id }, rig.state());
    expect(rig.clock.running).toBe(false);
    expect(rig.frames).toBe(frames + 1);
    const text = lines(rig.draw(stage, 100, 32)).join('\n');
    expect(text).toContain(`Bolt ${READ_MARK}`);
    expect(text).not.toContain(READY);
  });

  it('reduced motion shows READY! for the hop’s whole span without lifting the sprite, then the mark', () => {
    const { rig, stage, id } = crewed();
    rig.motion = 'reduced';
    const b = memberBox(STRIP(100), 'bodies', 4, 1);
    const who = {
      isOwner: false,
      accent: resolveAccent(example('bolt'), { isOwner: false }, CREW.bolt.id),
    };
    const px = framePixels(example('bolt').body.idle);
    const resting = region(
      spriteGrid(px, who, b.spriteX, b.spriteY, 100, 32, 'body', STRIP(100)),
      b.spriteX,
      b.spriteY,
      16,
      8,
    );
    stage.event({ kind: 'seen', channel: 'commons', id, participant: CREW.bolt.id }, rig.state());
    const ready: number[] = [];
    let lifted = 0;
    const readyNow = (g: Grid) =>
      (lines(g)[b.taskY ?? 0] ?? '').slice(b.x, b.x + b.slotW).includes(READY);
    for (let t = rig.tick(); t !== undefined; t = rig.tick()) {
      const g = rig.draw(stage, 100, 32);
      if (readyNow(g)) ready.push(t);
      if (JSON.stringify(region(g, b.spriteX, b.spriteY, 16, 8)) !== JSON.stringify(resting))
        lifted += 1;
    }
    // The same span as the full-motion hop above.
    expect(ready).toHaveLength(HOP_MS / 125);
    expect(lifted).toBe(0);
    expect(rig.clock.running).toBe(false);
    const rows = lines(rig.draw(stage, 100, 32));
    expect(rows[b.nameY]).toContain(`Bolt ${READ_MARK}`);
    expect(rows.join('\n')).not.toContain(READY);
  });
});

describe('the power-up', () => {
  it('a signed send flashes once and holds a gold SIGNED! plate over the stage, then clears', () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    const rest = rig.draw(stage, 100, 32).toText();
    stage.event({ kind: 'sent', channel: 'commons', id: 'x1', mode: 'signed' }, rig.state());
    const colours: string[] = [];
    for (let t = rig.tick(); t !== undefined; t = rig.tick()) {
      const g = rig.draw(stage, 100, 32);
      let frame: string | undefined;
      g.forEachCell((c) => {
        if (frame === undefined && c.ch === '╔') frame = c.fg;
      });
      colours.push(frame ?? 'none');
    }
    expect(colours).toEqual([
      '#fff6d8',
      '#fff6d8',
      '#ffc400',
      '#ffc400',
      '#ffc400',
      '#ffc400',
      '#ffc400',
      'none',
    ]);
    expect(rig.draw(stage, 100, 32).toText()).toBe(rest);
    expect(rig.clock.running).toBe(false);
  });

  it('casual sends and motion off show no plate; reduced shows it without the flash', () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    rig.draw(stage, 100, 32);
    stage.event({ kind: 'sent', channel: 'commons', id: 'x1', mode: 'casual' }, rig.state());
    expect(rig.clock.running).toBe(false);
    rig.motion = 'off';
    stage.event({ kind: 'sent', channel: 'commons', id: 'x2', mode: 'signed' }, rig.state());
    expect(rig.clock.running).toBe(false);
    rig.motion = 'reduced';
    stage.event({ kind: 'sent', channel: 'commons', id: 'x3', mode: 'signed' }, rig.state());
    const colours = new Set<string>();
    while (rig.tick() !== undefined)
      rig.draw(stage, 100, 32).forEachCell((c) => {
        if (c.ch === '╔') colours.add(c.fg);
      });
    expect([...colours]).toEqual(['#ffc400']);
  });
});

describe('only verified owner attribution moves Trey', () => {
  const trey = memberBox(STRIP(100), 'bodies', 2, 0);
  const label = (rig: Rig, stage: PorchStage) => {
    rig.tick();
    const row = lines(rig.draw(stage, 100, 32))[trey.taskY ?? 0] ?? '';
    return row.slice(trey.x, trey.x + trey.slotW);
  };
  const spoofs = () =>
    [
      [
        'a failed claim from his room',
        emote('trey', 'wave', { verdict: { state: 'failed', reason: 't' } }),
      ],
      [
        'an unchecked claim from his room',
        emote('trey', 'wave', { verdict: { state: 'unknown', reason: 't' } }),
      ],
      [
        'another room naming his participant id',
        emote('bolt', 'wave', { as: { room: 'bolt', id: OWNER.participant } }),
      ],
      [
        'his room naming an agent, unverified',
        emote('bolt', 'wave', {
          as: { room: OWNER.room, id: CREW.bolt.id },
          verdict: { state: 'failed', reason: 't' },
        }),
      ],
    ] as const;

  for (const [what, record] of spoofs())
    it(`${what} plays on nobody, on arrival or when picked`, () => {
      const rig = new Rig();
      rig.join('bolt');
      const stage = newStage();
      rig.draw(stage, 100, 32);
      arrive(rig, stage, [record]);
      expect(rig.clock.running).toBe(false);
      rig.load('commons', [record]);
      rig.panes = [{ channel: 'commons', scroll: 0, pick: record.raw.id }];
      rig.draw(stage, 100, 32);
      expect(rig.clock.running).toBe(false);
      expect(lines(rig.draw(stage, 100, 32)).join('\n')).not.toContain('✦');
    });

  it("Trey's own casual emote from his room does play on his avatar (the control)", () => {
    const rig = new Rig();
    rig.join('bolt');
    const stage = newStage();
    rig.draw(stage, 100, 32);
    arrive(rig, stage, [emote('trey', 'wave')]);
    expect(rig.clock.running).toBe(true);
    expect(label(rig, stage)).toContain('✦ wave');
  });
});
