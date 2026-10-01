/**
 * The animation clock is read for every frame, not frozen in the data snapshot: with nothing in
 * post changing, successive 125 ms samples of the needs-you flash draw different cells, and after
 * the burst the lane draws as it did at its start.
 */
import { describe, expect, it } from 'vitest';
import type { Grid } from '../../src/grid/grid.ts';
import { frame, makeApp, record, SIZES, summary } from './harness.ts';

/** The score bar's cells (its first two rows), characters and colours. */
function bar(g: Grid): string {
  const out: string[] = [];
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < g.cols; x++) {
      const c = g.at(x, y);
      out.push(c === undefined ? '' : `${c.ch}${c.fg}${c.bg}${c.bold === true ? 'b' : ''}`);
    }
  return out.join('|');
}

describe.each(SIZES)('at $name', ({ cols, rows }) => {
  it('the needs-you flash changes cells every 125 ms, then restores', async () => {
    const app = await makeApp({
      motion: 'full',
      channels: [summary('commons', { unread: 0 }), summary('ops', { unread: 0 })],
      records: { commons: [record({ minutes: 50, body: 'hi' })] },
    });
    frame(app, cols, rows);
    app.source.setRecords('commons', [
      record({ minutes: 50, body: 'hi' }),
      record({ minutes: 51, seq: 1, body: '@mara your call' }),
    ]);
    app.source.setChannels([summary('commons', { unread: 1 }), summary('ops', { unread: 0 })]);
    const burst = app.m.flashes.get('commons');
    if (burst === undefined) throw new Error('no flash started');
    const samples: string[] = [];
    for (let t = burst.start; t <= burst.end; t += 125) {
      app.host.time = t;
      samples.push(bar(frame(app, cols, rows)));
    }
    // Precondition: six phases inside the burst and one after it.
    expect(samples.length).toBe(7);
    // On, off, on, off, on, off: each sample differs from the one before it.
    for (let i = 1; i < 6; i++) expect(samples[i], `sample ${i}`).not.toBe(samples[i - 1]);
    // After the burst the lane is drawn as it was at the burst's start (needs-you, steady).
    expect(samples[6]).toBe(samples[0]);
    app.host.time = burst.end + 1000;
    expect(bar(frame(app, cols, rows))).toBe(samples[0]);
  });
});
