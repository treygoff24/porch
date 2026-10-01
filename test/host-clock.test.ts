/**
 * The animation clock alone, on hand-driven timers: every animation is a finite burst with an end
 * time, a timer exists only through its grid-aligned restoration, each tick samples the scene,
 * and the clock holds whether the terminal has focus (ruling 4).
 */
import { describe, expect, it } from 'vitest';
import { AnimationClock, type Timers } from '../src/host/animation-clock.ts';

function manual() {
  let t = 0;
  let next = 1;
  const live = new Map<number, { fn: () => void; ms: number; at: number }>();
  const timers: Timers = {
    now: () => t,
    setInterval: (fn, ms) => {
      const id = next++;
      live.set(id, { fn, ms, at: t + ms });
      return id;
    },
    clearInterval: (h) => {
      live.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...live.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      t = due.at;
      due.at += due.ms;
      due.fn();
    }
    t = end;
  };
  return { timers, advance, count: () => live.size };
}

describe('AnimationClock', () => {
  it('has no timer until a burst starts, and none once the last burst has ended', () => {
    const m = manual();
    const ticks: number[] = [];
    const clock = new AnimationClock({
      onTick: (now) => ticks.push(now),
      frameMs: 125,
      timers: m.timers,
    });
    m.advance(1000);
    expect(m.count()).toBe(0);
    expect(ticks).toEqual([]);

    const hop = clock.burst(500);
    expect(hop).toMatchObject({ start: 1125, end: 1625 });
    expect(m.count()).toBe(1);
    expect(ticks).toEqual([]);
    m.advance(400);
    expect(ticks).toEqual([1125, 1250, 1375]);
    expect(clock.running).toBe(true);

    // The tick at the end time finds the burst over: it stops the timer and asks for the frame
    // that shows the end state.
    m.advance(225);
    expect(ticks).toEqual([1125, 1250, 1375, 1500, 1625]);
    expect(m.count()).toBe(0);
    expect(clock.running).toBe(false);
    expect(clock.active).toBe(0);
    m.advance(5000);
    expect(ticks).toHaveLength(5);
    hop.cancel();
    expect(ticks).toHaveLength(5);
  });

  it('runs one timer for overlapping bursts, until the later one ends', () => {
    const m = manual();
    const clock = new AnimationClock({ onTick: () => {}, timers: m.timers });
    clock.burst(250);
    m.advance(125);
    clock.burst(1000);
    expect(m.count()).toBe(1);
    expect(clock.active).toBe(2);
    m.advance(250);
    expect(clock.active).toBe(1);
    expect(m.count()).toBe(1);
    m.advance(1000);
    expect(clock.active).toBe(0);
    expect(m.count()).toBe(0);
  });

  it('restores on the next grid tick when the last burst is cancelled, then stops', () => {
    const m = manual();
    const ticks: number[] = [];
    const clock = new AnimationClock({ onTick: (t) => ticks.push(t), timers: m.timers });
    const a = clock.burst(10_000);
    const b = clock.burst(10_000);
    a.cancel();
    expect(m.count()).toBe(1);
    b.cancel();
    expect(m.count()).toBe(1);
    expect(clock.active).toBe(0);
    expect(ticks).toEqual([]);
    m.advance(125);
    expect(m.count()).toBe(0);
    expect(ticks).toEqual([125]);
  });

  it('refuses a burst without a finite, positive length', () => {
    const m = manual();
    const clock = new AnimationClock({ onTick: () => {}, timers: m.timers });
    for (const ms of [Number.POSITIVE_INFINITY, Number.NaN, 0, -5])
      expect(() => clock.burst(ms)).toThrow(RangeError);
    expect(m.count()).toBe(0);
  });

  it('holds terminal focus, assumed until a report says otherwise, and tells listeners of changes', () => {
    const clock = new AnimationClock({ onTick: () => {}, timers: manual().timers });
    const heard: boolean[] = [];
    const stop = clock.onFocus((f) => heard.push(f));
    expect(clock.focused).toBe(true);
    clock.setFocus(true);
    clock.setFocus(false);
    clock.setFocus(false);
    expect(clock.focused).toBe(false);
    clock.setFocus(true);
    stop();
    clock.setFocus(false);
    expect(heard).toEqual([false, true]);
  });

  it('drops everything on dispose', () => {
    const m = manual();
    const clock = new AnimationClock({ onTick: () => {}, timers: m.timers });
    clock.burst(1000);
    clock.burst(2000);
    clock.dispose();
    expect(m.count()).toBe(0);
    expect(clock.active).toBe(0);
  });
});
