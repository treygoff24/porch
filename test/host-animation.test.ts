/** Regression owner: production host render requests, using the actual authored probe emote.
 * Old coverage expected every timer tick to paint, including identical consecutive frames. */
import { createTestRenderer } from '@opentui/core/testing';
import { expect, it, vi } from 'vitest';
import { probeScene } from '../probes/scene.ts';
import type { Timers } from '../src/host/animation-clock.ts';
import { GridHost } from '../src/host/grid-host.ts';

it('skips repeated emote frames, aligns start/restoration, and leaves typing immediate', async () => {
  let now = 17;
  let timer: { fn: () => void; at: number } | undefined;
  const timers: Timers = {
    now: () => now,
    setInterval: (fn, ms) => {
      timer = { fn, at: now + ms };
      return timer;
    },
    clearInterval: () => {
      timer = undefined;
    },
  };
  const t = await createTestRenderer({ width: 100, height: 44 });
  const probe = probeScene({ blinks: false });
  const host = new GridHost(t.renderer, { scene: probe.scene, timers });
  const passes: number[] = [];
  const request = vi.spyOn(host, 'requestRender').mockImplementation(() => passes.push(now));
  try {
    t.renderer.root.add(host);
    await t.renderOnce();
    passes.length = 0;
    const resting = t.captureCharFrame();
    t.mockInput.pressKey('e', { ctrl: true });
    expect(passes).toEqual([]); // Start is queued for 125 ms, not rendered at input time 17 ms.
    const repeatedTicks: number[] = [];
    let displayed = resting;
    while (timer) {
      now = timer.at;
      const before = passes.length;
      timer.fn();
      if (passes.length === before) repeatedTicks.push(now);
      else {
        await t.renderOnce();
        const next = t.captureCharFrame();
        expect(next).not.toBe(displayed); // No actual render pass for identical displayed cells.
        displayed = next;
      }
    }
    expect(repeatedTicks.length).toBeGreaterThan(0);
    expect(passes[0]).toBe(125);
    expect(passes.at(-1)).toBe(1250); // 1125 ms authored duration plus aligned start.
    expect(displayed).toBe(resting);
    expect(passes.every((at) => at % 125 === 0)).toBe(true);
    const max = Math.max(
      ...passes.map((at) => passes.filter((t0) => t0 >= at && t0 < at + 1000).length),
    );
    expect(max).toBeLessThanOrEqual(8);
    expect(host.animation).toMatchObject({ active: 0, running: false });

    // Between sub-ticks, input must still ask for an immediate render while a burst is live.
    now = 1267;
    t.mockInput.pressKey('e', { ctrl: true });
    t.mockInput.pressKey('x');
    expect(passes.at(-1)).toBe(1267);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain('ECHO: x');
  } finally {
    request.mockRestore();
    probe.dispose();
    t.renderer.destroy();
  }
});

it('skips palette changes that display identically under NO_COLOR, but draws a new glyph', async () => {
  let now = 17;
  let tick: (() => void) | undefined;
  let start: ((ms: number) => void) | undefined;
  const timers: Timers = {
    now: () => now,
    setInterval: (fn) => {
      tick = fn;
      return fn;
    },
    clearInterval: () => {
      tick = undefined;
    },
  };
  const t = await createTestRenderer({ width: 4, height: 2 });
  const host = new GridHost(t.renderer, {
    noColor: true,
    timers,
    scene: {
      ground: () => ({ ch: ' ', w: 1, fg: '#ffffff', bg: '#000000' }),
      draw(g, api) {
        start = (ms) => {
          api.animate(ms);
        };
        g.text(0, 0, api.now() < 375 ? 'A' : 'B', {
          fg: api.now() < 250 ? '#ff0000' : '#00ff00',
        });
      },
    },
  });
  const passes: number[] = [];
  const request = vi.spyOn(host, 'requestRender').mockImplementation(() => passes.push(now));
  try {
    t.renderer.root.add(host);
    await t.renderOnce();
    passes.length = 0;
    if (!start) throw new Error('scene did not mount');
    start(250);
    for (const at of [125, 250, 375]) {
      now = at;
      if (!tick) throw new Error('burst ended early');
      tick();
    }
    // Both red and green are the same light ink in monochrome. Only A -> B is visible.
    expect(passes).toEqual([375]);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain('B');
  } finally {
    request.mockRestore();
    t.renderer.destroy();
  }
});
