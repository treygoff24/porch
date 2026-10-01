/**
 * The grid host inside a real OpenTUI renderer (the test renderer, with the same frame scheduling
 * as the terminal one). Ruling 4 first: a mounted host that nobody asks to draw draws zero frames,
 * requests coalesce into one frame, and a finite burst on the animation clock starts frames and
 * stops them, timer and all, once it ends. Then I5's frame rule: the host keeps the previous grid
 * and writes only the cells that changed into a buffer that persists, and every cell after a
 * resize. Then input: keys, bracketed paste, hit actions, focus, and the demo's echo line.
 */
import type { KeyEvent } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { demoScene } from '../src/demo/demo-scene.ts';
import { type Grid, type HitAction, scanlines } from '../src/grid/grid.ts';
import { GridHost, type HostApi, type Scene } from '../src/host/grid-host.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Mounted = {
  t: TestRendererSetup;
  host: GridHost;
  /** Frames OpenTUI finished and sent to the terminal. */
  frames: () => number;
};

const open: TestRendererSetup[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.renderer.destroy();
});

async function mount(
  scene: Scene,
  size = { width: 40, height: 10 },
  opts: { frameMs?: number; noColor?: boolean; onQuit?: () => void } = {},
): Promise<Mounted> {
  const t = await createTestRenderer(size);
  open.push(t);
  let frames = 0;
  t.renderer.on('frame', () => {
    frames += 1;
  });
  const host = new GridHost(t.renderer, {
    scene,
    noColor: opts.noColor ?? false,
    frameMs: opts.frameMs ?? 40,
    ...(opts.onQuit !== undefined ? { onQuit: opts.onQuit } : {}),
  });
  t.renderer.root.add(host);
  host.requestFrame();
  await sleep(60);
  return { t, host, frames: () => frames };
}

type Seen = {
  api?: HostApi;
  keys: string[];
  pastes: string[];
  hits: HitAction[];
  focus: boolean[];
  draws: number;
};

/** A scene that says what it draws and hears, and hands its host API out. */
function probe(draw: (g: Grid, api: HostApi) => void = () => {}) {
  const seen: Seen = { keys: [], pastes: [], hits: [], focus: [], draws: 0 };
  const scene: Scene = {
    ground: scanlines('#05080b', '#0a0f14'),
    draw(g, api) {
      seen.api = api;
      seen.draws += 1;
      g.text(0, 0, 'ready');
      draw(g, api);
    },
    key(key: KeyEvent) {
      seen.keys.push(key.name);
      return key.name === 'n' ? false : undefined;
    },
    paste(text) {
      seen.pastes.push(text);
    },
    hit(action) {
      seen.hits.push(action);
      return action.id === 'quiet' ? false : undefined;
    },
    focus(focused) {
      seen.focus.push(focused);
      // Losing focus is drawn; regaining it is not (the scene says nothing changed).
      return !focused;
    },
  };
  return { scene, seen };
}

/** The rows of the screen OpenTUI holds, and of the grid last drawn. */
const screenRows = (m: Mounted) => m.t.captureCharFrame().replace(/\n$/, '').split('\n');
const gridRows = (m: Mounted) => (m.host.grid?.toText() ?? '').split('\n');

describe('no frames when idle', () => {
  it('draws the first frame, then zero frames while nothing asks', async () => {
    const { scene } = probe();
    const m = await mount(scene);
    expect(m.host.paints).toBe(1);
    expect(m.frames()).toBe(1);
    await sleep(700);
    expect(m.host.paints).toBe(1);
    expect(m.frames()).toBe(1);
    expect(m.host.animation).toEqual({ running: false, active: 0, focused: true });
  });

  it('draws the demo scene idle with zero frames too', async () => {
    const m = await mount(demoScene(), { width: 100, height: 32 });
    const before = m.frames();
    await sleep(700);
    expect(m.frames() - before).toBe(0);
    expect(m.t.captureCharFrame()).toContain('TEST BOT');
  });

  it('coalesces many requests into one frame', async () => {
    const { scene, seen } = probe();
    const m = await mount(scene);
    for (let i = 0; i < 25; i++) m.host.requestFrame();
    await sleep(120);
    expect(m.frames()).toBe(2);
    expect(seen.draws).toBe(2);
  });
});

describe('the animation clock', () => {
  it('draws frames through a finite burst and stops, timer included, once it has ended', async () => {
    const { scene, seen } = probe((g, h) => g.text(0, 1, String(Math.floor(h.now() / 40))));
    const m = await mount(scene, undefined, { frameMs: 40 });
    const api = seen.api;
    if (api === undefined) throw new Error('the scene never drew');
    const burst = api.animate(400);
    expect(burst.end - burst.start).toBeCloseTo(400, 6);
    expect(m.host.animation).toMatchObject({ running: true, active: 1 });
    await sleep(250);
    // At 40 ms a frame, 250 ms is about six; a loaded machine may run slower, never zero.
    expect(m.host.paints).toBeGreaterThanOrEqual(2);
    // The burst ends at 400 ms; the tick after that stops the clock. Generous for a loaded box.
    await sleep(900);
    expect(m.host.animation).toMatchObject({ running: false, active: 0 });
    const settled = m.host.paints;
    await sleep(500);
    expect(m.host.paints).toBe(settled);
    expect(() => api.animate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(m.host.animation.running).toBe(false);
  });

  it('keeps one timer for overlapping bursts and stops only when the last one ends', async () => {
    const { scene, seen } = probe((g, h) => g.text(0, 1, String(Math.floor(h.now() / 40))));
    const m = await mount(scene);
    const api = seen.api as HostApi;
    const a = api.animate(10_000);
    const b = api.animate(10_000);
    expect(m.host.animation).toMatchObject({ running: true, active: 2 });
    a.cancel();
    expect(m.host.animation).toMatchObject({ running: true, active: 1 });
    await sleep(150);
    const still = m.host.paints;
    await sleep(150);
    expect(m.host.paints).toBeGreaterThan(still);
    b.cancel();
    await sleep(100);
    expect(m.host.animation).toMatchObject({ running: false, active: 0 });
  });

  it('runs a demo hop (Enter) for its eight frames and then goes quiet', async () => {
    const m = await mount(demoScene(), { width: 100, height: 32 }, { frameMs: 125 });
    m.t.mockInput.pressEnter();
    await sleep(60);
    expect(m.host.animation.running).toBe(true);
    await sleep(1300);
    expect(m.host.animation).toMatchObject({ running: false, active: 0 });
    const after = m.frames();
    await sleep(500);
    expect(m.frames()).toBe(after);
  });

  it('does not animate under PORCH_MOTION=reduced', async () => {
    const m = await mount(demoScene({ motion: 'reduced' }), { width: 100, height: 32 });
    m.t.mockInput.pressEnter();
    await sleep(60);
    expect(m.host.animation.running).toBe(false);
  });
});

describe('writing changed cells into a persistent buffer', () => {
  it('writes every cell first, then only the cells that changed, and none when nothing did', async () => {
    let label = 'aaaa';
    const { scene } = probe((g) => g.text(2, 3, label));
    const m = await mount(scene);
    expect(m.host.written).toBe(40 * 10);
    label = 'abaa';
    m.host.requestFrame();
    await sleep(80);
    expect(m.host.written).toBe(1);
    expect(screenRows(m)[3]).toBe(gridRows(m)[3]);
    // A frame OpenTUI draws for its own reasons: the grid is unchanged, nothing is written, and
    // the screen still holds every cell (the buffer kept them).
    m.t.renderer.requestRender();
    await sleep(80);
    expect(m.host.written).toBe(0);
    expect(screenRows(m)).toEqual(gridRows(m));
    expect(screenRows(m)[3]).toContain('abaa');
  });

  it('writes every cell again after a resize', async () => {
    const { scene } = probe((g) => g.text(0, 1, `${g.cols}x${g.rows}`));
    const m = await mount(scene);
    // OpenTUI may paint more than once after a resize; the cells written across those paints
    // cover the whole new grid, and the screen equals it.
    let before = m.host.writes;
    m.t.resize(60, 12);
    await sleep(120);
    expect(m.host.grid?.cols).toBe(60);
    expect(m.host.writes - before).toBeGreaterThanOrEqual(60 * 12);
    expect(screenRows(m)).toEqual(gridRows(m));
    before = m.host.writes;
    m.t.resize(30, 8);
    await sleep(120);
    expect(m.host.writes - before).toBeGreaterThanOrEqual(30 * 8);
    expect(screenRows(m)).toEqual(gridRows(m));
  });

  it('keeps the screen equal to the grid as wide and narrow glyphs replace each other', async () => {
    let line = '';
    const { scene } = probe((g) => g.text(1, 2, line));
    const m = await mount(scene);
    for (const next of [
      '日本語🙂字',
      'abcdefghijkl',
      '日本語🙂字',
      'x日本🙂語字',
      'x日本🙂',
      '字字字',
      'a字字',
    ]) {
      line = next;
      m.host.requestFrame();
      await sleep(60);
      expect(screenRows(m)[2], next).toBe(gridRows(m)[2]);
    }
  });
});

describe('input', () => {
  it('hands keys to the scene and draws after one unless the scene says nothing changed', async () => {
    const { scene, seen } = probe();
    const m = await mount(scene);
    m.t.mockInput.pressKey('x');
    await sleep(80);
    expect(seen.keys).toEqual(['x']);
    expect(m.host.paints).toBe(2);
    m.t.mockInput.pressKey('n');
    await sleep(80);
    expect(seen.keys).toEqual(['x', 'n']);
    expect(m.host.paints).toBe(2);
  });

  it('hands a bracketed paste to the scene as one piece of text', async () => {
    const { scene, seen } = probe();
    const m = await mount(scene);
    await m.t.mockInput.pasteBracketedText('two\nlines');
    await sleep(80);
    expect(seen.pastes).toEqual(['two\nlines']);
    expect(seen.keys).toEqual([]);
    expect(m.host.paints).toBe(2);
  });

  it('hands the scene the action of the last region registered under a left click', async () => {
    const { scene, seen } = probe((g) => {
      g.hit({ x: 0, y: 0, w: 40, h: 10 }, { id: 'back' });
      g.hit({ x: 10, y: 3, w: 8, h: 1 }, { id: 'front', data: { n: 1 } });
      g.hit({ x: 30, y: 8, w: 4, h: 1 }, { id: 'quiet' });
    });
    const m = await mount(scene);
    await m.t.mockMouse.click(12, 3);
    await m.t.mockMouse.click(2, 6);
    await m.t.mockMouse.click(12, 3, 2);
    await sleep(80);
    expect(seen.hits).toEqual([{ id: 'front', data: { n: 1 } }, { id: 'back' }]);
    const paints = m.host.paints;
    await m.t.mockMouse.click(31, 8);
    await sleep(80);
    expect(seen.hits.at(-1)).toEqual({ id: 'quiet' });
    expect(m.host.paints).toBe(paints);
  });

  it('tracks terminal focus and draws on a change only when the scene asks', async () => {
    const { scene, seen } = probe();
    const m = await mount(scene);
    m.t.renderer.emit('blur');
    await sleep(80);
    expect(m.host.animation.focused).toBe(false);
    expect(seen.api?.focused()).toBe(false);
    expect(m.host.paints).toBe(2);
    m.t.renderer.emit('focus');
    await sleep(80);
    expect(m.host.animation.focused).toBe(true);
    expect(seen.focus).toEqual([false, true]);
    expect(m.host.paints).toBe(2);
  });

  it('toggles the demo chip by clicking it', async () => {
    const scene = demoScene();
    const m = await mount(scene, { width: 100, height: 32 });
    expect(m.t.captureCharFrame()).toContain('CASUAL');
    await m.t.mockMouse.click(92, 0);
    await sleep(80);
    expect(scene.signed).toBe(true);
    expect(m.t.captureCharFrame()).toContain('SIGNED');
  });

  it('echoes typed text and pastes in the demo, with Backspace and Ctrl+U', async () => {
    const scene = demoScene();
    const m = await mount(scene, { width: 60, height: 30 });
    expect(screenRows(m)[28]).toContain('type here');
    await m.t.mockInput.typeText('hi q 界');
    await sleep(80);
    expect(scene.line).toBe('hi q 界');
    expect(screenRows(m)[28]).toContain('▸ hi q 界');
    m.t.mockInput.pressBackspace();
    await m.t.mockInput.pasteBracketedText('a\r\nb\x1b[2J');
    await sleep(80);
    expect(scene.line).toBe('hi q a b\x1b[2J');
    expect(gridRows(m)[28]).toContain('▸ hi q a b�[2J');
    expect(screenRows(m)[28]).toBe(gridRows(m)[28]);
    m.t.mockInput.pressKey('u', { ctrl: true });
    await sleep(80);
    expect(scene.line).toBe('');
    expect(screenRows(m)[28]).toContain('type here');
  });

  it('quits the demo on Esc and on Ctrl+C, and a typed q is only text', async () => {
    for (const press of [
      (t: TestRendererSetup) => t.mockInput.pressEscape(),
      (t: TestRendererSetup) => t.mockInput.pressCtrlC(),
    ]) {
      let quit = 0;
      const scene = demoScene();
      const m = await mount(scene, { width: 40, height: 10 }, { onQuit: () => quit++ });
      m.t.mockInput.pressKey('q');
      await sleep(40);
      expect(quit).toBe(0);
      expect(scene.line).toBe('q');
      press(m.t);
      await sleep(120);
      expect(quit).toBe(1);
    }
  });
});

describe('layout and glyphs', () => {
  it('lays the grid out again at the new size on a resize', async () => {
    const { scene } = probe((g) => g.text(0, 1, `${g.cols}x${g.rows}`));
    const m = await mount(scene);
    expect(m.host.grid?.cols).toBe(40);
    m.t.resize(60, 12);
    await sleep(120);
    expect(m.host.grid?.cols).toBe(60);
    expect(m.host.grid?.rows).toBe(12);
    expect(m.t.captureCharFrame()).toContain('60x12');
  });

  it('sends wide and multi-code-point graphemes whole, in the right columns', async () => {
    const { scene } = probe((g) => g.text(0, 2, 'a界b👨‍👩‍👧c🇺🇸déf'));
    const m = await mount(scene);
    const line = screenRows(m)[2] ?? '';
    expect(line.startsWith('a界b👨‍👩‍👧c🇺🇸déf')).toBe(true);
  });
});
