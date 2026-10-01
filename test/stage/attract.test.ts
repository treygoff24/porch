/**
 * The attract screen (plan T7): shown on first launch (the marker in a temporary state dir) and
 * after ten minutes without input when nothing waits on Trey; one bounded burst, then a still
 * frame; any key dismisses it and is consumed; an attention-eligible arrival dismisses it, an emote
 * does not. The high-score table is post's own message counts.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ATTRACT_HIT,
  ATTRACT_MS,
  attractSeen,
  MARKER,
  markAttractSeen,
  PRESS_ANY_KEY,
  stateDir,
} from '../../src/app/stage/attract.ts';
import { createStage, IDLE_MS } from '../../src/app/stage/stage.ts';
import { emote, IdleSteps, lines, message, OWNER, Rig, summary } from './rig.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(seen = false): string {
  const d = mkdtempSync(join(tmpdir(), 'porch-attract-'));
  dirs.push(d);
  if (seen) writeFileSync(join(d, MARKER), 'test\n');
  return d;
}
const KEY = { name: 'x', ctrl: false, alt: false, shift: false, text: 'x' };

function setup(opts: { seen?: boolean; motion?: 'full' | 'reduced' | 'off' } = {}) {
  const rig = new Rig();
  rig.join('bolt');
  rig.join('wisp');
  if (opts.motion !== undefined) rig.motion = opts.motion;
  const dir = tempDir(opts.seen ?? false);
  const idle = new IdleSteps();
  const stage = createStage({ stateDir: () => dir, timers: idle });
  return { rig, dir, idle, stage };
}

describe('first launch', () => {
  it('shows once per account: the marker is written and the next launch skips it', () => {
    const { rig, dir, stage } = setup();
    expect(attractSeen(dir)).toBe(false);
    const g = rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(true);
    expect(existsSync(join(dir, MARKER))).toBe(true);
    expect(lines(g).join('\n')).toContain('PRESS ANY KEY');
    expect(g.hitAt(50, 16)).toEqual({ id: ATTRACT_HIT });
    const again = createStage({ stateDir: () => dir, timers: new IdleSteps() });
    rig.draw(again, 100, 32);
    expect(again.attracting).toBe(false);
  });

  it('the marker lives under ~/.local/state/porch-next unless PORCH_STATE_DIR moves it', () => {
    expect(stateDir({ HOME: '/h' })).toMatch(/\.local\/state\/porch-next$/);
    expect(stateDir({ PORCH_STATE_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(stateDir({ PORCH_STATE_DIR: '' })).toMatch(/porch-next$/);
  });

  it('an unwritable state dir still shows the screen and does not throw', () => {
    const file = join(tempDir(), 'not-a-dir');
    writeFileSync(file, 'x');
    expect(markAttractSeen(join(file, 'sub'))).toBe(false);
    const rig = new Rig();
    rig.join('bolt');
    const stage = createStage({ stateDir: () => join(file, 'sub'), timers: new IdleSteps() });
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(true);
  });

  it('is one burst of title colour and crew hops, then a still frame, and the clock stops', () => {
    const { rig, stage } = setup();
    rig.draw(stage, 100, 32);
    expect(rig.clock.running).toBe(true);
    const frames: string[] = [];
    const times: number[] = [];
    for (let t = rig.tick(); t !== undefined; t = rig.tick()) {
      times.push(t);
      frames.push(rig.draw(stage, 100, 32).toText());
    }
    expect(rig.clock.running).toBe(false);
    expect(times.every((t) => t % 125 === 0)).toBe(true);
    expect((times.at(-1) ?? 0) - (times[0] ?? 0)).toBeLessThanOrEqual(ATTRACT_MS);
    // It moved: the crew hops and the prompt blinks.
    expect(new Set(frames).size).toBeGreaterThan(2);
    expect(frames.some((f) => !f.includes(PRESS_ANY_KEY))).toBe(true);
    // The still frame keeps the prompt lit.
    const still = rig.draw(stage, 100, 32).toText();
    expect(still).toContain(PRESS_ANY_KEY);
    expect(rig.draw(stage, 100, 32).toText()).toBe(still);
  });

  it('reduced and off motion show only the still frame', () => {
    for (const motion of ['reduced', 'off'] as const) {
      const { rig, stage } = setup({ motion });
      const g = rig.draw(stage, 100, 32);
      expect(stage.attracting).toBe(true);
      expect(rig.clock.running).toBe(false);
      expect(lines(g).join('\n')).toContain(PRESS_ANY_KEY);
    }
  });

  it('any key dismisses it and is consumed; a key afterwards passes', () => {
    const { rig, stage } = setup();
    rig.draw(stage, 100, 32);
    const frames = rig.frames;
    expect(stage.key(KEY, rig.state())).toBe('handled');
    expect(stage.attracting).toBe(false);
    expect(rig.frames).toBe(frames + 1);
    expect(lines(rig.draw(stage, 100, 32)).join('\n')).not.toContain(PRESS_ANY_KEY);
    expect(stage.key(KEY, rig.state())).toBe('pass');
  });
});

describe('arrivals', () => {
  it("an attention-eligible message dismisses it; an emote or Trey's own send does not", () => {
    const { rig, stage } = setup();
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(true);
    const arrive = (r: ReturnType<typeof message>) =>
      stage.event({ kind: 'arrival', channel: 'commons', records: [r] }, rig.state());
    arrive(emote('bolt', 'wave'));
    expect(stage.attracting).toBe(true);
    const mine = message('trey', 'my own send');
    rig.ownMessageIds.add(mine.raw.id);
    arrive(mine);
    expect(stage.attracting).toBe(true);
    arrive(message('bolt', 'need a decision'));
    expect(stage.attracting).toBe(false);
  });

  it('startup backlog never dismisses first launch, whatever its timestamps', () => {
    const { rig, idle, stage } = setup();
    // Post listed #ops at startup; its first arrival is its initial load.
    rig.channels.push(summary('ops', [OWNER.participant, 'p-bolt']));
    idle.t = Date.parse('2026-09-30T23:10:00.800Z');
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(true);
    const backlog = [
      message('bolt', 'from last week', {
        channel: 'ops',
        extra: { sent: '2026-09-23T10:00:00Z' },
      }),
      // Even one stamped after the screen came up: startup history is decided by the load, not
      // the clock.
      message('wisp', 'need you in ops', {
        channel: 'ops',
        extra: { sent: '2026-09-30T23:11:00Z' },
      }),
    ];
    stage.event({ kind: 'arrival', channel: 'ops', records: backlog }, rig.state());
    expect(stage.attracting).toBe(true);
  });

  it('a fresh message in a channel that appeared after startup dismisses it, even stamped the same second', () => {
    const { rig, idle, stage } = setup();
    idle.t = Date.parse('2026-09-30T23:10:00.800Z');
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(true);
    // #design was not in post's listing at startup; post stamps whole seconds, so this message
    // reads as sent before the screen (.800) though it arrived after.
    rig.channels.push(summary('design', [OWNER.participant, 'p-wisp']));
    const news = message('wisp', 'need you in design', {
      channel: 'design',
      extra: { sent: '2026-09-30T23:10:00Z' },
    });
    stage.event({ kind: 'arrival', channel: 'design', records: [news] }, rig.state());
    expect(stage.attracting).toBe(false);
  });

  it('a later arrival in a startup channel is live and dismisses it', () => {
    const { rig, idle, stage } = setup();
    rig.channels.push(summary('ops', [OWNER.participant, 'p-bolt']));
    idle.t = Date.parse('2026-09-30T23:10:00.800Z');
    rig.draw(stage, 100, 32);
    const old = message('bolt', 'history', {
      channel: 'ops',
      extra: { sent: '2026-09-23T10:00:00Z' },
    });
    stage.event({ kind: 'arrival', channel: 'ops', records: [old] }, rig.state());
    expect(stage.attracting).toBe(true);
    const next = message('bolt', 'and now this', {
      channel: 'ops',
      extra: { sent: '2026-09-30T23:10:00Z' },
    });
    stage.event({ kind: 'arrival', channel: 'ops', records: [old, next] }, rig.state());
    expect(stage.attracting).toBe(false);
  });
});

describe('first launch waits for a quiet moment', () => {
  it('not over an open draft: the marker waits too, and it shows once the draft is gone', () => {
    const { rig, dir, stage } = setup();
    rig.draft = 'half a thought';
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(false);
    expect(attractSeen(dir)).toBe(false);
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(false);
    rig.draft = '';
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(true);
    expect(attractSeen(dir)).toBe(true);
  });

  it('not while a lane needs Trey', () => {
    const { rig, dir, stage } = setup();
    const view = rig.views.get('commons');
    if (view === undefined) throw new Error('view');
    rig.views.set('commons', { ...view, needsYou: true });
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(false);
    expect(attractSeen(dir)).toBe(false);
    rig.views.set('commons', { ...view, needsYou: false });
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(true);
    expect(attractSeen(dir)).toBe(true);
    // Dismissed, it does not come back on the next draw: it has been seen.
    stage.key(KEY, rig.state());
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(false);
  });
});

describe('after ten minutes idle', () => {
  it('shows when nothing waits on Trey, and input resets the wait', () => {
    const { rig, idle, stage } = setup({ seen: true });
    rig.draw(stage, 100, 32);
    expect(stage.attracting).toBe(false);
    idle.advance(IDLE_MS - 1000);
    stage.event({ kind: 'input' }, rig.state());
    idle.advance(IDLE_MS - 1000);
    expect(stage.attracting).toBe(false);
    const frames = rig.frames;
    idle.advance(1000);
    expect(stage.attracting).toBe(true);
    expect(rig.frames).toBe(frames + 1);
    expect(rig.clock.running).toBe(true);
    // It draws nothing of its own once shown: only the clock's one burst.
    expect(idle.pending.size).toBe(0);
    stage.key(KEY, rig.state());
    expect(stage.attracting).toBe(false);
    expect(idle.pending.size).toBe(1);
  });

  it('waits while a draft is open or a lane needs Trey, and rechecks a minute later', () => {
    const { rig, idle, stage } = setup({ seen: true });
    rig.draft = 'half a thought';
    rig.draw(stage, 100, 32);
    idle.advance(IDLE_MS);
    expect(stage.attracting).toBe(false);
    rig.draft = '';
    const view = rig.views.get('commons');
    if (view === undefined) throw new Error('view');
    rig.views.set('commons', { ...view, needsYou: true });
    rig.draw(stage, 100, 32);
    idle.advance(60_000);
    expect(stage.attracting).toBe(false);
    rig.views.set('commons', { ...view, needsYou: false });
    rig.draw(stage, 100, 32);
    idle.advance(59_000);
    expect(stage.attracting).toBe(false);
    idle.advance(1000);
    expect(stage.attracting).toBe(true);
  });

  it('dispose stops the idle timer', () => {
    const { rig, idle, stage } = setup({ seen: true });
    rig.draw(stage, 100, 32);
    expect(idle.pending.size).toBe(1);
    stage.dispose();
    expect(idle.pending.size).toBe(0);
  });
});

describe('the high-score table', () => {
  it("ranks live channels by post's message count, archived and uncounted ones left out", () => {
    const { rig, stage } = setup();
    rig.channels = [
      summary('commons', ['p-bolt'], { messages: 120 }),
      summary('ops', [], { messages: 4500 }),
      summary('attic', [], { messages: 99999, archived: true }),
      summary('quiet', [], { messages: undefined }),
      summary('alpha', [], { messages: 120 }),
    ];
    const text = lines(rig.draw(stage, 100, 32)).join('\n');
    expect(text).toContain('HIGH SCORES');
    const ranked = [...text.matchAll(/(1ST|2ND|3RD|4TH) (\w+)[ ·]+(\d{5})/g)].map((m) =>
      [m[1], m[2], m[3]].join(' '),
    );
    expect(ranked).toEqual(['1ST OPS 04500', '2ND ALPHA 00120', '3RD COMMONS 00120']);
    expect(text).not.toContain('ATTIC');
    expect(text).not.toContain('QUIET');
  });

  it('fits at every capture size', () => {
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ] as const) {
      const { rig, stage } = setup();
      rig.channels = [summary('commons', ['p-bolt'], { messages: 3 })];
      const text = lines(rig.draw(stage, cols, rows)).join('\n');
      expect(text).toContain(PRESS_ANY_KEY);
      expect(text).toContain('COMMONS');
      expect(text).toContain('CREDIT 01');
    }
  });
});
