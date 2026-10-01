/**
 * The mentions picker (task porch-cql.15): who it offers, how a row reads, and how a mention of a
 * participant is drawn. The world is the one Trey hit on 2026-10-01 in #porch-testing: Fern joined
 * the channel and took a profile name after Porch had booted, so the names loaded at boot did not
 * hold her.
 */
import { parseRoster } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import { showMentionNames, tildePath } from '../../src/app/derive.ts';
import type { Roster } from '../../src/app/model.ts';
import { K } from '../../src/app/theme.ts';
import type { Grid } from '../../src/grid/grid.ts';
import {
  type AppOptions,
  find,
  frame,
  idAt,
  key,
  lines,
  makeApp,
  press,
  record,
  settle,
  summary,
  type,
} from './harness.ts';

const FERN = 'loom-52b3dee9';
const LANTERN = 'loom-3e44517c';
const text = (g: Grid) => lines(g).join('\n');
const cellOf = (g: Grid, p: { x: number; y: number } | undefined) => {
  const cell = p === undefined ? undefined : g.at(p.x, p.y);
  if (cell === undefined) throw new Error(`not on screen:\n${text(g)}`);
  return cell;
};

/** #porch-testing as post lists it: participants only, no room but Trey's. */
function world(extra: AppOptions = {}): AppOptions {
  return {
    channels: [
      summary('porch-testing', {
        members: ['mara'],
        participants: [LANTERN, FERN, 'porch-7f3a9c'],
      }),
    ],
    records: { 'porch-testing': [] },
    launch: 'porch-testing',
    home: '/home/trey-agent',
    ...extra,
  };
}

/** What `post profile list` and `post participant list` give once Fern has a name. */
const FRESH: Roster = {
  names: new Map([
    [FERN, 'Fern'],
    [LANTERN, 'Lantern'],
  ]),
  places: new Map([[FERN, '/home/trey-agent/Code/porch']]),
  lineages: new Map(),
};

describe('mentions picker: who it offers', () => {
  it('finds a participant that took a name after boot, by that name', async () => {
    // Boot loaded no names: Fern was only an id then.
    let loads = 0;
    const app = await makeApp(
      world({
        loadRoster: async () => {
          loads += 1;
          return FRESH;
        },
      }),
    );
    type(app, '@Fe');
    await settle();
    expect(loads).toBe(1);
    expect(app.m.mentionCandidates().map((c) => c.insert)).toEqual([FERN]);
    expect(app.m.pickerOpen()).toBe(true);
  });

  it('reads the roster again when the picker opens, not on every keystroke', async () => {
    let loads = 0;
    let now = 1_000_000;
    const app = await makeApp(
      world({
        wallClock: () => now,
        loadRoster: async () => {
          loads += 1;
          return FRESH;
        },
      }),
    );
    type(app, '@F');
    await settle();
    type(app, 'e');
    press(app, key('escape'));
    press(app, key('backspace'));
    press(app, key('backspace'));
    press(app, key('backspace'));
    type(app, '@');
    await settle();
    expect(loads).toBe(1);
    now += 11_000;
    press(app, key('backspace'));
    type(app, '@');
    await settle();
    expect(loads).toBe(2);
  });

  it('keeps what it knows when the roster cannot be read', async () => {
    const app = await makeApp(
      world({
        names: new Map([[FERN, 'Fern']]),
        loadRoster: async () => {
          throw new Error('post is down');
        },
      }),
    );
    type(app, '@Fe');
    await settle();
    expect(app.m.mentionCandidates().map((c) => c.insert)).toEqual([FERN]);
  });

  it('matches the later words of a name', async () => {
    const app = await makeApp(world({ names: new Map([[FERN, 'Fern Bell']]) }));
    type(app, '@be');
    expect(app.m.mentionCandidates().map((c) => c.insert)).toEqual([FERN]);
  });
});

describe('mentions picker: how a row reads', () => {
  it('shows the name and not the id, and inserts the name (the id goes out on send)', async () => {
    const app = await makeApp(world({ names: FRESH.names, places: FRESH.places }));
    type(app, '@Fe');
    const t = text(frame(app, 100, 32));
    expect(t).toContain('Fern');
    expect(t).not.toContain(FERN);
    press(app, key('tab'));
    expect(app.m.composer().text).toBe('@Fern ');
    expect(app.m.composer().mentions).toEqual([{ start: 0, end: 5, id: FERN }]);
  });

  it('puts the working directory in gray parentheses, home as ~', async () => {
    const app = await makeApp(world({ names: FRESH.names, places: FRESH.places }));
    // Lantern is the first row and lit; Fern's row is not.
    type(app, '@');
    const g = frame(app, 100, 32);
    expect(text(g)).toContain('Fern (~/Code/porch)');
    const at = find(g, '(~/Code/porch)');
    if (at === undefined) throw new Error(text(g));
    expect(cellOf(g, at).fg).toBe(K.gray);
    // A participant with no directory gets a name and nothing after it.
    expect(text(g)).toMatch(/Lantern\s*│/);
  });

  it('reads on the lit row too: the directory takes the row colour, or stays plain in NO_COLOR', async () => {
    for (const noColor of [false, true]) {
      const app = await makeApp(world({ names: FRESH.names, places: FRESH.places, noColor }));
      type(app, '@Fe');
      const g = frame(app, 100, 32);
      const at = find(g, '(~/Code/porch)');
      if (at === undefined) throw new Error(text(g));
      const cell = cellOf(g, at);
      expect(cell.fg).not.toBe(cell.bg);
      if (noColor) expect(cellOf(g, find(g, 'Fern')).underline).toBe(true);
    }
  });

  it('falls back to the lineage, then to the id', async () => {
    const app = await makeApp(world({ lineages: new Map([[FERN, 'fable']]) }));
    type(app, '@');
    const t = text(frame(app, 100, 32));
    expect(t).toContain('fable');
    expect(t).toContain(LANTERN);
  });
});

describe('a mention of a participant in a message', () => {
  it('is drawn as the name; the stored body keeps the id', async () => {
    const body = `@${FERN} take this one`;
    const rec = record({
      minutes: 50,
      from: 'lantern',
      participant: LANTERN,
      body,
      channel: 'porch-testing',
    });
    const app = await makeApp(world({ names: FRESH.names, records: { 'porch-testing': [rec] } }));
    const t = text(frame(app, 100, 32));
    expect(t).toContain('@Fern take this one');
    expect(t).not.toContain(FERN);
    expect(rec.body).toBe(body);
    // And it still lights as a mention of someone else.
    const g = frame(app, 100, 32);
    const at = find(g, '@Fern');
    if (at === undefined) throw new Error(text(g));
    expect(cellOf(g, at).fg).toBe(K.violet);
    expect(idAt(50)).toBeDefined();
  });

  it('shows the name once the roster arrives, in messages already drawn', async () => {
    const rec = record({
      minutes: 50,
      from: 'mara',
      participant: 'porch-7f3a9c',
      body: `@${FERN} hi`,
    });
    const app = await makeApp(
      world({ records: { 'porch-testing': [rec] }, loadRoster: async () => FRESH }),
    );
    expect(text(frame(app, 100, 32))).toContain(`@${FERN} hi`);
    type(app, '@');
    await settle();
    expect(text(frame(app, 100, 32))).toContain('@Fern hi');
  });
});

describe('mention helpers', () => {
  it('shortens home to ~ only at a directory boundary', () => {
    expect(tildePath('/home/trey/Code/porch', '/home/trey')).toBe('~/Code/porch');
    expect(tildePath('/home/trey', '/home/trey')).toBe('~');
    expect(tildePath('/home/trey2/Code', '/home/trey')).toBe('/home/trey2/Code');
    expect(tildePath('/srv/x', undefined)).toBe('/srv/x');
  });

  it('renames only ids it has a name for, and not the ones it is told to skip', () => {
    const names = new Map([
      ['a-1', 'Fern'],
      ['me-1', 'Mara'],
    ]);
    expect(
      showMentionNames('hi @a-1, and @me-1 and @zz-9 and mail a@a-1', names, new Set(['me-1'])),
    ).toBe('hi @Fern, and @me-1 and @zz-9 and mail a@a-1');
  });

  it('reads workspace_path and lineage from post participant records', () => {
    const roster = parseRoster({
      ok: true,
      participants: [
        { id: 'claude-1', workspace_path: '/home/x/Code/atlas', lineage: 'fable' },
        { id: 'loom-52b3dee9', harness: 'loom' },
        { nope: true },
      ],
    });
    expect(roster?.get('claude-1')).toEqual({
      workspacePath: '/home/x/Code/atlas',
      lineage: 'fable',
      // No `runtime` on this record: the directory falls back to workspace_path.
      cwd: '/home/x/Code/atlas',
    });
    expect(roster?.get('loom-52b3dee9')).toEqual({
      workspacePath: undefined,
      lineage: undefined,
      cwd: undefined,
    });
    expect(roster?.size).toBe(2);
    expect(parseRoster({ ok: false })).toBeUndefined();
  });
});
