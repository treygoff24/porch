import type { KeyEvent } from '@opentui/core';
import { afterEach, expect, test, vi } from 'vitest';
import { Grid } from '../src/grid/grid.ts';
import type { HostApi } from '../src/host/grid-host.ts';
import { probeScene } from './scene.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// This scene owns the new blink lifecycle; the host's existing tests cannot catch a
// scene timeout waking it after focus loss or expiry. No production seam is added.
test('blink timers stop on focus loss and after the real input window', () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  let focused = true;
  const frames = vi.fn();
  const host: HostApi = {
    now: () => Date.now(),
    focused: () => focused,
    requestFrame: frames,
    animate: () => {
      throw new Error('idle blink must not start the frame clock');
    },
    quit: vi.fn(),
  };
  const probe = probeScene();
  probe.scene.draw(new Grid(100, 44, probe.scene.ground), host);
  probe.scene.key?.({ name: 'a', sequence: 'a', ctrl: false, meta: false } as KeyEvent, host);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(6000);
  expect(frames).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(125);
  expect(frames).toHaveBeenCalledTimes(2);
  focused = false;
  probe.scene.focus?.(false, host);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(30000);
  expect(frames).toHaveBeenCalledTimes(2);
  focused = true;
  probe.scene.focus?.(true, host);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(120000);
  expect(vi.getTimerCount()).toBe(0);
  const atRest = frames.mock.calls.length;
  vi.advanceTimersByTime(30000);
  expect(frames).toHaveBeenCalledTimes(atRest);
  probe.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
