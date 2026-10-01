/**
 * Remembering the layout and the last channel, and the layout chip that flips it.
 *
 * The file tests use a temporary directory (never `~/.local/state/porch-next`). The model tests
 * drive the real `AppModel` over the fake source, with the save callback captured, and draw real
 * frames: the chip is found in the frame and clicked through the grid's own hit test.
 */
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_SAVE_MS, pickLaunchChannel } from '../../src/app/model.ts';
import { LAYOUT_FILE, loadLayout, type SavedLayout, saveLayout } from '../../src/app/remember.ts';
import { appScene } from '../../src/app/scene.ts';
import { layoutChipText } from '../../src/app/view.ts';
import { find, frame, key, lines, makeApp, press, settle, summary } from './harness.ts';

const WIDE = { cols: 160, rows: 44 };
const channels = () => [summary('commons'), summary('ops'), summary('design')];

describe('the layout file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'porch-layout-'));
  });

  it('round-trips, is private, and leaves no temporary file', () => {
    const layout: SavedLayout = { split: false, panes: ['ops', 'commons'], focused: 1 };
    expect(saveLayout(join(dir, 'state'), layout)).toBe(true);
    expect(loadLayout(join(dir, 'state'))).toEqual(layout);
    const file = join(dir, 'state', LAYOUT_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, 'state'))).toEqual([LAYOUT_FILE]);
  });

  it('a missing, corrupt or wrong-shaped file means no memory, not a crash', () => {
    expect(loadLayout(join(dir, 'nowhere'))).toBeUndefined();
    for (const body of ['', '{not json', 'null', '[]', '{"split":"yes"}', '{"panes":["a"]}']) {
      writeFileSync(join(dir, LAYOUT_FILE), body);
      expect(loadLayout(dir), body).toBeUndefined();
    }
  });

  it('clamps what it reads: at most two panes, strings only, focus inside them', () => {
    writeFileSync(
      join(dir, LAYOUT_FILE),
      JSON.stringify({ split: true, panes: ['a', 7, '', 'b', 'c'], focused: 9 }),
    );
    expect(loadLayout(dir)).toEqual({ split: true, panes: ['a', 'b'], focused: 0 });
  });

  it('a write that cannot happen reports false and leaves the old file', () => {
    expect(saveLayout(dir, { split: true, panes: ['a'], focused: 0 })).toBe(true);
    // A directory sits where the temporary file would go through the target's parent: use a file
    // as the "directory" so the write fails.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(saveLayout(blocker, { split: false, panes: [], focused: 0 })).toBe(false);
    expect(loadLayout(dir)?.split).toBe(true);
  });
});

describe('which channel opens at launch', () => {
  it('an explicit channel wins; else the remembered one; else today’s choice', () => {
    const joined = ['commons', 'ops'];
    expect(pickLaunchChannel('commons', 'commons', joined, 'ops')).toBe('commons');
    expect(pickLaunchChannel(undefined, 'commons', joined, 'ops')).toBe('ops');
    // Remembered but gone (archived or left): today’s behaviour.
    expect(pickLaunchChannel(undefined, 'commons', joined, 'old')).toBe('commons');
    // An explicit channel that is not joined falls back as before, not to the remembered one.
    expect(pickLaunchChannel('nope', 'commons', joined, 'ops')).toBe('commons');
  });
});

describe('remembering through the model', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  async function started(remembered?: SavedLayout, launch?: string) {
    const saved: SavedLayout[] = [];
    const app = await makeApp({
      channels: channels(),
      ...(remembered === undefined ? {} : { remembered }),
      ...(launch === undefined ? {} : { launch }),
      saveLayout: (l) => saved.push(l),
    });
    return { app, saved };
  }

  it('reopens the channel he was last in, and an explicit one still wins', async () => {
    const last = { split: true, panes: ['ops', 'design'], focused: 0 };
    expect((await started(last)).app.m.current).toBe('ops');
    expect((await started(last, 'design')).app.m.current).toBe('design');
    // Gone: falls back to the configured initial channel.
    expect((await started({ split: true, panes: ['old'], focused: 0 })).app.m.current).toBe(
      'commons',
    );
  });

  it('restores single versus split, and both panes on a wide screen', async () => {
    const { app } = await started({ split: false, panes: ['ops', 'design'], focused: 0 });
    expect(app.m.split).toBe(false);
    frame(app, WIDE.cols, WIDE.rows);
    expect(app.m.panes.length).toBe(1);

    const both = (await started({ split: true, panes: ['ops', 'design'], focused: 0 })).app;
    frame(both, WIDE.cols, WIDE.rows);
    expect(both.m.panes.map((p) => p.channel)).toEqual(['ops', 'design']);
    expect(both.m.focusedPane).toBe(0);

    // Focus was on the right-hand pane: same order, same focus.
    const right = (await started({ split: true, panes: ['ops', 'design'], focused: 1 })).app;
    frame(right, WIDE.cols, WIDE.rows);
    expect(right.m.panes.map((p) => p.channel)).toEqual(['ops', 'design']);
    expect(right.m.focusedPane).toBe(1);
    expect(right.m.current).toBe('design');
  });

  it('saves a change after the debounce, once, and not before', async () => {
    const { app, saved } = await started();
    frame(app, WIDE.cols, WIDE.rows);
    await app.m.openChannel('design');
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(LAYOUT_SAVE_MS + 1);
    expect(saved.length).toBe(1);
    expect(saved[0]?.panes[app.m.focusedPane]).toBe('design');
    expect(saved[0]?.split).toBe(true);
    // Nothing changed since: the clock moving writes nothing more.
    app.m.touch();
    vi.advanceTimersByTime(LAYOUT_SAVE_MS * 3);
    expect(saved.length).toBe(1);
  });

  it('the layout key changes the saved preference, and dispose writes it at once', async () => {
    const { app, saved } = await started({ split: true, panes: ['commons', 'ops'], focused: 0 });
    frame(app, WIDE.cols, WIDE.rows);
    press(app, key('f2'));
    expect(app.m.split).toBe(false);
    app.m.dispose();
    expect(saved.at(-1)).toEqual({ split: false, panes: ['commons', 'ops'], focused: 0 });
  });

  it('toggling single and back brings the same second channel back', async () => {
    const { app } = await started();
    frame(app, WIDE.cols, WIDE.rows);
    await app.m.openChannel('design');
    const before = app.m.panes.map((p) => p.channel);
    app.m.toggleSplit();
    expect(app.m.panes.length).toBe(1);
    app.m.toggleSplit();
    await settle();
    expect(app.m.panes.length).toBe(2);
    expect(new Set(app.m.panes.map((p) => p.channel))).toEqual(new Set(before));
  });

  it('a narrow run keeps the pair it remembered', async () => {
    const { app, saved } = await started({ split: true, panes: ['ops', 'design'], focused: 0 });
    frame(app, 100, 32);
    app.m.dispose();
    // Nothing he did changed the layout, so nothing is rewritten.
    expect(saved).toEqual([]);
    await app.m.openChannel('commons');
    app.m.dispose();
    expect(saved.at(-1)).toEqual({ split: true, panes: ['commons', 'design'], focused: 0 });
  });

  it('never writes before start has restored (defaults cannot clobber the file)', async () => {
    const saved: SavedLayout[] = [];
    const { AppModel } = await import('../../src/app/model.ts');
    const m = new AppModel({
      owner: { room: 'mara', participant: 'p', label: 'Mara', marker: '🦊' },
      anchor: undefined as never,
      source: undefined as never,
      armed: false,
      motion: 'full',
      send: async () => ({ kind: 'confirmed', id: 'x' }),
      saveLayout: (l) => saved.push(l),
    });
    m.touch();
    m.dispose();
    expect(saved).toEqual([]);
  });

  it('a save that throws is swallowed', async () => {
    const app = await makeApp({
      channels: channels(),
      saveLayout: () => {
        throw new Error('disk full');
      },
    });
    app.m.toggleSplit();
    expect(() => app.m.dispose()).not.toThrow();
  });
});

describe('the layout chip', () => {
  it('shows the layout and its key on wide, and flips it by click', async () => {
    const app = await makeApp({ channels: channels() });
    let g = frame(app, WIDE.cols, WIDE.rows);
    const split = find(g, layoutChipText(true).trim());
    if (split === undefined) throw new Error(lines(g).join('\n'));
    expect(split.y).toBe(WIDE.rows - 1);
    const action = g.hitAt(split.x + 2, split.y);
    expect(action).toEqual({ id: 'layout' });
    expect(appScene(app.m).hit?.(action ?? { id: 'none' }, app.host)).toBe(true);
    expect(app.m.split).toBe(false);
    g = frame(app, WIDE.cols, WIDE.rows);
    expect(find(g, layoutChipText(false).trim())).toBeDefined();
    expect(find(g, layoutChipText(true).trim())).toBeUndefined();
    expect(app.m.panes.length).toBe(1);
  });

  it('is not drawn where there is no split to choose', async () => {
    const app = await makeApp({ channels: channels() });
    for (const [cols, rows] of [
      [100, 32],
      [40, 52],
    ] as const) {
      const g = frame(app, cols, rows);
      expect(find(g, ' F2')).toBeUndefined();
      expect(find(g, '· F2')).toBeUndefined();
    }
  });

  it('stays out of a notice’s way and keeps the hints to its left', async () => {
    const app = await makeApp({ channels: channels() });
    const g = frame(app, WIDE.cols, WIDE.rows);
    const chip = find(g, layoutChipText(true).trim());
    const hints = find(g, 'F1 help');
    expect(chip && hints && hints.x < chip.x).toBe(true);
    app.m.status('a notice that is fairly long and sits at the right', 'info');
    const g2 = frame(app, WIDE.cols, WIDE.rows);
    expect(find(g2, layoutChipText(true).trim())).toBeDefined();
    expect(find(g2, 'a notice that is fairly long')).toBeDefined();
  });

  it('under NO_COLOR it is bold underlined words with the glyph and word intact', async () => {
    const app = await makeApp({ channels: channels(), noColor: true });
    const g = frame(app, WIDE.cols, WIDE.rows);
    const at = find(g, layoutChipText(true).trim());
    if (at === undefined) throw new Error(lines(g).join('\n'));
    const cell = g.at(at.x + 2, at.y);
    expect(cell?.underline).toBe(true);
    expect(cell?.bold).toBe(true);
    // Words on the bar's own background, not a lit block.
    expect(cell?.bg).toBe(g.at(at.x - 2, at.y)?.bg);
  });
});
