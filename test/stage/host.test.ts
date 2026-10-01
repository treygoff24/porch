/**
 * The idle-frame rule with the stage mounted (plan T7 close condition): the stage inside a real
 * GridHost in OpenTUI's test renderer draws zero frames while nothing happens, an emote's burst
 * paints at most 8 frames a second and stops, timer included, and the attract screen is one bounded
 * burst and then a still frame.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createStage, type PorchStage } from '../../src/app/stage/stage.ts';
import type { AppActions, AppState } from '../../src/app/state.ts';
import { GridHost, type HostApi, type Scene } from '../../src/host/grid-host.ts';
import { emote, GROUND, IdleSteps, Rig } from './rig.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const open: TestRendererSetup[] = [];
const stages: PorchStage[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.renderer.destroy();
  for (const s of stages.splice(0)) s.dispose();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(seen: boolean): string {
  const d = mkdtempSync(join(tmpdir(), 'porch-stage-host-'));
  dirs.push(d);
  if (seen) writeFileSync(join(d, 'attract-seen'), 'test\n');
  return d;
}

/** The rig's app, drawn by a real host: its actions are the host's, its time the host's clock. */
async function mount(stage: PorchStage, rig: Rig, cols = 100, rows = 32) {
  let api: HostApi | undefined;
  const state = (): AppState => {
    if (api === undefined) throw new Error('the host has not drawn yet');
    const host = api;
    const actions: AppActions = {
      ...rig.actions,
      animate: (ms) => host.animate(ms),
      requestFrame: () => host.requestFrame(),
    };
    return rig.state(cols, rows, { now: host.now(), actions });
  };
  const scene: Scene = {
    ground: GROUND,
    draw(g, h) {
      api = h;
      rig.draw(stage, cols, rows, { state: state(), grid: g });
    },
    key(k, h) {
      api = h;
      return stage.key({ name: k.name, ctrl: k.ctrl, alt: k.meta, shift: k.shift }, state()) ===
        'handled'
        ? undefined
        : false;
    },
  };
  const t = await createTestRenderer({ width: cols, height: rows });
  open.push(t);
  let frames = 0;
  const at: number[] = [];
  t.renderer.on('frame', () => {
    frames += 1;
    at.push(Date.now());
  });
  const host = new GridHost(t.renderer, { scene, noColor: false });
  t.renderer.root.add(host);
  host.requestFrame();
  await sleep(150);
  return { t, host, frames: () => frames, at, state };
}

describe('the stage in a real host', () => {
  it('draws zero frames while idle, a capped burst for an emote, and zero again after', async () => {
    const rig = new Rig();
    rig.join('bolt');
    rig.join('wisp');
    const stage = createStage({ stateDir: () => tempDir(true), timers: new IdleSteps() });
    stages.push(stage);
    const m = await mount(stage, rig);
    expect(m.t.captureCharFrame()).toContain('Bolt');
    const idle = m.frames();
    await sleep(700);
    expect(m.frames() - idle).toBe(0);
    expect(m.host.animation).toMatchObject({ running: false, active: 0 });

    const start = Date.now();
    stage.event(
      { kind: 'arrival', channel: 'commons', records: [emote('bolt', 'wave')] },
      m.state(),
    );
    expect(m.host.animation.running).toBe(true);
    // wave is 1000 ms; the clock ends a tick after the burst.
    await sleep(1600);
    expect(m.host.animation).toMatchObject({ running: false, active: 0 });
    const burst = m.at.filter((t) => t >= start);
    expect(burst.length).toBeGreaterThan(1);
    for (const t0 of burst)
      expect(burst.filter((t) => t >= t0 && t < t0 + 1000).length).toBeLessThanOrEqual(8);
    const settled = m.frames();
    await sleep(700);
    expect(m.frames() - settled).toBe(0);
  });

  it('shows the attract screen on first launch as one burst, then a still frame', async () => {
    const rig = new Rig();
    rig.join('bolt');
    const dir = tempDir(false);
    const stage = createStage({ stateDir: () => dir, timers: new IdleSteps() });
    stages.push(stage);
    const m = await mount(stage, rig);
    expect(stage.attracting).toBe(true);
    expect(m.host.animation.running).toBe(true);
    await sleep(2600);
    expect(m.host.animation).toMatchObject({ running: false, active: 0 });
    // Sixteen sub-ticks at most, plus the first frame and the restoring one.
    expect(m.frames()).toBeLessThanOrEqual(18);
    expect(m.t.captureCharFrame()).toContain('PRESS ANY KEY');
    const still = m.frames();
    await sleep(700);
    expect(m.frames() - still).toBe(0);
    expect(stage.attracting).toBe(true);
    m.t.mockInput.pressKey('x');
    await sleep(150);
    expect(stage.attracting).toBe(false);
    expect(m.t.captureCharFrame()).not.toContain('PRESS ANY KEY');
  });
});
