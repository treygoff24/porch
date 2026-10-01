/**
 * What a participant says about itself (`runtime`: model, effort, directory) and how Porch tells
 * participants apart with it: the mention picker's parenthetical, the tiebreaker for two
 * participants of one name, and the care taken with text other agents wrote. Fixtures have the
 * shape RUNTIME-SPEC.md gives `post participant list --json`.
 */
import { parseRoster } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import type { Roster } from '../../src/app/model.ts';
import { K } from '../../src/app/theme.ts';
import { runtimeLine, shortModel, tiebreaks, tiebreakText } from '../../src/app/who.ts';
import type { Grid } from '../../src/grid/grid.ts';
import { type AppOptions, find, frame, lines, makeApp, record, summary, type } from './harness.ts';

const FERN = 'loom-52b3dee9';
const FERN2 = 'loom-7a01b3dc';
const LANTERN = 'loom-3e44517c';
const HOME = '/home/trey-agent';
const CH = 'porch-testing';
/** Does `s` hold a control character other than a newline? */
const controls = (s: string) =>
  [...s].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return (n < 32 && n !== 10) || (n >= 127 && n <= 159);
  });
const text = (g: Grid) => lines(g).join('\n');

/** The wire shape: a participant with `runtime`, as `post participant list --json` lists it. */
function wire(participants: unknown[]) {
  return parseRoster({ ok: true, participants });
}

/** Boot-time roster maps from wire entries, the way `loadRoster` builds them. */
function rosterOf(participants: unknown[], names: [string, string][]): Roster {
  const parsed = wire(participants);
  const places = new Map<string, string>();
  const runtimes = new Map<string, { model?: string; effort?: string }>();
  for (const [id, e] of parsed ?? []) {
    if (e.cwd !== undefined) places.set(id, e.cwd);
    if (e.model !== undefined || e.effort !== undefined)
      runtimes.set(id, {
        ...(e.model === undefined ? {} : { model: e.model }),
        ...(e.effort === undefined ? {} : { effort: e.effort }),
      });
  }
  return { names: new Map(names), places, lineages: new Map(), runtimes };
}

function world(roster: Roster, extra: AppOptions = {}): AppOptions {
  return {
    channels: [
      summary('porch-testing', { members: ['mara'], participants: [LANTERN, FERN, FERN2] }),
    ],
    records: { 'porch-testing': [] },
    launch: 'porch-testing',
    home: HOME,
    names: roster.names,
    places: roster.places,
    lineages: roster.lineages,
    ...(roster.runtimes === undefined ? {} : { runtimes: roster.runtimes }),
    ...extra,
  };
}

describe('runtime on the wire', () => {
  it('reads model, effort and directory from runtime', () => {
    const r = wire([
      {
        id: FERN,
        workspace_path: '/home/x/old',
        runtime: {
          model: 'claude-opus-5-5',
          effort: 'high',
          cwd: '/home/trey-agent/Code/porch',
          updated: '2026-10-01T16:00:00Z',
        },
      },
    ]);
    expect(r?.get(FERN)).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      cwd: '/home/trey-agent/Code/porch',
      workspacePath: '/home/x/old',
    });
  });

  it('falls back to workspace_path for the directory when runtime has none', () => {
    const r = wire([
      { id: 'a-1', workspace_path: '/srv/a', runtime: { model: 'm', updated: 'x' } },
      { id: 'b-1', workspace_path: '/srv/b' },
      { id: 'c-1', runtime: { effort: 'low' } },
    ]);
    expect(r?.get('a-1')?.cwd).toBe('/srv/a');
    expect(r?.get('b-1')?.cwd).toBe('/srv/b');
    expect(r?.get('b-1')?.model).toBeUndefined();
    expect(r?.get('c-1')?.cwd).toBeUndefined();
    expect(r?.get('c-1')?.effort).toBe('low');
  });

  it('treats a malformed runtime as none', () => {
    const r = wire([
      { id: 'a-1', runtime: 'opus' },
      { id: 'b-1', runtime: ['x'] },
      { id: 'c-1', runtime: { model: 7, effort: null, cwd: {} } },
    ]);
    for (const id of ['a-1', 'b-1', 'c-1']) {
      expect(r?.get(id)).toMatchObject({
        model: undefined,
        effort: undefined,
        cwd: undefined,
      });
    }
  });

  it('strips controls and terminal sequences from runtime text, and clips huge values', () => {
    const r = wire([
      {
        id: 'x-1',
        runtime: {
          model: '\u001b[31mred\u001b[0m-model\u0007\u0000',
          effort: 'hi\u001b]0;pwned\u0007gh\r\nsecond line',
          cwd: `/tmp/${'d'.repeat(10_000)}`,
        },
      },
      { id: 'y-1', runtime: { model: 'm'.repeat(100_000), effort: '\u001b[2J' } },
    ]);
    const x = r?.get('x-1');
    expect(x?.model).toBe('red-model');
    expect(x?.effort).toBe('high second line');
    expect(x?.cwd?.length).toBeLessThanOrEqual(4096);
    expect(x?.cwd?.startsWith('/tmp/ddd')).toBe(true);
    const y = r?.get('y-1');
    expect([...(y?.model ?? '')].length).toBeLessThanOrEqual(64);
    expect(y?.effort).toBeUndefined();
    for (const v of [x?.model, x?.effort, x?.cwd, y?.model]) expect(controls(v ?? '')).toBe(false);
  });
});

describe('model and the parenthetical', () => {
  it('shortens a model id', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5.5');
    expect(shortModel('claude-opus-4-1-20250805')).toBe('opus-4.1');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5.5');
    expect(shortModel('gpt-5-codex')).toBe('gpt-5-codex');
    expect(shortModel('claude-')).toBe('claude-');
    expect(shortModel('o3-2025-04-16')).toBe('o3-2025-04-16');
  });

  it('keeps what is known and leaves the rest out; nothing known is empty', () => {
    const facts = { model: 'claude-opus-5-5', effort: 'high' };
    expect(runtimeLine('/home/trey-agent/Code/porch', facts, HOME)).toBe(
      '~/Code/porch · opus-5.5 · high',
    );
    expect(runtimeLine('/srv/x', { model: 'claude-opus-5-5' }, HOME)).toBe('/srv/x · opus-5.5');
    expect(runtimeLine(undefined, { effort: 'low' }, HOME)).toBe('low');
    expect(runtimeLine(undefined, undefined, HOME)).toBe('');
  });
});

describe('mention picker rows', () => {
  const full = rosterOf(
    [
      {
        id: FERN,
        runtime: {
          model: 'claude-opus-5-5',
          effort: 'high',
          cwd: '/home/trey-agent/Code/porch',
          updated: 'u',
        },
      },
      // Directory from workspace_path, model only.
      {
        id: LANTERN,
        workspace_path: '/home/trey-agent/Code/loom',
        runtime: { model: 'claude-sonnet-5-5' },
      },
    ],
    [
      [FERN, 'Fern'],
      [LANTERN, 'Lantern'],
    ],
  );

  it('shows directory, short model and effort in gray parentheses', async () => {
    const app = await makeApp(world(full));
    type(app, '@Fe');
    const g = frame(app, 100, 32);
    expect(text(g)).toContain('Fern (~/Code/porch · opus-5.5 · high)');
    const at = find(g, '(~/Code/porch');
    expect(at).toBeDefined();
    // Lit row (Fern is the only match): the hint takes the row colour and is not the name's bold.
    const cell = g.at(at?.x ?? 0, at?.y ?? 0);
    expect(cell?.fg).not.toBe(cell?.bg);
  });

  it('is gray on a row that is not lit, and partial knowledge drops only the unknown parts', async () => {
    const app = await makeApp(world(full));
    type(app, '@');
    const g = frame(app, 100, 32);
    const t = text(g);
    expect(t).toContain('Lantern (~/Code/loom · sonnet-5.5)');
    const at = find(g, '(~/Code/porch');
    expect(at && g.at(at.x, at.y)?.fg).toBe(K.gray);
  });

  it('draws no parentheses for a participant that told nothing', async () => {
    const app = await makeApp(world(rosterOf([], [[FERN, 'Fern']])));
    type(app, '@');
    const t = text(frame(app, 100, 32));
    expect(t).toContain('Fern');
    expect(t).not.toContain('(');
  });

  it('never draws control characters another agent put in its runtime', async () => {
    const hostile = rosterOf(
      [
        {
          id: FERN,
          runtime: {
            model: '\u001b[41mevil\u001b[0m',
            effort: '\u001b]0;x\u0007\u009b31mhigh',
            cwd: `/tmp/\u001b[2J${'z'.repeat(5000)}`,
          },
        },
      ],
      [[FERN, 'Fern']],
    );
    const app = await makeApp(world(hostile));
    type(app, '@');
    const g = frame(app, 100, 32);
    expect(text(g)).toContain('evil');
    expect(controls(text(g))).toBe(false);
    // Whatever it said, the row stays inside the picker.
    const row = lines(g).find((l) => l.includes('Fern')) ?? '';
    expect(row.trimEnd().endsWith('│')).toBe(true);
  });
});

describe('two participants with one name', () => {
  const bySame = (dirs: [string | undefined, string | undefined], withLantern = true): Roster =>
    rosterOf(
      [
        { id: FERN, ...(dirs[0] === undefined ? {} : { workspace_path: dirs[0] }) },
        { id: FERN2, ...(dirs[1] === undefined ? {} : { workspace_path: dirs[1] }) },
        { id: LANTERN, workspace_path: '/home/trey-agent/Code/loom' },
      ],
      [
        [FERN, 'Fern'],
        [FERN2, 'Fern'],
        ...(withLantern ? ([[LANTERN, 'Lantern']] as [string, string][]) : []),
      ],
    );
  const talk = [
    record({ minutes: 50, from: 'fern-a', participant: FERN, body: 'first words', channel: CH }),
    record({ minutes: 52, from: 'fern-b', participant: FERN2, body: 'second words', channel: CH }),
    record({
      minutes: 54,
      from: 'lantern',
      participant: LANTERN,
      body: 'third words',
      channel: CH,
    }),
  ];

  it('tells them apart by directory in bylines; the unique name stays bare', async () => {
    const roster = bySame([`${HOME}/Code/porch`, `${HOME}/Code/atlas`]);
    const app = await makeApp(world(roster, { records: { 'porch-testing': talk } }));
    const g = frame(app, 110, 32);
    const t = lines(g);
    expect(t.find((l) => l.includes('Fern') && l.includes('~/Code/porch'))).toBeDefined();
    expect(t.find((l) => l.includes('Fern') && l.includes('~/Code/atlas'))).toBeDefined();
    const lantern = t.find((l) => l.includes('Lantern'));
    expect(lantern).toBeDefined();
    expect(lantern).not.toContain('Code/loom');
    expect(lantern).not.toContain('·  ');
    // The directory is gray text, not the name's colour.
    const at = find(g, '~/Code/porch');
    expect(at && g.at(at.x, at.y)?.fg).toBe(K.gray);
  });

  it('adds the id tail when directories are equal or unknown', async () => {
    const same = bySame([`${HOME}/Code/porch`, `${HOME}/Code/porch`]);
    const a = await makeApp(world(same, { records: { 'porch-testing': talk } }));
    const t = text(frame(a, 120, 32));
    expect(t).toMatch(/Fern · ~\/Code\/porch · dee9/);
    expect(t).toMatch(/Fern · ~\/Code\/porch · b3dc/);

    const none = bySame([undefined, undefined]);
    const b = await makeApp(world(none, { records: { 'porch-testing': talk } }));
    const u = text(frame(b, 120, 32));
    expect(u).toMatch(/Fern · dee9/);
    expect(u).toMatch(/Fern · b3dc/);
  });

  it('does the same in the picker, and not for a unique name', async () => {
    const roster = bySame([`${HOME}/Code/porch`, `${HOME}/Code/porch`]);
    const app = await makeApp(world(roster));
    type(app, '@');
    const t = text(frame(app, 100, 32));
    expect(t).toContain('Fern (~/Code/porch · dee9)');
    expect(t).toContain('Fern (~/Code/porch · b3dc)');
    expect(t).toContain('Lantern (~/Code/loom)');

    const apart = await makeApp(world(bySame([`${HOME}/Code/porch`, `${HOME}/Code/atlas`])));
    type(apart, '@');
    const u = text(frame(apart, 100, 32));
    expect(u).toContain('Fern (~/Code/porch)');
    expect(u).toContain('Fern (~/Code/atlas)');

    const unknown = await makeApp(world(bySame([undefined, undefined])));
    type(unknown, '@');
    const v = text(frame(unknown, 100, 32));
    expect(v).toContain('Fern (dee9)');
    expect(v).toContain('Fern (b3dc)');
  });

  it('reads in NO_COLOR too', async () => {
    const roster = bySame([`${HOME}/Code/porch`, `${HOME}/Code/atlas`]);
    const app = await makeApp(world(roster, { records: { 'porch-testing': talk }, noColor: true }));
    const t = text(frame(app, 110, 32));
    expect(t).toContain('~/Code/porch');
    expect(t).toContain('~/Code/atlas');
  });
});

describe('the tiebreaker rule', () => {
  const p = (id: string, label: string, place?: string) => ({ id, label, place });

  it('gives nothing to unique names, case aside from nothing', () => {
    expect(tiebreaks([p('a-1', 'Fern'), p('b-2', 'Lantern')], HOME).size).toBe(0);
  });

  it('gives the directory, then the id tail when the directory is shared or unknown', () => {
    const t = tiebreaks(
      [
        p('a-1111', 'Fern', '/home/trey-agent/x'),
        p('b-2222', 'fern', '/home/trey-agent/y'),
        p('c-3333', 'Fern', '/home/trey-agent/y'),
        p('d-4444', 'Fern'),
      ],
      HOME,
    );
    expect(tiebreakText(t.get('a-1111'))).toBe('~/x');
    expect(tiebreakText(t.get('b-2222'))).toBe('~/y · 2222');
    expect(tiebreakText(t.get('c-3333'))).toBe('~/y · 3333');
    expect(tiebreakText(t.get('d-4444'))).toBe('4444');
  });
});

describe('long directories', () => {
  it('keep their tail, so the model and effort after them still show', () => {
    const long = `${HOME}/${'deep/'.repeat(30)}Code/porch`;
    const line = runtimeLine(long, { model: 'claude-opus-5-5', effort: 'high' }, HOME);
    expect(line.endsWith('/Code/porch · opus-5.5 · high')).toBe(true);
    expect(line.startsWith('…')).toBe(true);
    expect([...line].length).toBeLessThan(70);
  });
});
