/**
 * The unread divider and Ctrl+U, which acknowledges through the newest attention-eligible record
 * the focused pane SHOWS (never the newest in the channel, never an emote or Trey's own message).
 * The fake source applies post-kit's `newestEligible` to what it is handed, exactly as the store
 * does, so these tests pin what the app hands it.
 */
import { describe, expect, it } from 'vitest';
import {
  find,
  frame,
  idAt,
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

function emoteWorld(unread = 1) {
  return {
    channels: [summary('commons', { unread, messages: 3 })],
    records: {
      commons: [
        record({ minutes: 10, body: 'read already' }),
        record({
          minutes: 20,
          from: 'nova',
          participant: 'test-nova02',
          name: 'Nova',
          body: 'the new one',
        }),
        record({ minutes: 21, seq: 1, emote: 'hop' }),
        record({ minutes: 22, seq: 1, emote: 'wave' }),
      ],
    },
  };
}

describe.each(SIZES)('at $name', ({ cols, rows }) => {
  it('puts the divider above the unread message, not above the emotes after it', async () => {
    const app = await makeApp(emoteWorld());
    const g = frame(app, cols, rows);
    const div = find(g, 'NEW · 1');
    const msg = find(g, 'the new one');
    const hop = find(g, '· hop');
    if (div === undefined || msg === undefined || hop === undefined) throw new Error(text(g));
    expect(div.y).toBeLessThan(msg.y);
    expect(msg.y).toBeLessThan(hop.y);
  });

  it('Ctrl+U acknowledges the unread message, not the emotes that follow it', async () => {
    const app = await makeApp(emoteWorld());
    frame(app, cols, rows);
    press(app, key('u', { ctrl: true }));
    await settle();
    expect(app.source.acks).toEqual([{ channel: 'commons', id: idAt(20) }]);
    expect(text(frame(app, cols, rows))).not.toContain('NEW ·');
  });

  it('emotes arriving after the channel opened leave the divider and its count alone', async () => {
    const app = await makeApp(emoteWorld());
    frame(app, cols, rows);
    const world = emoteWorld();
    app.source.setRecords('commons', [
      ...world.records.commons,
      record({ minutes: 30, seq: 1, emote: 'spin' }),
      record({ minutes: 31, seq: 1, emote: 'hop' }),
    ]);
    const g = frame(app, cols, rows);
    expect(text(g)).toContain('NEW · 1');
    const div = find(g, 'NEW · 1');
    const msg = find(g, 'the new one');
    if (div === undefined || msg === undefined) throw new Error(text(g));
    expect(div.y).toBeLessThan(msg.y);
  });

  it('a pane showing only emotes and Trey’s own words has nothing to mark', async () => {
    const app = await makeApp({
      channels: [summary('commons', { unread: 0 })],
      records: {
        commons: [
          record({ minutes: 10, from: 'mara', participant: 'porch-7f3a9c', body: 'mine' }),
          record({ minutes: 11, seq: 1, emote: 'hop' }),
        ],
      },
    });
    frame(app, cols, rows);
    press(app, key('u', { ctrl: true }));
    await settle();
    expect(app.source.acks).toEqual([]);
    expect(text(frame(app, cols, rows))).toContain('nothing on screen to mark read');
  });

  it('scrolled up, Ctrl+U acknowledges through the newest message on screen, not the newest', async () => {
    const records = Array.from({ length: 80 }, (_, i) =>
      record({
        minutes: i,
        from: 'nova',
        participant: 'test-nova02',
        name: 'Nova',
        body: `message ${i}`,
      }),
    );
    const app = await makeApp({
      channels: [summary('commons', { unread: 80, messages: 80 })],
      records: { commons: records },
    });
    frame(app, cols, rows);
    press(app, key('pageup'));
    press(app, key('pageup'));
    const g = frame(app, cols, rows);
    const shown = lines(g)
      .flatMap((l) => [...l.matchAll(/message (\d+)\b/g)].map((m) => Number(m[1])))
      .filter((n) => Number.isFinite(n));
    // Precondition: the pane is scrolled away from the newest message.
    expect(shown.length).toBeGreaterThan(0);
    const newestShown = Math.max(...shown);
    expect(newestShown).toBeLessThan(79);
    press(app, key('u', { ctrl: true }));
    await settle();
    expect(app.source.acks).toEqual([{ channel: 'commons', id: idAt(newestShown) }]);
  });
});
