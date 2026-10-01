/**
 * Ctrl+O over a long channel: 10,000 messages across five weeks, of which the store holds the
 * newest 200. Each press loads 100 older through `history`, day rules separate the days, the
 * window stops at 5,000 and says so, and a short channel's top says it is the beginning.
 */
import type { RawRecord } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import { MAX_WINDOW, OLDER_STEP } from '../../src/app/model.ts';
import {
  type AppOptions,
  frame,
  key,
  lines,
  makeApp,
  press,
  record,
  SIZES,
  settle,
  summary,
} from './harness.ts';

const text = (g: ReturnType<typeof frame>) => lines(g).join('\n');

/** `n` messages, one every five minutes, ending just before the pinned clock. */
function channel(n: number): RawRecord[] {
  return Array.from({ length: n }, (_, i) =>
    record({ minutes: (i - n) * 5, seq: i % 7, body: `message ${i}` }),
  );
}

function world(n: number, messages: number | undefined): AppOptions {
  const all = channel(n);
  return {
    channels: [summary('commons', { unread: 0, messages })],
    records: { commons: all },
    history: async (_channel, limit) => ({ ok: true, value: all.slice(-limit) }),
    verify: async () => ({ state: 'unknown', reason: 'not checked in this test' }),
  };
}

const toTop = (app: Awaited<ReturnType<typeof makeApp>>) => app.m.scroll(1_000_000);

describe.each(SIZES)('at $name', ({ cols, rows }) => {
  it('loads 100 older per Ctrl+O, with day rules, up to the 5,000 window, and says so', async () => {
    const app = await makeApp(world(10_000, 10_000));
    expect(app.m.records('commons').length).toBe(200);
    toTop(app);
    let g = frame(app, cols, rows);
    expect(text(g)).toContain('Ctrl+O loads older');
    expect(text(g)).toMatch(/── 2026-\d\d-\d\d ─/);
    press(app, key('o', { ctrl: true }));
    await settle();
    expect(app.m.records('commons').length).toBe(200 + OLDER_STEP);
    expect(text(frame(app, cols, rows))).toContain(`loaded ${OLDER_STEP} older messages`);
    for (let i = 0; app.m.records('commons').length < MAX_WINDOW; i++) {
      if (i > 60) throw new Error('Ctrl+O never reached the window');
      press(app, key('o', { ctrl: true }));
      await settle();
    }
    expect(app.m.records('commons').length).toBe(MAX_WINDOW);
    press(app, key('o', { ctrl: true }));
    await settle();
    expect(app.m.records('commons').length).toBe(MAX_WINDOW);
    toTop(app);
    g = frame(app, cols, rows);
    expect(text(g)).toContain(`the newest ${MAX_WINDOW} are held`);
    expect(text(g)).not.toContain('beginning of');
    // The oldest held message is 5,000 from the end.
    expect(text(g)).toContain(`message ${10_000 - MAX_WINDOW}`);
  });

  it('a search hit in the older half opens in a window held around it; Ctrl+G returns', async () => {
    const w = world(10_000, 10_000);
    const asked: number[] = [];
    const history = w.history;
    const app = await makeApp({
      ...w,
      history: async (channel, limit) => {
        asked.push(limit);
        return history === undefined ? { ok: true, value: [] } : history(channel, limit);
      },
    });
    const all = channel(10_000);
    const hit = all[2000];
    if (hit === undefined) throw new Error('fixture');
    // Precondition: the hit is older than the newest 5,000 the live window can ever hold.
    expect(10_000 - 2000).toBeGreaterThan(MAX_WINDOW);
    app.m.actions.jumpTo('commons', hit.id);
    for (let i = 0; i < 20 && app.m.pane().pick !== hit.id; i++) await settle();
    expect(app.m.pane().pick).toBe(hit.id);
    const held = app.m.records('commons');
    expect(held.length).toBeLessThanOrEqual(MAX_WINDOW);
    expect(held.some((r) => r.id === hit.id)).toBe(true);
    // Every fetch was bounded (post reads only the newest N).
    expect(Math.max(...asked)).toBeLessThanOrEqual(20_000);
    let g = frame(app, cols, rows);
    expect(text(g)).toContain('message 2000');
    expect(text(g)).toContain('newer messages · Ctrl+G');
    // The live window still drives arrivals and needs-you: it is untouched.
    expect(app.m.liveRecords('commons').length).toBe(200);
    press(app, key('g', { ctrl: true }));
    expect(app.m.records('commons').length).toBe(200);
    g = frame(app, cols, rows);
    expect(text(g)).toContain('message 9999');
    expect(text(g)).not.toContain('newer messages · Ctrl+G');
  });

  it('Ctrl+O in a held window loads older around it, still bounded', async () => {
    const app = await makeApp(world(10_000, 10_000));
    // Far enough from the start that the held window does not reach it.
    const hit = channel(10_000)[4000];
    if (hit === undefined) throw new Error('fixture');
    await app.m.jumpTo('commons', hit.id);
    const before = app.m.records('commons');
    const oldest = before[0]?.id ?? '';
    press(app, key('o', { ctrl: true }));
    await settle();
    const after = app.m.records('commons');
    expect(after.length).toBeLessThanOrEqual(MAX_WINDOW);
    expect((after[0]?.id ?? '~') < oldest).toBe(true);
    expect(after.some((r) => r.id === hit.id)).toBe(true);
  });

  it('a short channel says it is the beginning, and Ctrl+O there says so too', async () => {
    const app = await makeApp(world(150, 150));
    toTop(app);
    expect(text(frame(app, cols, rows))).toContain('⤒ beginning of #commons');
    press(app, key('o', { ctrl: true }));
    await settle();
    expect(text(frame(app, cols, rows))).toContain('already at the beginning of #commons');
  });

  it('without a message count, finds the beginning when Ctrl+O loads nothing new', async () => {
    const app = await makeApp(world(250, undefined));
    toTop(app);
    expect(text(frame(app, cols, rows))).toContain('Ctrl+O loads older');
    press(app, key('o', { ctrl: true }));
    await settle();
    expect(app.m.records('commons').length).toBe(250);
    press(app, key('o', { ctrl: true }));
    await settle();
    toTop(app);
    expect(text(frame(app, cols, rows))).toContain('⤒ beginning of #commons');
  });
});
