/**
 * The overlay lane (plan T7): help, the quick switcher, the channel browser with its archived view,
 * and search, each drawn at the three capture sizes and driven by keys through a recording app.
 * Importing the lane's index registers everything with the registry, as plugins.ts will.
 */
import type { DisplayRecord, Presence, RawRecord, Result, SearchHit } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import { createBrowser } from '../../src/app/overlays/browser.ts';
import { commandHelp, createHelp, KEYS, LEGEND } from '../../src/app/overlays/help.ts';
import {
  BROWSER,
  browser,
  HELP,
  help,
  SEARCH,
  SWITCHER,
  search,
  switcher,
} from '../../src/app/overlays/index.ts';
import { scrollFor, typed } from '../../src/app/overlays/kit.ts';
import {
  createSearch,
  hit,
  postSearch,
  type SearchSource,
  snippet,
  windowHits,
} from '../../src/app/overlays/search.ts';
import { createSwitcher, matches } from '../../src/app/overlays/switcher.ts';
import {
  allCommands,
  command,
  type Key,
  keyBindings,
  type Overlay,
  overlay,
} from '../../src/app/registry.ts';
import type { AppState } from '../../src/app/state.ts';
import { Grid } from '../../src/grid/grid.ts';
import { ANCHOR, GROUND, lines, message, Rig, summary } from '../stage/rig.ts';

const SIZES = [
  [40, 52],
  [100, 32],
  [160, 44],
] as const;
const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});
const ch = (c: string): Key => key(c, { text: c });
const flush = () => new Promise((r) => setTimeout(r, 0));

function draw(o: Overlay, s: AppState, cols: number, rows: number): string {
  const g = new Grid(cols, rows, GROUND);
  o.draw(g, { x: 0, y: 0, w: cols, h: rows }, s);
  return lines(g).join('\n');
}

function channelsRig(): Rig {
  const rig = new Rig();
  rig.channels = [
    summary('commons', ['porch-trey', 'p-bolt', 'p-wisp'], {
      unread: 3,
      messages: 210,
      description: 'the main room',
    }),
    summary('ops', ['porch-trey', 'p-bolt'], { messages: 40 }),
    summary('design-crit', ['porch-trey'], { unread: 1, messages: 9 }),
    summary('old-launch', ['porch-trey'], { archived: true, messages: 77 }),
  ];
  rig.names.set('p-bolt', 'Bolt');
  rig.names.set('p-wisp', 'Wisp');
  rig.views.set('ops', {
    ...(rig.views.get('ops') ?? {
      name: 'ops',
      summary: undefined,
      records: [],
      acknowledged: undefined,
      divider: undefined,
      newCount: 0,
      trend: 'flat',
      top: 'beginning',
      detached: false,
      error: undefined,
    }),
    needsYou: true,
  });
  return rig;
}

describe('registration', () => {
  it('registers four overlays, three chords and /search', () => {
    expect(overlay(HELP)).toBe(help);
    expect(overlay(SWITCHER)).toBe(switcher);
    expect(overlay(BROWSER)).toBe(browser);
    expect(overlay(SEARCH)).toBe(search);
    expect(keyBindings('chord').map((b) => b.id)).toEqual([
      'overlays:switcher',
      'overlays:browser',
      'overlays:search',
    ]);
    expect(command('search')?.needsChannel).toBe(true);
  });

  it('each chord opens its overlay fresh and passes every other key', () => {
    const rig = channelsRig();
    const s = rig.state();
    const [k, b, f] = keyBindings('chord');
    expect(k?.key(key('k', { ctrl: true }), s)).toBe('handled');
    expect(rig.overlay).toBe(SWITCHER);
    expect(b?.key(key('b', { ctrl: true }), s)).toBe('handled');
    expect(rig.overlay).toBe(BROWSER);
    expect(f?.key(key('f', { ctrl: true }), s)).toBe('handled');
    expect(rig.overlay).toBe(SEARCH);
    for (const other of [
      ch('k'),
      key('k', { ctrl: true, shift: true }),
      key('k', { ctrl: true, alt: true }),
    ])
      for (const binding of keyBindings('chord')) expect(binding.key(other, s)).toBe('pass');
  });

  it('/search opens search and runs it in the current channel', async () => {
    const rig = channelsRig();
    let opened: string | undefined;
    await command('search')?.run('  ', {
      state: rig.state(),
      send: async () => {
        throw new Error('no send');
      },
      status: () => {},
      openOverlay: (id) => {
        opened = id;
      },
    });
    expect(opened).toBe(SEARCH);
    // Blank words leave it waiting for typing (no post client here, so a run would fail).
    expect(draw(search, rig.state(), 100, 32)).toContain('type words, then Enter');
    await command('search')?.run('parser', {
      state: rig.state(),
      send: async () => {
        throw new Error('no send');
      },
      status: () => {},
      openOverlay: () => {},
    });
    await flush();
    expect(draw(search, rig.state(), 100, 32)).toContain('post is not connected');
  });
});

describe('help', () => {
  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: keys, the legend in words, and every command`, () => {
      const o = createHelp();
      const rig = channelsRig();
      const text = draw(o, rig.state(cols, rows), cols, rows);
      expect(text).toContain('HOW TO PLAY');
      expect(text).toContain('KEYS');
      expect(text).toContain(KEYS[0]?.[0] ?? '');
      // Wide screens show it all at once; on a phone the wrapped card scrolls to the legend and
      // the commands.
      let end = text;
      let seen = text;
      for (let i = 0; i < 80 && end.includes('↓ more'); i++) {
        o.key(key('down'), rig.state(cols, rows));
        end = draw(o, rig.state(cols, rows), cols, rows);
        seen += `\n${end}`;
      }
      for (const [, , name] of LEGEND) expect(seen).toContain(name);
      if (cols >= 100) for (const [, , name] of LEGEND) expect(text).toContain(name);
      expect(end).toContain('/search');
      if (cols >= 100) expect(text).toContain('/search');
    });

  for (const [cols, rows] of [
    [40, 52],
    [40, 20],
  ] as const)
    it(`${cols}x${rows}: nothing is cut off; long labels split and descriptions wrap`, () => {
      const o = createHelp();
      const rig = channelsRig();
      const s = rig.state(cols, rows);
      const frames: string[] = [];
      for (let i = 0; i < 120; i++) {
        frames.push(draw(o, s, cols, rows));
        o.key(key('down'), s);
      }
      for (const f of frames) expect(f).not.toContain('…');
      expect(frames.at(-1)).not.toContain('↓ more');
      const lines = new Set(frames.flatMap((f) => f.split('\n')));
      const words = new Set([...lines].flatMap((l) => l.split(/[\s│┃║┆]+/)));
      const all = [
        ...KEYS.flat(),
        ...LEGEND.flatMap(([, , name, what]) => [name, what]),
        ...allCommands().flatMap((c) => {
          const { form, what } = commandHelp(c.usage);
          return [`/${c.name}`, form, what];
        }),
      ];
      for (const text of all)
        for (const w of text.split(/\s+/).filter((x) => x !== ''))
          expect(words.has(w), `${JSON.stringify(w)} of ${JSON.stringify(text)}`).toBe(true);
      // Every key carries its action: beside it, or on the line under it when the key is long.
      const rowsOf = frames.flatMap((f) => f.split('\n'));
      for (const [k, what] of KEYS) {
        const start = what.split(/\s+/).slice(0, 2).join(' ');
        const at = rowsOf.findIndex(
          (l, i) => l.includes(k) && (l.includes(start) || (rowsOf[i + 1] ?? '').includes(start)),
        );
        expect(at, `${k} → ${what}`).toBeGreaterThanOrEqual(0);
      }
    });

  it('scrolls to the end on a short screen, and closes on Esc, F1 or ?', () => {
    const o = createHelp();
    const rig = channelsRig();
    const s = rig.state(40, 20);
    expect(draw(o, s, 40, 20)).toContain('↓ more');
    for (let i = 0; i < 80; i++) o.key(key('down'), s);
    const end = draw(o, s, 40, 20);
    expect(end).toContain('/search');
    expect(end).not.toContain('↓ more');
    o.key(key('pageup'), s);
    for (const close of [key('escape'), key('f1'), ch('?')]) {
      rig.overlay = HELP;
      expect(o.key(close, s)).toBe('handled');
      expect(rig.overlay).toBeUndefined();
    }
    expect(o.key(ch('x'), s)).toBe('handled');
  });
});

describe('quick switcher', () => {
  it('filters live channels, prefix matches first, archived left out', () => {
    const rig = channelsRig();
    expect(matches(rig.channels, '').map((c) => c.name)).toEqual(['commons', 'ops', 'design-crit']);
    expect(matches(rig.channels, 'o').map((c) => c.name)).toEqual(['ops', 'commons']);
    expect(matches(rig.channels, 'LAUNCH')).toEqual([]);
  });

  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: rows say unread and NEEDS YOU in words, the selection is marked`, () => {
      const o = createSwitcher();
      const rig = channelsRig();
      const text = draw(o, rig.state(cols, rows), cols, rows);
      expect(text).toContain('STAGE SELECT');
      expect(text).toContain('▶ #commons');
      expect(text).toContain('3 new');
      expect(text).toContain('!! NEEDS YOU');
      expect(text).not.toContain('old-launch');
    });

  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: a channel Trey has not joined says "not joined" in words, and still opens`, () => {
      const o = createSwitcher();
      const rig = channelsRig();
      rig.channels = [
        ...rig.channels,
        summary('lobby', ['p-bolt'], { unread: undefined, messages: 12 }),
      ];
      const s = rig.state(cols, rows);
      const text = draw(o, s, cols, rows);
      const lobby = text.split('\n').find((l) => l.includes('#lobby')) ?? '';
      expect(lobby).toContain('not joined');
      // Only the unjoined channel carries it.
      expect(text.split('not joined')).toHaveLength(2);
      for (const c of 'lobby') o.key(ch(c), s);
      rig.overlay = SWITCHER;
      o.key(key('return'), s);
      expect(rig.calls.filter((c) => c.action === 'openChannel')).toEqual([
        { action: 'openChannel', args: ['lobby'] },
      ]);
    });

  it('typing, ↑↓ and Enter open the chosen channel; Esc closes without opening', () => {
    const o = createSwitcher();
    const rig = channelsRig();
    const s = rig.state();
    for (const c of 'de') o.key(ch(c), s);
    expect(draw(o, s, 100, 32)).toContain('▶ #design-crit');
    o.key(key('backspace'), s);
    o.key(key('backspace'), s);
    o.key(key('down'), s);
    o.key(key('down'), s);
    o.key(key('up'), s);
    rig.overlay = SWITCHER;
    o.key(key('return'), s);
    expect(rig.overlay).toBeUndefined();
    expect(rig.calls.filter((c) => c.action === 'openChannel')).toEqual([
      { action: 'openChannel', args: ['ops'] },
    ]);
    rig.overlay = SWITCHER;
    for (const c of 'zzz') o.key(ch(c), s);
    expect(draw(o, s, 100, 32)).toContain('no channel matches "zzz"');
    o.key(key('return'), s);
    expect(rig.calls.filter((c) => c.action === 'openChannel')).toHaveLength(1);
    o.key(key('escape'), s);
    expect(rig.overlay).toBeUndefined();
    // Esc resets the filter.
    expect(draw(o, s, 100, 32)).toContain('▶ #commons');
  });
});

describe('channel browser', () => {
  function fakeDeps(opts: { fail?: boolean } = {}) {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const presence: Presence = {
      who: [
        {
          id: 'p-bolt',
          room: 'bolt',
          harness: 'claude',
          liveWatch: true,
          leaseActive: true,
          lastSeen: undefined,
        },
        {
          id: 'p-wisp',
          room: 'wisp',
          harness: 'codex',
          liveWatch: false,
          leaseActive: true,
          lastSeen: undefined,
        },
      ] as Presence['who'],
      profiles: new Map(),
      skipped: [],
    };
    const ok = <T>(value: T): Result<T> => ({ ok: true, value });
    const result = (): Result<void> =>
      opts.fail
        ? { ok: false, error: { code: 'post', message: 'locked', retryable: true } }
        : ok(undefined);
    return {
      calls,
      release: () => release?.(),
      deps: {
        presence: async () => {
          calls.push('presence');
          return ok(presence);
        },
        archive: async (_s: AppState, c: string) => {
          calls.push(`archive ${c}`);
          await gate;
          return result();
        },
        unarchive: async (_s: AppState, c: string) => {
          calls.push(`unarchive ${c}`);
          await gate;
          return result();
        },
      },
    };
  }

  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: channels, and the chosen one's members live or away in words`, async () => {
      const f = fakeDeps();
      const o = createBrowser(f.deps);
      const rig = channelsRig();
      const s = rig.state(cols, rows);
      expect(draw(o, s, cols, rows)).toContain('reading presence…');
      await flush();
      const text = draw(o, s, cols, rows);
      expect(text).toContain('CHANNELS');
      expect(text).toContain('▶ #commons');
      expect(text).toContain('!!');
      expect(text).not.toContain('old-launch');
      expect(text).toContain('1 of 2 live');
      expect(text).toMatch(/● Bolt live/);
      expect(text).toMatch(/○ Wisp away/);
      expect(f.calls.filter((c) => c === 'presence')).toHaveLength(1);
    });

  it('Ctrl+A archives through post and reports it; the listing is not changed by hand', async () => {
    const f = fakeDeps();
    const o = createBrowser(f.deps);
    const rig = channelsRig();
    const s = rig.state();
    draw(o, s, 100, 32);
    o.key(key('down'), s);
    o.key(key('a', { ctrl: true }), s);
    o.key(key('a', { ctrl: true }), s); // busy: not sent twice
    expect(f.calls).toContain('archive ops');
    expect(f.calls.filter((c) => c.startsWith('archive'))).toHaveLength(1);
    expect(draw(o, s, 100, 32)).toContain('archiving #ops…');
    f.release();
    await flush();
    await flush();
    const statuses = rig.calls.filter((c) => c.action === 'status').map((c) => c.args);
    expect(statuses).toEqual([['archiving #ops…'], ['archived #ops: history is kept', 'good']]);
    expect(rig.channels.find((c) => c.name === 'ops')?.archived).toBe(false);
  });

  it('the archived view lists archived channels; Ctrl+A restores; a failure says why', async () => {
    const f = fakeDeps({ fail: true });
    const o = createBrowser(f.deps);
    const rig = channelsRig();
    const s = rig.state();
    draw(o, s, 100, 32);
    o.key(key('t', { ctrl: true }), s);
    const text = draw(o, s, 100, 32);
    expect(text).toContain('ARCHIVED');
    expect(text).toContain('▶ #old-launch');
    expect(text).not.toContain('#commons');
    o.key(key('a', { ctrl: true }), s);
    f.release();
    await flush();
    await flush();
    expect(rig.calls.filter((c) => c.action === 'status').at(-1)?.args).toEqual([
      'could not restore #old-launch: locked',
      'warning',
    ]);
  });

  it('Enter or → opens the chosen channel, archived ones too; Esc closes', () => {
    const o = createBrowser(fakeDeps().deps);
    const rig = channelsRig();
    const s = rig.state();
    draw(o, s, 100, 32);
    o.key(key('down'), s);
    o.key(key('right'), s);
    expect(rig.calls.filter((c) => c.action === 'openChannel').map((c) => c.args[0])).toEqual([
      'ops',
    ]);
    draw(o, s, 100, 32);
    o.key(key('t', { ctrl: true }), s);
    o.key(key('return'), s);
    expect(rig.calls.filter((c) => c.action === 'openChannel').map((c) => c.args[0])).toEqual([
      'ops',
      'old-launch',
    ]);
    rig.overlay = BROWSER;
    o.key(key('escape'), s);
    expect(rig.overlay).toBeUndefined();
  });

  it('closed before presence or an archive finishes: no frame is asked for, the result is dropped', async () => {
    let answer: ((r: Result<Presence>) => void) | undefined;
    let archived: ((r: Result<void>) => void) | undefined;
    const o = createBrowser({
      presence: () =>
        new Promise((r) => {
          answer = r;
        }),
      archive: () =>
        new Promise((r) => {
          archived = r;
        }),
      unarchive: async () => ({ ok: true, value: undefined }),
    });
    const rig = channelsRig();
    const s = rig.state();
    rig.overlay = BROWSER;
    draw(o, s, 100, 32);
    o.key(key('a', { ctrl: true }), s);
    expect(answer).toBeDefined();
    expect(archived).toBeDefined();
    o.key(key('escape'), s);
    expect(rig.overlay).toBeUndefined();
    const frames = rig.frames;
    answer?.({
      ok: true,
      value: {
        who: [{ id: 'p-bolt', liveWatch: true }] as Presence['who'],
        profiles: new Map(),
        skipped: [],
      },
    });
    archived?.({ ok: true, value: undefined });
    await flush();
    await flush();
    expect(rig.frames).toBe(frames);
    // The archive's outcome still reaches the status line, which the core draws.
    expect(rig.calls.filter((c) => c.action === 'status').at(-1)?.args[0]).toBe(
      'archived #commons: history is kept',
    );
    // Opened again, it reads presence afresh rather than showing the dropped answer.
    expect(draw(o, s, 100, 32)).toContain('reading presence…');
  });

  it('open, a presence answer asks for exactly one frame', async () => {
    const o = createBrowser(fakeDeps().deps);
    const rig = channelsRig();
    draw(o, rig.state(), 100, 32);
    const frames = rig.frames;
    await flush();
    await flush();
    expect(rig.frames).toBe(frames + 1);
  });

  it('without a post client, presence says it is unavailable', async () => {
    const o = createBrowser();
    const rig = channelsRig();
    draw(o, rig.state(), 100, 32);
    await flush();
    expect(draw(o, rig.state(), 100, 32)).toContain('presence unavailable: post is not connected');
  });
});

describe('search', () => {
  it('matches a literal, case-insensitive substring of message text only', () => {
    const r = message('bolt', 'Fixing the PARSER (v2.*)').raw;
    expect(hit(r, 'parser')).toBe(true);
    expect(hit(r, '(v2.*)')).toBe(true);
    expect(hit(r, 'v2.+')).toBe(false);
    expect(hit(message('bolt', 'parser', { extra: { event: 'join' } }).raw, 'parser')).toBe(false);
    expect(hit({ ...r, file: 'emote' } as RawRecord, 'parser')).toBe(false);
  });

  it('cuts the snippet so the match shows', () => {
    const [a, m, b] = snippet(`${'x'.repeat(80)} the needle here and more after`, 'NEEDLE', 30);
    expect(m).toBe('needle');
    expect(a.startsWith('…')).toBe(true);
    expect((a + m + b).length).toBeLessThanOrEqual(30);
    expect(snippet('first\nsecond has it', 'has', 40)).toEqual(['second ', 'has', ' it']);
  });

  const records = [
    message('bolt', 'the parser is fixed'),
    message('wisp', 'unrelated'),
    message('trey', 'is the PARSER shipping?'),
  ];
  const source =
    (calls: string[]): SearchSource =>
    async (_s, channel, query) => {
      calls.push(`${channel}:${query}`);
      const hits = records.filter((r) => hit(r.raw, query)).reverse();
      return { ok: true, value: { hits, truncated: false, limit: 1000 } };
    };

  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: type, Enter runs, hits newest first with the match marked`, async () => {
      const calls: string[] = [];
      const o = createSearch(source(calls));
      const rig = channelsRig();
      const s = rig.state(cols, rows);
      for (const c of 'parser') o.key(ch(c), s);
      expect(draw(o, s, cols, rows)).toContain('#commons ▸ parser');
      o.key(key('return'), s);
      expect(draw(o, s, cols, rows)).toContain('searching #commons…');
      await flush();
      const text = draw(o, s, cols, rows);
      expect(calls).toEqual(['commons:parser']);
      expect(text).toContain('2 matches, newest first');
      const at = text.indexOf('PARSER');
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(text.indexOf('parser is fixed'));
      // The match is underlined and bold.
      const g = new Grid(cols, rows, GROUND);
      o.draw(g, { x: 0, y: 0, w: cols, h: rows }, s);
      let underlined = '';
      g.forEachCell((c) => {
        if (c.underline) underlined += c.ch;
      });
      expect(underlined.toLowerCase()).toContain('parser');
    });

  it('Enter on a hit closes and jumps to it; ↑↓ choose; editing goes back to typing', async () => {
    const o = createSearch(source([]));
    const rig = channelsRig();
    const s = rig.state();
    for (const c of 'parser') o.key(ch(c), s);
    o.key(key('return'), s);
    await flush();
    o.key(key('down'), s);
    o.key(key('down'), s);
    o.key(key('up'), s);
    o.key(key('down'), s);
    rig.overlay = SEARCH;
    o.key(key('return'), s);
    expect(rig.overlay).toBeUndefined();
    expect(rig.calls.filter((c) => c.action === 'jumpTo')).toEqual([
      { action: 'jumpTo', args: ['commons', records[0]?.raw.id] },
    ]);
    // Fresh again after the jump.
    expect(draw(o, s, 100, 32)).toContain('type words, then Enter');
    for (const c of 'parser') o.key(ch(c), s);
    o.key(key('return'), s);
    await flush();
    o.key(ch('s'), s);
    expect(draw(o, s, 100, 32)).toContain('Enter searches the whole channel');
  });

  it('a failure says why; a stale result never replaces a newer search', async () => {
    let resolveSlow: ((r: Awaited<ReturnType<SearchSource>>) => void) | undefined;
    const o = createSearch((_s, _c, q) =>
      q === 'slow'
        ? new Promise((r) => {
            resolveSlow = r;
          })
        : Promise.resolve({
            ok: false,
            error: { code: 'post', message: 'history unreadable', retryable: false },
          }),
    );
    const rig = channelsRig();
    const s = rig.state();
    o.run('slow', s);
    o.key(key('escape'), s);
    o.run('fast', s);
    await flush();
    expect(draw(o, s, 100, 32)).toContain('search failed: history unreadable');
    resolveSlow?.({ ok: true, value: { hits: records, truncated: false, limit: 1000 } });
    await flush();
    expect(draw(o, s, 100, 32)).toContain('search failed: history unreadable');
  });

  it('with no channel open it says so instead of searching', () => {
    const calls: string[] = [];
    const o = createSearch(source(calls));
    const rig = channelsRig();
    rig.current = undefined;
    o.run('parser', rig.state());
    expect(calls).toEqual([]);
    expect(draw(o, rig.state(), 100, 32)).toContain('open a channel to search it');
  });

  /** A client whose `search` answers like post's: given hits, newest first, maybe truncated. */
  function searchClient(answer: (q: string) => { hits: SearchHit[]; truncated: boolean }) {
    const calls: { channel: string; query: string; signal: AbortSignal | undefined }[] = [];
    const client = {
      owner: ANCHOR,
      search: async (channel: string, query: string, opts: { signal?: AbortSignal } = {}) => {
        calls.push({ channel, query, signal: opts.signal });
        return { ok: true, value: { ...answer(query), limit: 1000 } };
      },
    };
    return { calls, post: { client } as unknown as AppState['post'] };
  }
  const postHit = (r: DisplayRecord, preview = r.text): SearchHit => ({
    channel: 'commons',
    id: r.raw.id,
    from: r.raw.from,
    fromParticipant: r.raw.fromParticipant,
    displayName: undefined,
    sent: r.raw.sent,
    preview,
    matched: ['body'],
  });

  it("the default source asks post, keeps window verdicts, and never labels an unchecked hit from Trey's room as Trey", async () => {
    const rig = channelsRig();
    const inWindow = message('bolt', 'needle in the window', {
      verdict: { state: 'unknown', reason: 'window' },
    });
    const older = message('trey', 'an old needle, outside the window');
    const newest = message('wisp', 'the newest needle');
    rig.load('commons', [inWindow]);
    const { calls, post } = searchClient(() => ({
      hits: [postHit(newest), postHit(inWindow, 'preview only'), postHit(older)],
      truncated: false,
    }));
    const s = rig.state(100, 32, { post });
    const ac = new AbortController();
    const r = await postSearch(s, 'commons', 'NEEDLE', ac.signal);
    if (!r.ok) throw new Error(r.error.message);
    expect(calls).toEqual([{ channel: 'commons', query: 'NEEDLE', signal: ac.signal }]);
    expect(r.value.truncated).toBe(false);
    expect(r.value.hits.map((h) => h.raw.id)).toEqual([
      newest.raw.id,
      older.raw.id,
      inWindow.raw.id,
    ]);
    // The window's record, verdict and full text, not post's preview.
    expect(r.value.hits[2]).toBe(inWindow);
    // Trey's room, outside the window, no signature check: a claim, not Trey.
    const trey = r.value.hits[1];
    expect(trey?.sender.isOwner).toBe(false);
    expect(trey?.sender.text).toContain('claims');
    expect(trey?.text).toBe('an old needle, outside the window');
    expect(r.value.hits[0]?.sender.isOwner).toBe(false);
    // Only the hits outside the window are preview-only.
    expect([...(r.value.partial ?? [])].sort()).toEqual([newest.raw.id, older.raw.id].sort());
  });

  it('reads the full body of a preview-only hit when it is on screen; Esc stops those reads', async () => {
    const long = message('bolt', `${'filler '.repeat(40)}the needle at the end`);
    const preview = { ...long, text: 'filler filler filler…' } as DisplayRecord;
    const reads: { id: string; signal: AbortSignal }[] = [];
    let answer: (() => void) | undefined;
    const o = createSearch(
      async () => ({
        ok: true,
        value: { hits: [preview], truncated: false, limit: 1000, partial: new Set([long.raw.id]) },
      }),
      (_s, _c, id, signal) =>
        new Promise((r) => {
          reads.push({ id, signal });
          answer = () => r({ ok: true, value: long });
        }),
    );
    const rig = channelsRig();
    rig.overlay = SEARCH;
    const s = rig.state();
    o.run('needle', s);
    await flush();
    expect(reads).toEqual([]);
    const before = draw(o, s, 100, 32);
    expect(before).toContain('filler filler filler');
    expect(before).not.toContain('needle at the end');
    await flush();
    expect(reads.map((r) => r.id)).toEqual([long.raw.id]);
    draw(o, s, 100, 32);
    await flush();
    expect(reads).toHaveLength(1); // one read per hit, not one per frame
    const frames = rig.frames;
    answer?.();
    await flush();
    expect(rig.frames).toBe(frames + 1);
    expect(draw(o, s, 100, 32)).toContain('needle at the end');

    // A second search: Esc while its body read runs aborts it and drops the answer.
    o.run('needle', s);
    await flush();
    draw(o, s, 100, 32);
    await flush();
    expect(reads).toHaveLength(2);
    const second = reads.at(-1);
    expect(second?.signal.aborted).toBe(false);
    o.key(key('escape'), s);
    expect(second?.signal.aborted).toBe(true);
    const after = rig.frames;
    answer?.();
    await flush();
    expect(rig.frames).toBe(after);
  });

  it('the window adds an exact message id and sender matches post does not make', async () => {
    const rig = channelsRig();
    const a = message('bolt', 'first thing');
    const b = message('wisp', 'second thing');
    const c = message('mochi', 'third thing');
    rig.load('commons', [a, b, c]);
    expect(windowHits([a, b, c], b.raw.id.toUpperCase())).toEqual([b]);
    expect(windowHits([a, b, c], 'P-MOCHI')).toEqual([c]);
    expect(windowHits([a, b, c], a.sender.text.slice(0, 3))).toContain(a);
    const { post } = searchClient(() => ({ hits: [], truncated: false }));
    const s = rig.state(100, 32, { post });
    const r = await postSearch(s, 'commons', b.raw.id, new AbortController().signal);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.hits).toEqual([b]);
    // A hit post and the window both make is listed once.
    const both = searchClient(() => ({ hits: [postHit(c)], truncated: false }));
    const r2 = await postSearch(
      rig.state(100, 32, { post: both.post }),
      'commons',
      'p-mochi',
      new AbortController().signal,
    );
    if (!r2.ok) throw new Error(r2.error.message);
    expect(r2.value.hits).toEqual([c]);
  });

  for (const [cols, rows] of SIZES)
    it(`${cols}x${rows}: at post's limit the overlay says to refine`, async () => {
      const rig = channelsRig();
      const many = Array.from({ length: 1000 }, (_, i) => message('bolt', `needle ${i}`));
      const { post } = searchClient(() => ({
        hits: many.map((m) => postHit(m)).reverse(),
        truncated: true,
      }));
      const s = rig.state(cols, rows, { post });
      const o = createSearch();
      o.run('needle', s);
      await flush();
      await flush();
      const text = draw(o, s, cols, rows);
      expect(text).toContain('1000+ matches; refine');
      expect(text).not.toContain('1000 matches');
      expect(text).toContain('needle 999');
    });

  it('Esc stops a running search: its signal aborts, its answer is dropped, no frame is asked for', async () => {
    let signal: AbortSignal | undefined;
    let answer: ((r: Awaited<ReturnType<SearchSource>>) => void) | undefined;
    const o = createSearch(
      (_s, _c, _q, sig) =>
        new Promise((r) => {
          signal = sig;
          answer = r;
        }),
    );
    const rig = channelsRig();
    rig.overlay = SEARCH;
    const s = rig.state();
    o.run('parser', s);
    await flush();
    expect(signal?.aborted).toBe(false);
    o.key(key('escape'), s);
    expect(signal?.aborted).toBe(true);
    expect(rig.overlay).toBeUndefined();
    const before = rig.frames;
    answer?.({ ok: true, value: { hits: records, truncated: false, limit: 1000 } });
    await flush();
    expect(rig.frames).toBe(before);
    expect(draw(o, s, 100, 32)).toContain('type words, then Enter');
    expect(draw(o, s, 100, 32)).not.toContain('parser');
  });

  it('editing away shown results stops their body reads: no frame is asked for afterwards', async () => {
    const long = message('bolt', `${'filler '.repeat(40)}the needle at the end`);
    const preview = { ...long, text: 'filler filler filler…' } as DisplayRecord;
    const reads: { signal: AbortSignal; answer: () => void }[] = [];
    const o = createSearch(
      async () => ({
        ok: true,
        value: { hits: [preview], truncated: false, limit: 1000, partial: new Set([long.raw.id]) },
      }),
      (_s, _c, _id, signal) =>
        new Promise((r) => {
          reads.push({ signal, answer: () => r({ ok: true, value: long }) });
        }),
    );
    const rig = channelsRig();
    const s = rig.state();
    for (const c of 'needle') o.key(ch(c), s);
    o.key(key('return'), s);
    await flush();
    draw(o, s, 100, 32);
    await flush();
    expect(reads).toHaveLength(1);
    const frames = rig.frames;
    o.key(ch('s'), s);
    expect(reads[0]?.signal.aborted).toBe(true);
    reads[0]?.answer();
    await flush();
    await flush();
    expect(rig.frames).toBe(frames);
    const text = draw(o, s, 100, 32);
    expect(text).toContain('Enter searches the whole channel');
    expect(text).not.toContain('needle at the end');
    await flush();
    expect(reads).toHaveLength(1);
  });

  it('editing while a search runs stops it; its answer never lands', async () => {
    let signal: AbortSignal | undefined;
    let answer: (() => void) | undefined;
    const o = createSearch(
      (_s, _c, _q, sig) =>
        new Promise((r) => {
          signal = sig;
          answer = () => r({ ok: true, value: { hits: records, truncated: false, limit: 1000 } });
        }),
    );
    const rig = channelsRig();
    const s = rig.state();
    for (const c of 'parser') o.key(ch(c), s);
    o.key(key('return'), s);
    await flush();
    const frames = rig.frames;
    o.key(key('backspace'), s);
    expect(signal?.aborted).toBe(true);
    answer?.();
    await flush();
    expect(rig.frames).toBe(frames);
    expect(draw(o, s, 100, 32)).not.toContain('2 matches');
  });

  it('a blank replacement search cancels the old one: the old answer cannot come back', async () => {
    let signal: AbortSignal | undefined;
    let answer: (() => void) | undefined;
    const o = createSearch(
      (_s, _c, _q, sig) =>
        new Promise((r) => {
          signal = sig;
          answer = () => r({ ok: true, value: { hits: records, truncated: false, limit: 1000 } });
        }),
    );
    const rig = channelsRig();
    const s = rig.state();
    o.run('parser', s);
    await flush();
    o.run('   ', s);
    expect(signal?.aborted).toBe(true);
    const frames = rig.frames;
    answer?.();
    await flush();
    expect(rig.frames).toBe(frames);
    expect(draw(o, s, 100, 32)).not.toContain('2 matches');
    // The same with no channel open.
    o.run('parser', s);
    await flush();
    const second = signal;
    rig.current = undefined;
    o.run('parser', rig.state());
    expect(second?.aborted).toBe(true);
    answer?.();
    await flush();
    expect(draw(o, rig.state(), 100, 32)).toContain('open a channel to search it');
  });

  it('a new search aborts the one still running', async () => {
    const signals: AbortSignal[] = [];
    const o = createSearch(
      (_s, _c, _q, sig) =>
        new Promise(() => {
          signals.push(sig);
        }),
    );
    const s = channelsRig().state();
    o.run('one', s);
    await flush();
    o.run('two', s);
    await flush();
    expect(signals.map((x) => x.aborted)).toEqual([true, false]);
  });

  it('help lists /search with its usage', () => {
    expect(allCommands().map((c) => c.name)).toContain('search');
  });
});

describe('kit', () => {
  it('typed text excludes controls and chords', () => {
    expect(typed(ch('a'))).toBe('a');
    expect(typed(key('space'))).toBe(' ');
    expect(typed(key('a', { ctrl: true }))).toBeUndefined();
    expect(typed(key('x', { text: '\u001b' }))).toBeUndefined();
    expect(typed(key('return'))).toBeUndefined();
  });

  it('scrollFor keeps the selection in view', () => {
    expect(scrollFor(0, 5, 20, 0)).toBe(0);
    expect(scrollFor(7, 5, 20, 0)).toBe(3);
    expect(scrollFor(2, 5, 20, 3)).toBe(2);
    expect(scrollFor(19, 5, 20, 99)).toBe(15);
  });
});
