/**
 * Times are Trey's local time (finish review, fix 5): the stream and search convert a record's
 * timestamp, with its own offset, to the local zone, and so show the same clock time. The run pins
 * TZ=UTC (vitest.config.ts); this test moves the process to Chicago and back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sentParts, sentWhen } from '../../src/app/derive.ts';
import { createSearch } from '../../src/app/overlays/search.ts';
import type { Key } from '../../src/app/registry.ts';
import { drawStream } from '../../src/app/stream.ts';
import { Grid } from '../../src/grid/grid.ts';
import { GROUND, lines, message, Rig } from '../stage/rig.ts';

const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});

let zone: string | undefined;
beforeEach(() => {
  zone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

// Written in Berlin at 23:30 (+0200): 21:30 UTC, 16:30 in Chicago (CDT, -0500).
const SENT = '2026-09-30 23:30:00 +0200';

describe("a record from another zone, in Trey's local time", () => {
  it('converts with the record’s own offset', () => {
    // Precondition: the process really is in Chicago now.
    expect(new Date('2026-09-30T21:30:00Z').getHours()).toBe(16);
    expect(sentParts(SENT)).toEqual({ day: '2026-09-30', time: '16:30' });
    expect(sentWhen(SENT)).toBe('09-30 16:30');
    expect(sentParts('2026-10-01T02:10:00Z')).toEqual({ day: '2026-09-30', time: '21:10' });
  });

  it('the stream and search show the same time', async () => {
    const r = message('bolt', 'notes from berlin', { extra: { sent: SENT } });
    expect(r.raw.sent).toBe(SENT);
    const rig = new Rig();
    rig.load('commons', [r]);
    const s = rig.state(100, 32);
    const pane = s.panes[0];
    if (pane === undefined) throw new Error('no pane');
    const g = new Grid(100, 32, GROUND);
    drawStream(g, { x: 0, y: 0, w: 100, h: 20 }, pane, 0, s, { ensurePick: false });
    const header = lines(g).find((l) => l.includes('#abcdef'));
    expect(header, lines(g).join('\n')).toContain('16:30');
    expect(lines(g).join('\n')).not.toContain('23:30');

    const o = createSearch(async () => ({
      ok: true,
      value: { hits: [r], truncated: false, limit: 1000 },
    }));
    for (const c of 'berlin') o.key(key(c, { text: c }), s);
    o.key(key('return'), s);
    await new Promise((done) => setTimeout(done, 0));
    const sg = new Grid(100, 32, GROUND);
    o.draw(sg, { x: 0, y: 0, w: 100, h: 32 }, s);
    const found = lines(sg).join('\n');
    expect(found).toContain('notes from berlin');
    expect(found).toContain('09-30 16:30');
    expect(found).not.toContain('23:30');
  });
});
