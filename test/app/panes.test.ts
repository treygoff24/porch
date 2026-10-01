/**
 * Panes: what a click reaches on a wide split, which pane's frame Ctrl+U trusts, and which
 * channels the store polls in the foreground.
 *
 * - Clicks go through the drawn grid's own hit test (`Grid.hitAt`) and the scene's handler, the way
 *   the host delivers them: a message in the unfocused pane picks it there, and an empty part of
 *   that pane focuses it.
 * - Ctrl+U right after a switch, before any frame of the new channel, marks nothing: the last frame
 *   showed another channel.
 * - A channel polls in the foreground exactly while a pane shows it.
 */
import { describe, expect, it } from 'vitest';
import { appScene } from '../../src/app/scene.ts';
import { find, frame, key, lines, makeApp, press, record, settle, summary } from './harness.ts';
import { busyWorld } from './worlds.ts';

const WIDE = { cols: 160, rows: 44 };

describe('clicks on a wide split', () => {
  it('a message in the other pane is picked there, through the grid’s hit test', async () => {
    const app = await makeApp(busyWorld());
    const g = frame(app, WIDE.cols, WIDE.rows);
    expect(app.m.panes.length).toBe(2);
    expect(app.m.focusedPane).toBe(0);
    const other = app.m.panes[1]?.channel;
    expect(other).toBe('ops');
    // A word of an #ops message, in the right-hand pane.
    const opsRecords = app.m.records('ops');
    const body = opsRecords.at(-1)?.body.split(' ').slice(0, 3).join(' ') ?? '';
    let at: { x: number; y: number } | undefined;
    for (let y = 0; y < g.rows && at === undefined; y++) {
      const row = lines(g)[y] ?? '';
      const x = row.indexOf(body, WIDE.cols / 2);
      if (x !== -1) at = { x, y };
    }
    if (at === undefined) throw new Error(`no ${body} in\n${lines(g).join('\n')}`);
    const action = g.hitAt(at.x, at.y);
    expect(action?.id).toBe('record');
    const handled = appScene(app.m).hit?.(action ?? { id: 'none' }, app.host);
    expect(handled).toBe(true);
    expect(app.m.focusedPane).toBe(1);
    expect(app.m.pane(1).pick).toBe(opsRecords.at(-1)?.id);
  });

  it('a reply chip in the other pane is reachable, and an empty spot focuses the pane', async () => {
    const app = await makeApp(busyWorld());
    // Pick the newest commons message, so its [r] reply chip is drawn.
    press(app, key('up', { ctrl: true }));
    let g = frame(app, WIDE.cols, WIDE.rows);
    const chip = find(g, '[r] reply');
    if (chip === undefined) throw new Error(lines(g).join('\n'));
    expect(g.hitAt(chip.x + 1, chip.y)?.id).toBe('reply');
    // The right-hand pane's stage strip registers nothing of its own: the pane's target is under.
    g = frame(app, WIDE.cols, WIDE.rows);
    const stageSpot = g.hitAt(WIDE.cols - 3, 4);
    expect(stageSpot).toEqual({ id: 'pane', data: 1 });
    appScene(app.m).hit?.(stageSpot ?? { id: 'none' }, app.host);
    expect(app.m.focusedPane).toBe(1);
    expect(app.m.current).toBe('ops');
  });
});

describe('Ctrl+U trusts only a frame of the current channel', () => {
  it('right after a switch, before a frame, it marks nothing (not the old channel’s records)', async () => {
    const app = await makeApp(busyWorld());
    frame(app, 100, 32);
    // Precondition: the frame recorded commons messages Ctrl+U could have used.
    expect(app.m.paneViews.get(0)?.visible.length).toBeGreaterThan(0);
    await app.m.openChannel('ops');
    press(app, key('u', { ctrl: true }));
    await settle();
    expect(app.source.acks).toEqual([]);
    expect(app.m.notice?.text).toContain('nothing on screen to mark read');
    // After a frame of #ops, it marks #ops.
    frame(app, 100, 32);
    press(app, key('u', { ctrl: true }));
    await settle();
    expect(app.source.acks.map((a) => a.channel)).toEqual(['ops']);
  });

  it('never hands the store a record from another channel', async () => {
    const app = await makeApp({
      channels: [summary('commons', { unread: 1 }), summary('ops', { unread: 1 })],
      records: {
        commons: [record({ minutes: 1, from: 'nova', participant: 'test-nova02', body: 'c' })],
        ops: [
          record({
            minutes: 2,
            from: 'nova',
            participant: 'test-nova02',
            body: 'o',
            channel: 'ops',
          }),
        ],
      },
    });
    frame(app, 100, 32);
    // A pane view that claims #commons but holds an #ops record (as a stale frame could).
    const view = app.m.paneViews.get(0);
    if (view === undefined) throw new Error('no pane view');
    const ops = app.m.records('ops')[0];
    if (ops === undefined) throw new Error('no ops record');
    app.m.paneViews.set(0, { ...view, visible: [ops] });
    press(app, key('u', { ctrl: true }));
    await settle();
    expect(app.source.acks).toEqual([]);
  });

  it('ignores a frame recorded for another channel, even one holding this channel’s records', async () => {
    const app = await makeApp({
      channels: [summary('commons', { unread: 1 })],
      records: {
        commons: [record({ minutes: 1, from: 'nova', participant: 'test-nova02', body: 'c' })],
      },
    });
    frame(app, 100, 32);
    const view = app.m.paneViews.get(0);
    if (view === undefined) throw new Error('no pane view');
    // Precondition: as drawn, Ctrl+U would mark this record.
    expect(view.visible.length).toBe(1);
    app.m.paneViews.set(0, { ...view, channel: 'ops' });
    press(app, key('u', { ctrl: true }));
    await settle();
    expect(app.source.acks).toEqual([]);
  });
});

describe('foreground polling follows the panes', () => {
  it('switching away puts a channel back on the background cycle', async () => {
    const app = await makeApp(busyWorld());
    expect(app.source.background.get('commons')).toBe(false);
    await app.m.openChannel('design');
    expect(app.source.background.get('commons')).toBe(true);
    expect(app.source.background.get('design')).toBe(false);
  });

  it('closing the split demotes the channel the removed pane showed', async () => {
    const app = await makeApp(busyWorld());
    frame(app, WIDE.cols, WIDE.rows);
    expect(app.m.panes.map((p) => p.channel)).toEqual(['commons', 'ops']);
    expect(app.source.background.get('ops')).toBe(false);
    press(app, key('\\', { ctrl: true }));
    expect(app.m.panes.length).toBe(1);
    expect(app.source.background.get('ops')).toBe(true);
    expect(app.source.background.get('commons')).toBe(false);
    // Narrowing the terminal removes the pane the same way.
    press(app, key('\\', { ctrl: true }));
    frame(app, WIDE.cols, WIDE.rows);
    expect(app.source.background.get('ops')).toBe(false);
    frame(app, 100, 32);
    expect(app.m.panes.length).toBe(1);
    expect(app.source.background.get('ops')).toBe(true);
  });
});
