/**
 * A feature's message renderer draws only the body. The core draws the sender line, its
 * verification badge and the reply line around it, for every message the renderer takes, so a
 * plug-in can never drop or restyle "claims Trey" on a record that is not shown as him.
 *
 * The renderer here paints every cell of the area it is given, so anything it was handed beyond
 * the body would be overwritten on screen. The actions object is also checked here: features key
 * their caches on it, so it is one object across snapshots.
 */
import { describe, expect, it } from 'vitest';
import { registerMessageRenderer } from '../../src/app/registry.ts';
import type { Grid } from '../../src/grid/grid.ts';
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
  summary,
  type,
} from './harness.ts';
import { busyWorld } from './worlds.ts';

registerMessageRenderer({
  kind: 'message',
  match: (r) => r.text.startsWith('PLUG'),
  measure: () => 2,
  draw(g, area) {
    g.fill(area, { ch: '#' });
    g.text(area.x, area.y, '«plugin»', {}, area.w);
  },
});

/**
 * Like an image: one row ("image loading…") until its raster decodes, then the raster's rows. The
 * stream must take the new height on the next frame (finish review: images stuck one row tall).
 */
let decoded = false;
registerMessageRenderer({
  kind: 'message',
  match: (r) => r.text.startsWith('GROW'),
  measure: () => (decoded ? 6 : 1),
  draw(g, area) {
    for (let i = 0; i < (decoded ? 6 : 1) && i < area.h; i++)
      g.text(area.x, area.y + i, `«row ${i}»`, {}, area.w);
  },
});

const text = (g: Grid) => lines(g).join('\n');
const rowOf = (g: Grid, s: string) => {
  const p = find(g, s);
  if (p === undefined) throw new Error(`"${s}" is not on screen:\n${text(g)}`);
  return p.y;
};

function world() {
  return {
    channels: [summary('commons', { unread: 0, messages: 3 })],
    records: {
      commons: [
        // Claims to be Trey (from his room) from another participant, signature not yet checked.
        record({
          minutes: 40,
          seq: 1,
          from: 'mara',
          participant: 'porch-x',
          signed: true,
          body: 'PLUG a chart',
        }),
        // Fails its signature check, and replies to the first.
        record({
          minutes: 41,
          seq: 2,
          from: 'mara',
          participant: 'porch-x',
          signed: true,
          re: idAt(40, 1),
          body: 'PLUG another chart',
        }),
        record({ minutes: 42, seq: 3, body: 'PLUG from bolt' }),
      ],
    },
    verdicts: {
      commons: {
        [idAt(40, 1)]: { state: 'unknown' as const, reason: 'no sidecar yet' },
        [idAt(41, 2)]: { state: 'failed' as const, reason: 'bad signature' },
      },
    },
  };
}

describe.each(SIZES)('a plug-in renderer at $name', ({ cols, rows }) => {
  it('gets only the body: the core keeps "claims Mara", the badges and the reply line', async () => {
    const app = await makeApp(world());
    const g = frame(app, cols, rows);
    const all = text(g);
    // Precondition: the plug-in drew the bodies on screen.
    expect(all.split('«plugin»').length - 1, all).toBeGreaterThanOrEqual(2);
    // Failed: the banner and "claims Mara ... ✗ FAILED", then the reply line, then the body.
    expect(all).toContain('SIGNATURE FAILED');
    const failed = lines(g).findIndex(
      (l) => l.includes('claims Mara 21:41') && l.includes('✗ FAILED'),
    );
    expect(failed, all).toBeGreaterThanOrEqual(0);
    expect(lines(g)[failed + 1], all).toContain('↳ re');
    expect(lines(g)[failed + 2]).toContain('«plugin»');
    // An ordinary sender keeps the core's header too.
    expect(lines(g)[rowOf(g, '21:42')]).toContain('Bolt');
    expect(lines(g)[rowOf(g, '21:42') + 1], all).toContain('«plugin»');
    // Unchecked owner claim, at the top of the history: the core's sender line and badge, above
    // the plug-in's body.
    press(app, key('pageup'));
    press(app, key('pageup'));
    const top = frame(app, cols, rows);
    const unknown = lines(top).findIndex(
      (l) => l.includes('claims Mara') && l.includes('? UNVERIFIED'),
    );
    expect(unknown, text(top)).toBeGreaterThanOrEqual(0);
    // The claim is never clipped; on the phone the time gives way to it.
    expect(lines(top)[unknown]).toContain(
      cols < 60 ? 'claims Mara ? UNVERIFIED' : 'claims Mara 21:40 ? UNVERIFIED',
    );
    expect(lines(top)[unknown + 1]).toContain('«plugin»');
  });
});

describe('a long name for Trey on the phone', () => {
  it('is never clipped out of a claim: the claim keeps the line before the badge does', async () => {
    const app = await makeApp({ ...world(), ownerLabel: 'Bartholomew' });
    press(app, key('pageup'));
    press(app, key('pageup'));
    const g = frame(app, 40, 52);
    const header = lines(g).find((l) => l.includes('claims Barth') && l.includes('┊'));
    expect(header, text(g)).toBeDefined();
    expect(header).toContain('claims Bartholomew ?');
  });
});

describe('the actions object', () => {
  it('is the same object in every snapshot, across changes', async () => {
    const app = await makeApp(busyWorld());
    const first = app.m.state();
    type(app, 'something new');
    await app.m.openChannel('ops');
    const second = app.m.state();
    // Precondition: these are two different snapshots.
    expect(second).not.toBe(first);
    expect(second.current).toBe('ops');
    expect(second.actions).toBe(first.actions);
  });
});

describe('a feature body that changes height after it first draws', () => {
  it('is measured afresh: a decoded image takes its raster rows on the next frame', async () => {
    decoded = false;
    const app = await makeApp({
      channels: [summary('commons', { unread: 0, messages: 2 })],
      records: {
        commons: [
          record({ minutes: 40, seq: 1, body: 'GROW probe.png' }),
          record({ minutes: 41, seq: 2, from: 'nova', body: 'after the image' }),
        ],
      },
    });
    const before = frame(app, 100, 32);
    // Precondition: the loading row is on screen and the rest of the body is not.
    expect(text(before)).toContain('«row 0»');
    expect(text(before)).not.toContain('«row 1»');
    decoded = true;
    const after = frame(app, 100, 32);
    for (let i = 0; i < 6; i++) expect(text(after), `row ${i}`).toContain(`«row ${i}»`);
    // The next message sits below the whole body, not over its lower rows.
    expect(rowOf(after, 'after the image')).toBeGreaterThan(rowOf(after, '«row 5»'));
    decoded = false;
  });
});
