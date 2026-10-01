/**
 * The seams the stage and overlay lane plugs into, with a stand-in stage and overlays registered
 * through the real registry (the lane's own code is not on this branch):
 *
 * - a pick change is a `pick` stage event (and a pick cleared says so);
 * - every key is an `input` event first, F1 and quit included;
 * - a click on a `stage:` hit region reaches the stage's `hit`, or its `key` as a `click` key when
 *   it has no `hit` (the attract screen dismisses on any key);
 * - a word send that post confirmed is a `sent` event; an emote never is;
 * - an overlay draws over the whole screen;
 * - with no channel open, `?` opens help and ← the channel browser.
 */
import { describe, expect, it } from 'vitest';
import {
  type EmoteSendRequest,
  registerCommand,
  registerOverlay,
  registerStage,
  type Stage,
  type StageEvent,
} from '../../src/app/registry.ts';
import { appScene } from '../../src/app/scene.ts';
import type { Rect } from '../../src/grid/grid.ts';
import { frame, key, makeApp, press, SIZES, settle, summary, type } from './harness.ts';
import { busyWorld } from './worlds.ts';

const events: StageEvent[] = [];
const keys: string[] = [];
const hits: string[] = [];
let attract = false;

const stage: Stage = {
  height: (fit) => (fit === 'bodies' ? 10 : 6),
  draw() {},
  event(e) {
    events.push(e);
  },
  key(k) {
    keys.push(k.name);
    if (attract) {
      attract = false;
      return 'handled';
    }
    return 'pass';
  },
  hit(action) {
    hits.push(action.id);
    attract = false;
  },
  drawOver(g, area) {
    if (attract) g.hit(area, { id: 'stage:attract' });
  },
};
registerStage(stage);

const areas: Rect[] = [];
registerOverlay({
  id: 'probe',
  draw(_g, area) {
    areas.push(area);
  },
  key: () => 'handled',
});
registerOverlay({ id: 'browser', draw() {}, key: () => 'handled' });
registerOverlay({ id: 'help', draw() {}, key: () => 'handled' });

registerCommand({
  name: 'wave',
  usage: '/wave',
  needsChannel: true,
  run: async (_args, ctx) => {
    const req: EmoteSendRequest = {
      channel: ctx.state.current ?? '',
      body: '/wave',
      mode: 'casual',
      draftRevision: ctx.state.composer.revision,
      emote: { name: 'wave' },
    };
    await ctx.send(req);
  },
});

const reset = () => {
  events.length = 0;
  keys.length = 0;
  hits.length = 0;
};

describe('stage events', () => {
  it('a pick change is a pick event, and clearing it says so', async () => {
    const app = await makeApp(busyWorld());
    reset();
    press(app, key('up', { ctrl: true }));
    const picked = app.m.pane().pick;
    expect(picked).toBeDefined();
    expect(events.filter((e) => e.kind === 'pick')).toEqual([
      { kind: 'pick', channel: 'commons', id: picked },
    ]);
    press(app, key('escape'));
    expect(events.filter((e) => e.kind === 'pick').at(-1)).toEqual({
      kind: 'pick',
      channel: 'commons',
      id: undefined,
    });
  });

  it('every key is input first, F1 and quit included', async () => {
    const app = await makeApp(busyWorld());
    reset();
    press(app, key('f1'));
    expect(events).toEqual([{ kind: 'input' }]);
    press(app, key('f1'));
    reset();
    press(app, key('q', { ctrl: true }));
    expect(events[0]).toEqual({ kind: 'input' });
    await settle();
  });

  it('a confirmed word send is a sent event; an emote never is', async () => {
    const app = await makeApp(
      busyWorld({ sendEmote: async () => ({ kind: 'confirmed', id: 'emote-1' }) }),
    );
    reset();
    type(app, '/wave');
    press(app, key('return'));
    await settle();
    expect(events.filter((e) => e.kind === 'sent')).toEqual([]);
    type(app, 'words');
    press(app, key('return'));
    await settle();
    expect(events.filter((e) => e.kind === 'sent').length).toBe(1);
  });
});

describe('a click on the stage', () => {
  it('reaches the stage’s hit through the grid; without hit, its key as a click', async () => {
    const app = await makeApp(busyWorld());
    attract = true;
    let g = frame(app, 100, 32);
    const action = g.hitAt(50, 20);
    expect(action?.id).toBe('stage:attract');
    reset();
    expect(appScene(app.m).hit?.(action ?? { id: 'none' }, app.host)).toBe(true);
    expect(hits).toEqual(['stage:attract']);
    expect(attract).toBe(false);
    // A stage with no `hit`: the click arrives as a key, and the attract screen takes any key.
    const { hit } = stage;
    delete stage.hit;
    try {
      attract = true;
      g = frame(app, 100, 32);
      reset();
      appScene(app.m).hit?.(g.hitAt(50, 20) ?? { id: 'none' }, app.host);
      expect(keys).toEqual(['click']);
      expect(attract).toBe(false);
    } finally {
      if (hit !== undefined) stage.hit = hit;
    }
  });
});

describe.each(SIZES)('overlays at $name', ({ cols, rows }) => {
  it('draw over the whole screen', async () => {
    const app = await makeApp(busyWorld());
    app.m.openOverlay('probe');
    areas.length = 0;
    frame(app, cols, rows);
    expect(areas).toEqual([{ x: 0, y: 0, w: cols, h: rows }]);
  });
});

describe('with no channel open', () => {
  it('? opens help and ← opens the channel browser', async () => {
    const app = await makeApp({ channels: [summary('lobby', { unread: undefined })] });
    expect(app.m.current).toBeUndefined();
    press(app, key('?'));
    expect(app.m.overlay).toBe('help');
    press(app, key('escape'));
    expect(app.m.overlay).toBeUndefined();
    press(app, key('left'));
    expect(app.m.overlay).toBe('browser');
  });
});
