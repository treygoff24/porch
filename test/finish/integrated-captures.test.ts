/**
 * The finish review's captures (`.impeccable/review/*.png`): the app with the real plug-ins loaded
 * (`src/app/plugins.ts`: the stage strip, the overlays, the features), at the three judged sizes.
 *
 * Every capture builds a fresh copy of the app's modules (`vi.resetModules`): the stage, overlays
 * and features are module singletons, and one capture's stage memory (channels it has seen, the
 * attract screen's first-launch state) must not leak into the next. The stage's first-launch marker
 * goes to a temporary `PORCH_STATE_DIR`, never `~/.local/state/porch-next`. Each frame is drawn at a
 * pinned clock an hour past start, so every burst begun at start has ended and the frame is at rest.
 *
 * Every run draws each state and checks its text says what the file name says; `PORCH_CAPTURE=1`
 * also writes the PNGs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from 'fast-png';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { captureGrid } from '../../scripts/capture.ts';
import { luminance, monochrome } from '../../src/grid/color.ts';
import type { Grid } from '../../src/grid/grid.ts';

const out = join(import.meta.dirname, '..', '..', '.impeccable', 'review');
const writing = process.env.PORCH_CAPTURE === '1';
const SIZES = [
  { name: 'phone', cols: 40, rows: 52 },
  { name: 'laptop', cols: 100, rows: 32 },
  { name: 'wide', cols: 160, rows: 44 },
] as const;
/** An hour past start: every burst the app began at time 0 has ended. */
const REST = 3_600_000;

let root = '';
let imagePath = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'porch-finish-'));
  // A probe frame, as a crew member would post one: a colour study with a lit sprite-like block.
  const w = 48;
  const h = 24;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lit = x > 16 && x < 32 && y > 6 && y < 18;
      data.set(
        lit
          ? [63, 217, 242, 255]
          : [Math.floor((40 * x) / w) + 5, Math.floor((30 * y) / h) + 8, 40, 255],
        i,
      );
    }
  mkdirSync(join(root, 'probe'));
  imagePath = join(root, 'probe', 'frame-100x32.png');
  writeFileSync(imagePath, encode({ width: w, height: h, data, channels: 4 }));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** A fresh app module graph with the real plug-ins, and a state dir that owes (or not) attract. */
async function fresh(opts: { attractOwed: boolean }) {
  const state = mkdtempSync(join(root, 'state-'));
  if (!opts.attractOwed) writeFileSync(join(state, 'attract-seen'), 'finish capture\n');
  process.env.PORCH_STATE_DIR = state;
  vi.resetModules();
  const h = await import('../app/harness.ts');
  const w = await import('../app/worlds.ts');
  await import('../../src/app/plugins.ts');
  return { h, w };
}

type Mods = Awaited<ReturnType<typeof fresh>>;

/** Post-kit services the features and search reach, over the world's records; nothing runs post. */
function services(m: Mods, commons: readonly import('@estate/post-kit').RawRecord[]) {
  const landed = commons.find(
    (r) => r.body === 'ship the sprite fix. tag it after the notes are in.',
  );
  if (landed === undefined) throw new Error('world lost the landed record');
  const stamp = (BigInt(Date.parse(landed.sent)) * 1_000_000n).toString().padStart(20, '0');
  const recovery = [
    {
      id: `${stamp}-landed`,
      channel: 'commons',
      text: 'ship the sprite fix. tag it after the notes are in.',
      reply_to: null,
    },
    {
      id: `${stamp}-missing`,
      channel: 'commons',
      text: 'hold the tag until the phone layout is checked on a real device',
      reply_to: null,
    },
  ];
  return {
    client: {
      owner: m.h.ANCHOR,
      async historyPage(channel: string) {
        return {
          ok: true,
          value: { messages: channel === 'commons' ? [...commons] : [], skipped: undefined },
        };
      },
      async message(_channel: string, id: string) {
        const r = commons.find((x) => x.id === id);
        return r === undefined
          ? {
              ok: false,
              error: { code: 'not_found', message: 'no such message', retryable: false },
            }
          : { ok: true, value: r };
      },
      async presence() {
        const row = (id: string, room: string, liveWatch: boolean) => ({
          id,
          room,
          harness: 'claude-code',
          liveWatch,
          leaseActive: true,
          lastSeen: undefined,
        });
        return {
          ok: true,
          value: {
            who: [row('test-bolt01', 'crew', true), row('test-nova02', 'nova', false)],
            profiles: new Map([
              ['test-bolt01', { name: 'Bolt', pfp: undefined }],
              ['test-nova02', { name: 'Nova', pfp: undefined }],
            ]),
            skipped: [],
          },
        };
      },
      async search(channel: string, pattern: string) {
        const hits = (channel === 'commons' ? commons : [])
          .filter((r) => r.body.toLowerCase().includes(pattern.toLowerCase()))
          .reverse()
          .map((r) => ({
            channel,
            id: r.id,
            from: r.from,
            fromParticipant: r.fromParticipant,
            displayName:
              typeof r.envelope.display_name === 'string' ? r.envelope.display_name : undefined,
            sent: r.sent,
            preview: r.body.replace(/\s+/g, ' ').slice(0, 160),
            matched: ['body'],
          }));
        return { ok: true, value: { hits, truncated: false, limit: 1000 } };
      },
    },
    recovery: {
      list: async () => recovery,
      restore: async () => recovery[0],
      remove: async () => {},
    },
    config: { ownerRoomDir: join(root, 'owner-room'), mailRoot: join(root, 'mail') },
    agent: undefined,
  };
}

/** A world with post's services attached, as boot attaches them. */
function withPost<W extends import('../app/harness.ts').AppOptions>(
  m: Mods,
  world: W,
  commons: readonly import('@estate/post-kit').RawRecord[] = m.w.commons(),
): W {
  return { ...world, services: services(m, commons) as never };
}

/** The busy world plus, newest, either an image from Trey (signed, verified) or a poll with two ballots. */
function mediaWorld(m: Mods, kind: 'image' | 'poll') {
  const { record, idAt } = m.h;
  const extra =
    kind === 'image'
      ? [
          // Trey's own signed message: production verifies only the owner's room (post-kit
          // verify.ts), and an image renders without Ctrl+R only when its message is verified or
          // Trey's own.
          record({
            minutes: 58,
            seq: 1,
            from: 'mara',
            participant: 'porch-7f3a9c',
            signed: true,
            body: `probe frame from the laptop run: ${imagePath}`,
          }),
        ]
      : [
          record({
            minutes: 59,
            seq: 1,
            body: '📊 POLL p1: Ship the arcade build tonight?\na) Yes, crew ready\nb) Hold for the device check',
          }),
          record({
            minutes: 59,
            seq: 2,
            from: 'mara',
            participant: 'porch-7f3a9c',
            body: '🦊 🗳️ p1: a',
          }),
          record({
            minutes: 59,
            seq: 3,
            from: 'nova',
            participant: 'test-nova02',
            name: 'Nova',
            body: '🗳️ p1: b',
          }),
        ];
  const world = m.w.busyWorld({ armed: true });
  return {
    ...world,
    records: { ...world.records, commons: [...m.w.commons(), ...extra] },
    verdicts: {
      commons: {
        ...m.w.COMMONS_VERDICTS,
        [idAt(58, 1)]: { state: 'verified' as const, reason: 'good signature' },
      },
    },
  };
}

function rest(app: { host: { time: number } }): void {
  app.host.time = REST;
}

async function shoot(g: Grid, file: string, opts: { noColor?: boolean } = {}): Promise<void> {
  if (writing) await captureGrid(g, join(out, file), opts);
}

const text = (m: Mods, g: Grid) => m.h.lines(g).join('\n');

const CYAN = '#3fd9f2';
const LIGHT = 0.18;

/**
 * Where `NO_COLOR` shows a solid light patch: two cell rows by four columns that the host's own
 * monochrome mapping draws entirely light (a space on a light ground, or a half block lit top and
 * bottom). Lit sprites and the old cyan fills were such patches. Inverse text is not: a light run
 * along a row that carries any text (a chip, the failure banner and its padding) is left out.
 */
function solidLight(g: Grid): { x: number; y: number } | undefined {
  const light = (hex: string) => luminance(hex) > LIGHT;
  const solid: boolean[][] = [];
  const ground: boolean[][] = [];
  const texty: boolean[][] = [];
  g.forEachCell((c, x, y) => {
    const { fg, bg } = monochrome(c.fg, c.bg, c.ch);
    const block = c.ch === '█' || c.ch === '▀' || c.ch === '▄';
    for (const [grid, v] of [
      [
        solid,
        c.ch === '█' ? light(fg) : block ? light(fg) && light(bg) : c.ch === ' ' && light(bg),
      ],
      [ground, block ? false : light(bg)],
      [texty, !block && c.ch !== ' ' && light(bg)],
    ] as const) {
      const row = grid[y] ?? [];
      grid[y] = row;
      row[x] = v;
    }
  });
  // Clear every light run that carries text: that is inverse text, not a block.
  for (let y = 0; y < ground.length; y++) {
    const row = ground[y] ?? [];
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (row[end]) end++;
      const lit = solid[y];
      if (lit !== undefined && texty[y]?.slice(x, end).some(Boolean))
        for (let i = x; i < end; i++) lit[i] = false;
      x = end;
    }
  }
  for (let y = 0; y + 1 < solid.length; y++)
    for (let x = 0; x + 3 < (solid[y]?.length ?? 0); x++) {
      let all = true;
      for (let dy = 0; dy < 2 && all; dy++)
        for (let dx = 0; dx < 4 && all; dx++) all = solid[y + dy]?.[x + dx] === true;
      if (all) return { x, y };
    }
  return undefined;
}

/** The stage strip's rows: from under the score bar to the floor (`▔`) under it. */
function stageRows(lines: readonly string[]): string[] {
  const floor = lines.findIndex((l, i) => i > 1 && (l.match(/▔/g)?.length ?? 0) > 10);
  if (floor < 0) throw new Error(`no stage floor:\n${lines.join('\n')}`);
  return lines.slice(0, floor).slice(lines[1]?.includes('STAGES') ? 3 : 2);
}

describe.each(SIZES)('integrated app at $name ($cols x $rows)', ({ name, cols, rows }) => {
  it('main view', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(withPost(m, m.w.busyWorld({ armed: true })));
    rest(app);
    const g = m.h.frame(app, cols, rows);
    const t = text(m, g);
    expect(t).toContain('#commons');
    expect(t).not.toContain('post is unavailable');
    expect(t).not.toContain('PRESS ANY KEY');
    await shoot(g, `main-${name}.png`);
  }, 60_000);

  it('attract screen', async () => {
    const m = await fresh({ attractOwed: true });
    // The attract screen waits for a quiet Porch: no draft and no lane needing Trey.
    // Here: #commons with one unread (Bolt's note) and #ops read, so nothing mentions Trey.
    const world = m.w.busyWorld({ armed: true });
    const app = await m.h.makeApp(
      withPost(m, {
        ...world,
        channels: (world.channels ?? []).map((c) =>
          c.name === 'commons' ? { ...c, unread: 1 } : c.name === 'ops' ? { ...c, unread: 0 } : c,
        ),
      }),
    );
    rest(app);
    m.h.frame(app, cols, rows);
    const g = m.h.frame(app, cols, rows);
    expect(text(m, g)).toContain('PRESS ANY KEY');
    await shoot(g, `attract-${name}.png`);
  }, 60_000);

  for (const overlay of ['switcher', 'browser', 'search', 'help'] as const)
    it(`${overlay} overlay`, async () => {
      const m = await fresh({ attractOwed: false });
      const world = m.w.busyWorld({ armed: true });
      const app = await m.h.makeApp(withPost(m, world));
      rest(app);
      app.m.openOverlay(overlay);
      if (overlay === 'search') {
        m.h.type(app, 'sprite');
        m.h.press(app, m.h.key('return'));
      }
      // Presence (browser, read on its first draw) and the search are reads; let them answer.
      m.h.frame(app, cols, rows);
      await m.h.settle();
      const g = m.h.frame(app, cols, rows);
      const t = text(m, g);
      expect(app.m.overlay).toBe(overlay);
      expect(t).not.toContain('reading presence…');
      if (overlay === 'help') expect(t).toContain('HOW TO PLAY');
      if (overlay === 'search') expect(t).toContain('sprite');
      if (overlay === 'switcher' || overlay === 'browser') expect(t).toContain('ops');
      await shoot(g, `${overlay}-${name}.png`);
    }, 60_000);

  it('recovery overlay', async () => {
    const m = await fresh({ attractOwed: false });
    const world = m.w.busyWorld({ armed: true });
    const app = await m.h.makeApp(withPost(m, world));
    rest(app);
    await app.m.runCommand('restore', '');
    await m.h.settle();
    const g = m.h.frame(app, cols, rows);
    const t = text(m, g);
    expect(app.m.overlay).toBe('recovery');
    expect(t).toContain('RECOVER');
    expect(t).toContain('likely landed in #');
    expect(t).toContain('written ');
    // No raw record id: neither a recovery id nor a post message id.
    expect(t).not.toMatch(/\d{20}-[0-9a-f]{6}/);
    expect(t).not.toMatch(/\d{8}-\d{6}-\d{6}-/);
    expect(t).toContain('not found');
    await shoot(g, `recovery-${name}.png`);
  }, 60_000);

  for (const kind of ['image', 'poll'] as const)
    it(`${kind} message at the newest`, async () => {
      const m = await fresh({ attractOwed: false });
      const world = mediaWorld(m, kind);
      const app = await m.h.makeApp(withPost(m, world, world.records.commons));
      app.m.jumpLatest();
      rest(app);
      // The image decodes in a worker and the tally reads history: draw until both have landed.
      const pending = /image loading…|tally loading…/;
      let g = m.h.frame(app, cols, rows);
      for (let i = 0; i < 200 && pending.test(m.h.lines(g).join('\n')); i++) {
        await new Promise((r) => setTimeout(r, 25));
        await m.h.settle();
        g = m.h.frame(app, cols, rows);
      }
      // A poll card can be taller than the stream at the newest; scroll until its question shows.
      for (
        let i = 0;
        kind === 'poll' && i < 40 && !/p1: Ship the arcade build/.test(m.h.lines(g).join('\n'));
        i++
      ) {
        app.m.scroll(1);
        g = m.h.frame(app, cols, rows);
      }
      const t = text(m, g);
      expect(t).not.toMatch(pending);
      if (kind === 'image') {
        expect(t).not.toContain('image unavailable');
        expect(t).toContain('frame-100x32.png]');
      } else {
        expect(t).toMatch(/p1: Ship the arcade build/);
        expect(t).toContain('2 votes');
      }
      await shoot(g, `${kind}-${name}.png`);
    }, 60_000);
});

describe('integrated app, laptop extras', () => {
  it('mid-reply in signed mode', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(withPost(m, m.w.busyWorld({ armed: true })));
    rest(app);
    m.h.press(app, m.h.key('s', { ctrl: true }));
    m.h.press(app, m.h.key('up', { ctrl: true }));
    m.h.press(app, m.h.key('r'));
    m.h.type(app, 'notes are in, tagging now');
    const g = m.h.frame(app, 100, 32);
    const t = text(m, g);
    expect(t).toContain('SIGNED ●');
    expect(t).toContain('replying to');
    expect(t).toContain('notes are in, tagging now');
    await shoot(g, 'reply-signed-laptop.png');
  }, 60_000);
});

describe.each(SIZES)('finish fixes at $name ($cols x $rows)', ({ name, cols, rows }) => {
  it('NO_COLOR: no solid light blocks; sprites, heads and the lane stay legible', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(
      withPost(m, { ...m.w.busyWorld({ armed: true }), noColor: true }),
    );
    rest(app);
    const g = m.h.frame(app, cols, rows);
    // Precondition: the crew and the heads are on screen.
    expect(text(m, g)).toMatch(/bolt/i);
    expect(text(m, g)).toMatch(/[▀▄]/);
    expect(solidLight(g), `main\n${text(m, g)}`).toBeUndefined();
    // The current lane is marked by an underline, not a reverse-video bar.
    const scoreRows = name === 'phone' ? 2 : 3;
    const lane: { light: boolean; underline: boolean }[] = [];
    const row = m.h.lines(g).findIndex((l, i) => i < scoreRows && l.includes('COMMONS'));
    const at = (m.h.lines(g)[row] ?? '').indexOf('COMMONS');
    expect(at).toBeGreaterThanOrEqual(0);
    g.forEachCell((c, x, y) => {
      if (y === row && x >= at && x < at + 'COMMONS'.length)
        lane.push({
          light: luminance(monochrome(c.fg, c.bg, c.ch).bg) > LIGHT,
          underline: c.underline === true,
        });
    });
    expect(lane.length).toBe('COMMONS'.length);
    expect(lane.every((c) => !c.light && c.underline)).toBe(true);
    await shoot(g, `main-${name}-nocolor.png`, { noColor: true });
    for (const overlay of ['switcher', 'browser', 'search', 'help', 'recovery'] as const) {
      if (overlay === 'recovery') await app.m.runCommand('restore', '');
      else app.m.openOverlay(overlay);
      m.h.frame(app, cols, rows);
      await m.h.settle();
      const o = m.h.frame(app, cols, rows);
      expect(app.m.overlay).toBe(overlay);
      expect(solidLight(o), `${overlay}\n${text(m, o)}`).toBeUndefined();
      app.m.closeOverlay();
    }
  }, 60_000);

  it('NO_COLOR attract screen: the logo and crew are line art', async () => {
    const m = await fresh({ attractOwed: true });
    const world = m.w.busyWorld({ armed: true });
    const app = await m.h.makeApp(
      withPost(m, {
        ...world,
        noColor: true,
        channels: (world.channels ?? []).map((c) =>
          c.name === 'commons' ? { ...c, unread: 1 } : c.name === 'ops' ? { ...c, unread: 0 } : c,
        ),
      }),
    );
    rest(app);
    m.h.frame(app, cols, rows);
    const g = m.h.frame(app, cols, rows);
    expect(text(m, g)).toContain('PRESS ANY KEY');
    expect(solidLight(g), text(m, g)).toBeUndefined();
    await shoot(g, `attract-${name}-nocolor.png`, { noColor: true });
  }, 60_000);

  it('the score bar: 1UP and the name, no emoji', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(withPost(m, m.w.busyWorld({ armed: true })));
    rest(app);
    const top = m.h.lines(m.h.frame(app, cols, rows)).slice(0, name === 'phone' ? 2 : 3);
    expect(top.join('\n')).toContain(name === 'phone' ? 'P1' : '1UP MARA');
    expect(top.join('\n')).not.toMatch(/\p{Extended_Pictographic}/u);
  }, 60_000);

  it('ballots are one line of words; polls and ballots never reach the stage', async () => {
    const m = await fresh({ attractOwed: false });
    const world = mediaWorld(m, 'poll');
    const app = await m.h.makeApp(withPost(m, world, world.records.commons));
    app.m.jumpLatest();
    rest(app);
    let g = m.h.frame(app, cols, rows);
    for (let i = 0; i < 200 && /tally loading…/.test(text(m, g)); i++) {
      await new Promise((r) => setTimeout(r, 25));
      await m.h.settle();
      g = m.h.frame(app, cols, rows);
    }
    const t = text(m, g);
    expect(t).toContain('voted B on p1');
    expect(t).not.toContain('🗳');
    expect(t).not.toMatch(/p1: [ab]$/m);
    const stage = stageRows(m.h.lines(g)).join('\n');
    // Precondition: the stage shows Nova, who cast the newest ballot.
    expect(stage).toMatch(/NOVA|Nova/);
    expect(stage).not.toMatch(/🗳|📊|p1|voted|POLL/);
    // Scroll up to Trey's ballot: the same line of words, never the raw `🗳️ p1: a`.
    for (let i = 0; i < 20 && !text(m, g).includes('voted A on p1'); i++) {
      app.m.scroll(1);
      g = m.h.frame(app, cols, rows);
    }
    expect(text(m, g)).toContain('voted A on p1');
    expect(text(m, g)).not.toContain('🗳');
  }, 60_000);

  it('cyan is only Trey: not the search card, not the attract logo', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(withPost(m, m.w.busyWorld({ armed: true })));
    rest(app);
    app.m.openOverlay('search');
    const g = m.h.frame(app, cols, rows);
    const lines = m.h.lines(g);
    const top = lines.findIndex((l) => l.includes('╔'));
    expect(top).toBeGreaterThanOrEqual(0);
    // The frame, its title plate and the pixel title above it carry no cyan; the field's prompt
    // and caret (Trey's typing) may.
    const field = top + 1;
    const off: string[] = [];
    g.forEachCell((c, x, y) => {
      if (y !== field && (c.fg === CYAN || c.bg === CYAN) && c.ch !== ' ')
        off.push(`${x},${y}:${c.ch}`);
      if (y !== field && c.bg === CYAN) off.push(`${x},${y}:bg`);
    });
    expect(off, lines.join('\n')).toEqual([]);
    const { TITLE_ROWS, T } = await import('../../src/app/stage/theme.ts');
    expect(TITLE_ROWS).not.toContain(T.cyan);
  }, 60_000);

  it('the stage floor; a split pane carries its channel and the focus marker', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(withPost(m, m.w.busyWorld({ armed: true })));
    rest(app);
    const g = m.h.frame(app, cols, rows);
    const lines = m.h.lines(g);
    const floors = lines.filter((l) => (l.match(/▔/g)?.length ?? 0) > 10);
    expect(floors.length).toBe(1);
    if (name === 'wide') {
      expect(floors[0]).toContain('P1 ▸ #commons');
      expect(floors[0]).toMatch(/ #ops /);
    } else expect(floors[0]).not.toContain('#');
  }, 60_000);
});

/** WCAG contrast between two colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const YOU_BG = '#123440';

/** The stream's rows: under the stage floor, down to (not including) the composer's prompt row. */
function streamRows(lines: readonly string[]): { floor: number; end: number } {
  const floor = lines.findIndex((l) => (l.match(/▔/g)?.length ?? 0) > 10);
  if (floor < 0) throw new Error(`no stage floor:\n${lines.join('\n')}`);
  const end = lines.findIndex((l, i) => i > floor && /^ P1 ?▸/.test(l));
  return { floor, end: end < 0 ? lines.length : end };
}

/**
 * What a frame's stream shows under the floor that a cut at a message boundary forbids, in the
 * first pane (cols `x0`..`x1`): a first row that does not start an item (a record starts with its
 * head in the gutter; one-row items are the window's top, a day, the divider, a ballot, an emote, a join),
 * a head cut short, a youBg run with no `P1` header in it, and a failed record's header or body
 * without its banner above it.
 */
function boundaryFaults(g: Grid, lines: readonly string[], x1: number): string[] {
  const { floor, end } = streamRows(lines);
  // The split's divider (`│`) is the pane's edge, not content.
  const row = (y: number) => (lines[y] ?? '').slice(0, x1).replace(/│/g, ' ');
  const gutter = (y: number) => /[▀▄█]/.test(row(y).slice(0, 9));
  const faults: string[] = [];
  let first = floor + 1;
  while (first < end && !/\S/.test(row(first))) first++;
  if (first < end) {
    const oneRow = /⤒|── \d{4}-|NEW · |voted [A-Z] on|✦ |→ \S+ joined/.test(row(first));
    if (!gutter(first) && !oneRow) faults.push(`row ${first} starts mid-record: ${row(first)}`);
    let run = 0;
    while (gutter(first + run)) run++;
    if (run > 0 && run < 4) faults.push(`head cut to ${run} rows at ${first}`);
  }
  // youBg runs: each holds Trey's header.
  const teal: boolean[] = [];
  g.forEachCell((c, x, y) => {
    if (y > floor && y < end && x < x1 && c.bg === YOU_BG) teal[y] = true;
  });
  for (let y = floor + 1; y < end; y++) {
    if (teal[y] !== true || teal[y - 1] === true) continue;
    let e = y;
    let header = false;
    for (; teal[e] === true; e++) if (/P1 MA/.test(row(e))) header = true;
    if (!header) faults.push(`youBg rows ${y}-${e - 1} with no header`);
  }
  // The failed record: header or body on screen means the banner is on screen above them.
  const at = (re: RegExp) => lines.findIndex((l, i) => i > floor && i < end && re.test(l));
  const banner = at(/SIGNATURE FAILED/);
  for (const re of [/claims Mara/, /ignore the last one/]) {
    const y = at(re);
    if (y >= 0 && (banner < 0 || banner > y)) faults.push(`${re} at ${y} without its banner`);
  }
  return faults;
}

describe('finish fixes: the stream under the floor', () => {
  const worlds = ['busy', 'poll', 'image'] as const;
  for (const { name, cols, rows } of SIZES)
    for (const world of worlds)
      it(`${world} at ${name}: the floor cuts at a message boundary`, async () => {
        const m = await fresh({ attractOwed: false });
        const w = world === 'busy' ? m.w.busyWorld({ armed: true }) : mediaWorld(m, world);
        const app = await m.h.makeApp(withPost(m, w, w.records?.commons ?? m.w.commons()));
        app.m.jumpLatest();
        rest(app);
        let g = m.h.frame(app, cols, rows);
        for (let i = 0; i < 200 && /image loading…|tally loading…/.test(text(m, g)); i++) {
          await new Promise((r) => setTimeout(r, 25));
          await m.h.settle();
          g = m.h.frame(app, cols, rows);
        }
        // The first pane: the left one in a split.
        const x1 = name === 'wide' ? Math.floor(cols / 2) : cols;
        let blankTop = 0;
        let banner = 0;
        for (let scroll = 0; scroll < 60; scroll++) {
          if (scroll > 0) app.m.scroll(1);
          g = m.h.frame(app, cols, rows);
          const lines = m.h.lines(g);
          const faults = boundaryFaults(g, lines, x1);
          expect(faults, `scroll ${scroll}:\n${lines.join('\n')}`).toEqual([]);
          const { floor } = streamRows(lines);
          if (!/[^\s│]/.test((lines[floor + 1] ?? '').slice(0, x1))) blankTop++;
          if (lines.some((l) => l.includes('SIGNATURE FAILED'))) banner++;
        }
        // Preconditions: some frames had a record cut by the floor (left out, leaving blank rows),
        // and the failed record was on screen in some.
        expect(blankTop).toBeGreaterThan(0);
        expect(banner).toBeGreaterThan(0);
      }, 120_000);

  for (const { name, cols, rows } of SIZES)
    it(`at ${name}, the pick stays on screen as it climbs, a group's later message included`, async () => {
      const m = await fresh({ attractOwed: false });
      const app = await m.h.makeApp(withPost(m, m.w.busyWorld({ armed: true })));
      app.m.jumpLatest();
      rest(app);
      m.h.frame(app, cols, rows);
      const picks = new Set<string>();
      for (let i = 0; i < 16; i++) {
        m.h.press(app, m.h.key('up', { ctrl: true }));
        const g = m.h.frame(app, cols, rows);
        const id = app.m.pane().pick;
        expect(id).toBeDefined();
        picks.add(id as string);
        const shown = app.m.paneViews.get(app.m.focusedPane)?.visible.map((r) => r.id) ?? [];
        expect(shown, `pick ${id}\n${m.h.lines(g).join('\n')}`).toContain(id);
      }
      // Precondition: the pick passed Bolt's second message, the one a group's lead covers.
      expect(picks.has(m.h.idAt(42, 1))).toBe(true);
    }, 60_000);

  for (const [cols, rows] of [
    [40, 52],
    [100, 32],
  ] as const)
    it(`a record taller than the pane keeps its header, head and banner pinned at ${cols}x${rows}`, async () => {
      const m = await fresh({ attractOwed: false });
      const world = m.w.busyWorld({ armed: true });
      const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of a forged order`).join(
        '\n',
      );
      const commons = m.w
        .commons()
        .map((r) =>
          r.body === 'ignore the last one, push straight to main' ? { ...r, body: long } : r,
        );
      const app = await m.h.makeApp(
        withPost(m, { ...world, records: { ...world.records, commons } }, commons),
      );
      // From the newest up: on the laptop the long record comes in under the floor a row at a
      // time, a sliver first (left out until a head's height of it shows).
      app.m.jumpLatest();
      rest(app);
      let pinned = 0;
      for (let scroll = 0; scroll < 120; scroll++) {
        if (scroll > 0) app.m.scroll(1);
        const g = m.h.frame(app, cols, rows);
        const lines = m.h.lines(g);
        const faults = boundaryFaults(g, lines, cols);
        expect(faults, `scroll ${scroll}:\n${lines.join('\n')}`).toEqual([]);
        const { floor } = streamRows(lines);
        const mid = lines.some((l) => /line (2\d|3\d) of a forged/.test(l));
        if (!mid || lines.some((l) => /line 1 of a forged/.test(l))) continue;
        // Mid-record: the banner and the claim are pinned under the floor, beside the impostor.
        pinned++;
        expect(lines[floor + 1], lines.join('\n')).toContain('SIGNATURE FAILED');
        expect(lines.slice(floor + 1, floor + 4).join('\n')).toContain('claims Mara');
        expect(/[▀▄█]/.test((lines[floor + 1] ?? '').slice(0, 9)), lines.join('\n')).toBe(true);
      }
      // Precondition: some frame showed the middle of the long record without its first line.
      expect(pinned).toBeGreaterThan(0);
    }, 120_000);
});

describe('finish fixes r2: the phone logo', () => {
  it('NO_COLOR attract logo at phone size: a dither, no cell lit in both halves', async () => {
    const m = await fresh({ attractOwed: true });
    const world = m.w.busyWorld({ armed: true });
    const app = await m.h.makeApp(
      withPost(m, {
        ...world,
        noColor: true,
        channels: (world.channels ?? []).map((c) =>
          c.name === 'commons' ? { ...c, unread: 1 } : c.name === 'ops' ? { ...c, unread: 0 } : c,
        ),
      }),
    );
    rest(app);
    m.h.frame(app, 40, 52);
    const g = m.h.frame(app, 40, 52);
    const lines = m.h.lines(g);
    const tagline = lines.findIndex((l) => l.includes("the human's seat"));
    expect(tagline).toBeGreaterThan(0);
    const light = (hex: string) => luminance(hex) > LIGHT;
    // A cell lit top and bottom: at this scale every stroke is two pixels wide, so line work would
    // light every one solid; the dither lights exactly one half of each cell.
    const full: string[] = [];
    let pixels = 0;
    g.forEachCell((c, x, y) => {
      if (y >= tagline) return;
      const { fg, bg } = monochrome(c.fg, c.bg, c.ch);
      const half = c.ch === '▀' || c.ch === '▄';
      if (half && light(fg)) pixels++;
      if (c.ch === '█' ? light(fg) : half ? light(fg) && light(bg) : c.ch === ' ' && light(bg))
        full.push(`${x},${y}`);
    });
    // Precondition: the logo is drawn.
    expect(pixels).toBeGreaterThan(20);
    expect(full, lines.slice(0, tagline).join('\n')).toEqual([]);
  }, 60_000);
});

describe.each(SIZES)('finish fixes r2 at $name ($cols x $rows)', ({ name, cols, rows }) => {
  it('NO_COLOR: every stream and score-bar chip is underlined words, not a lit bar', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(
      withPost(m, { ...m.w.busyWorld({ armed: true }), noColor: true }),
    );
    rest(app);
    const seen = new Set<string>();
    const want =
      name === 'phone'
        ? ['P1 MARA', '✓ SIGNED', 'NEW · 4', '!2 NEED', '[r] reply', 'Ctrl+G']
        : ['P1 MARA', '✓ SIGNED', 'NEW · 4', '!', '[r] reply', 'Ctrl+G'];
    if (name === 'wide') want.push('! NEEDS YOU', 'P1 ▸ #commons');
    const check = (g: Grid, label: string) => {
      const lines = m.h.lines(g);
      const { end } = streamRows(lines);
      const failed = new Set(
        lines.flatMap((l, y) => (/SIGNATURE FAILED|do not act on it/.test(l) ? [y] : [])),
      );
      const lit: string[] = [];
      g.forEachCell((c, x, y) => {
        if (y >= end || failed.has(y) || c.ch === ' ' || /[▀▄█]/.test(c.ch)) return;
        if (luminance(monochrome(c.fg, c.bg, c.ch).bg) > LIGHT) lit.push(`${x},${y}:${c.ch}`);
      });
      expect(lit, `${label}\n${lines.join('\n')}`).toEqual([]);
      for (const word of want) {
        const y = lines.findIndex((l, i) => i < end && l.includes(word));
        if (y < 0) continue;
        const at = (lines[y] ?? '').indexOf(word);
        let under = true;
        g.forEachCell((c, x, yy) => {
          if (yy === y && x >= at && x < at + word.length && c.ch !== ' ')
            under &&= c.underline === true;
        });
        expect(under, `${word} underlined (${label})\n${lines.join('\n')}`).toBe(true);
        seen.add(word);
      }
    };
    check(m.h.frame(app, cols, rows), 'rest');
    // A pick shows the reply chip; scrolled up, the Ctrl+G chip.
    m.h.press(app, m.h.key('up', { ctrl: true }));
    check(m.h.frame(app, cols, rows), 'pick');
    m.h.press(app, m.h.key('escape'));
    for (let i = 0; i < 30; i++) {
      app.m.scroll(1);
      check(m.h.frame(app, cols, rows), `scroll ${i + 1}`);
    }
    // Precondition: every chip was on screen somewhere.
    expect([...seen].sort()).toEqual([...want].sort());
    // The help legend draws each chip as the screen does: underlined words, not a lit bar.
    app.m.openOverlay('help');
    const h = m.h.frame(app, cols, rows);
    const hl = m.h.lines(h);
    const legend = ['✓ SIGNED', '! NEEDS YOU', 'P1 TREY'];
    const off: string[] = [];
    let found = 0;
    for (const word of legend) {
      const y = hl.findIndex((l) => l.includes(word));
      if (y < 0) continue;
      found++;
      const at = (hl[y] ?? '').indexOf(word);
      h.forEachCell((c, x, yy) => {
        if (yy !== y || x < at || x >= at + word.length || c.ch === ' ') return;
        const lit = luminance(monochrome(c.fg, c.bg, c.ch).bg) > LIGHT;
        if (lit || c.underline !== true) off.push(`${word}@${x}:${c.ch}`);
      });
    }
    // Precondition: the legend's chips are on the card's first page.
    expect(found, hl.join('\n')).toBeGreaterThan(0);
    expect(off, hl.join('\n')).toEqual([]);
  }, 120_000);

  it('the ballot line holds 4.5:1 on the ground and is never dim', async () => {
    const m = await fresh({ attractOwed: false });
    const world = mediaWorld(m, 'poll');
    const app = await m.h.makeApp(withPost(m, world, world.records.commons));
    app.m.jumpLatest();
    rest(app);
    let g = m.h.frame(app, cols, rows);
    for (let i = 0; i < 200 && /tally loading…/.test(text(m, g)); i++) {
      await new Promise((r) => setTimeout(r, 25));
      await m.h.settle();
      g = m.h.frame(app, cols, rows);
    }
    const lines = m.h.lines(g);
    const y = lines.findIndex((l) => l.includes('voted B on p1'));
    expect(y).toBeGreaterThan(0);
    const at = (lines[y] ?? '').indexOf('Nova');
    expect(at).toBeGreaterThanOrEqual(0);
    const bad: string[] = [];
    let cells = 0;
    g.forEachCell((c, x, yy) => {
      if (yy !== y || x < at || c.ch === ' ' || c.ch === '') return;
      if (x >= at + 'Nova voted B on p1'.length) return;
      cells++;
      const ratio = contrast(c.fg, c.bg);
      if (c.dim === true || ratio < 4.5) bad.push(`${c.ch} ${c.fg}/${c.bg} ${ratio.toFixed(2)}`);
    });
    expect(cells).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  }, 60_000);
});

describe('finish fixes: stills of the stage flourishes, reduced motion', () => {
  it('READY! end state: the read mark beside the agent who read Trey’s latest', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(
      withPost(m, { ...m.w.busyWorld({ armed: true }), motion: 'reduced' }),
    );
    rest(app);
    m.h.type(app, 'tagging after the notes');
    m.h.press(app, m.h.key('return'));
    await m.h.settle();
    const sent = app.sends.length;
    expect(sent).toBe(1);
    const id = m.h.idAt(70, 1);
    app.source.markSeen('commons', id, 'test-bolt01');
    await m.h.settle();
    const g = m.h.frame(app, 100, 32);
    const stage = stageRows(m.h.lines(g)).join('\n');
    expect(stage, stage).toMatch(/bolt ✓/i);
    expect(stage).not.toMatch(/nova ✓/i);
    await shoot(g, 'ready-laptop-reduced.png');
  }, 60_000);

  it('the SIGNED! power-up plate, held still in reduced motion', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(
      withPost(m, { ...m.w.busyWorld({ armed: true }), motion: 'reduced' }),
    );
    rest(app);
    m.h.press(app, m.h.key('s', { ctrl: true }));
    m.h.type(app, 'signed: ship it');
    m.h.press(app, m.h.key('return'));
    await m.h.settle();
    expect(app.sends.at(-1)?.mode).toBe('signed');
    const g = m.h.frame(app, 100, 32);
    const plate = stageRows(m.h.lines(g)).join('\n');
    // The plate stands over the strip for its length, then the strip is back as it was.
    const { POWER_UP_MS } = await import('../../src/app/stage/power-up.ts');
    app.host.time += POWER_UP_MS + 1;
    const after = stageRows(m.h.lines(m.h.frame(app, 100, 32))).join('\n');
    expect(plate).not.toBe(after);
    expect(after, after).toMatch(/bolt/i);
    await shoot(g, 'power-up-laptop-reduced.png');
  }, 60_000);
});

/**
 * Every cell `NO_COLOR` draws on a light ground, outside pixel art (half blocks, which the mono art
 * already keeps to line work) and the failed-signature banner (the one reverse-video exception,
 * coordinator ruling). A chip, a bar, a plate or a caret with a lit face shows up here.
 */
function litGround(m: Mods, g: Grid): string[] {
  const lines = m.h.lines(g);
  const banner = new Set(
    lines.flatMap((l, y) => (/SIGNATURE FAILED|do not act on it/.test(l) ? [y] : [])),
  );
  const lit: string[] = [];
  g.forEachCell((c, x, y) => {
    if (banner.has(y) || /[▀▄█]/.test(c.ch)) return;
    if (luminance(monochrome(c.fg, c.bg, c.ch).bg) > LIGHT) lit.push(`${x},${y}:${c.ch || '·'}`);
  });
  return lit;
}

/**
 * Whether `word` is on screen with every non-space cell underlined (the mono chip path). The last
 * row that has it: the composer, status line and picker sit below any stream text that quotes it.
 */
function underlined(m: Mods, g: Grid, word: string): boolean | undefined {
  const lines = m.h.lines(g);
  const y = lines.findLastIndex((l) => l.includes(word));
  if (y < 0) return undefined;
  const at = (lines[y] ?? '').indexOf(word);
  let all = true;
  g.forEachCell((c, x, yy) => {
    if (yy === y && x >= at && x < at + word.length && c.ch !== ' ') all &&= c.underline === true;
  });
  return all;
}

describe.each(SIZES)('NO_COLOR follow-up at $name ($cols x $rows)', ({ name, cols, rows }) => {
  it('the reply bar, mode chip, pick, picker, notices, caret and plates draw no lit ground', async () => {
    const m = await fresh({ attractOwed: false });
    const app = await m.h.makeApp(
      withPost(m, { ...m.w.busyWorld({ armed: true }), noColor: true }),
    );
    rest(app);
    const check = (label: string, word: string, file?: string) => {
      const g = m.h.frame(app, cols, rows);
      const all = text(m, g);
      // Precondition: the state is on screen, drawn by the mono path (underlined words).
      expect(underlined(m, g, word), `${label}: "${word}" underlined\n${all}`).toBe(true);
      expect(litGround(m, g), `${label}\n${all}`).toEqual([]);
      return file === undefined || name !== 'laptop'
        ? undefined
        : shoot(g, file, { noColor: true });
    };
    // At rest: the empty composer's caret is an underline, not a lit cell.
    {
      const g = m.h.frame(app, cols, rows);
      expect(text(m, g)).toMatch(/type to talk/i);
      expect(litGround(m, g), `rest\n${text(m, g)}`).toEqual([]);
    }
    m.h.press(app, m.h.key('s', { ctrl: true }));
    await check('signed', 'SIGNED ●');
    m.h.press(app, m.h.key('up', { ctrl: true }));
    await check('pick', 'PICK', 'pick-laptop-nocolor.png');
    m.h.press(app, m.h.key('r'));
    m.h.type(app, 'notes are in, tagging now');
    await check('reply', 'replying to');
    {
      const g = m.h.frame(app, cols, rows);
      expect(text(m, g)).toContain('SIGNED ●');
      // The phone's reply bar takes its own path (whom, not what), so it gets a capture too.
      if (name !== 'wide') await shoot(g, `reply-signed-${name}-nocolor.png`, { noColor: true });
    }
    // The mentions picker's selected row.
    m.h.type(app, ' @bo');
    expect(app.m.pickerOpen()).toBe(true);
    await check('picker', 'Bolt');
    m.h.press(app, m.h.key('escape'));
    app.m.status('sent to #commons', 'good');
    await check('good notice', '✓ sent to #commons', 'notice-good-laptop-nocolor.png');
    app.m.status('send failed: post is unavailable', 'warning');
    await check('warning notice', '✗ send failed', 'notice-warning-laptop-nocolor.png');
    const plates = {
      switcher: 'STAGE SELECT',
      browser: 'CHANNELS',
      search: 'SEARCH',
      help: 'HOW TO PLAY',
      recovery: 'RECOVER',
    } as const;
    for (const [overlay, plate] of Object.entries(plates)) {
      if (overlay === 'recovery') await app.m.runCommand('restore', '');
      else app.m.openOverlay(overlay as keyof typeof plates);
      m.h.frame(app, cols, rows);
      await m.h.settle();
      expect(app.m.overlay).toBe(overlay);
      await check(
        overlay,
        ` ${plate} `,
        overlay === 'switcher' ? 'switcher-laptop-nocolor.png' : undefined,
      );
      app.m.closeOverlay();
    }
  }, 120_000);
});

describe('NO_COLOR follow-up: the power-up word', () => {
  it('the small SIGNED! word is underlined gold words, not a lit plate', async () => {
    // The word is the fallback for a strip too small for the pixel plate (under about 37 by 5);
    // no app layout reaches it today, so it is drawn straight onto a small grid.
    const { Grid } = await import('../../src/grid/grid.ts');
    const { GROUND } = await import('../../src/app/theme.ts');
    const { drawPowerUp } = await import('../../src/app/stage/power-up.ts');
    for (const k of [0, undefined]) {
      const g = new Grid(30, 3, GROUND);
      drawPowerUp(g, { x: 0, y: 0, w: 30, h: 3 }, k, true);
      const lines: string[] = [];
      for (let y = 0; y < 3; y++) {
        let l = '';
        for (let x = 0; x < 30; x++) l += g.at(x, y)?.ch || ' ';
        lines.push(l);
      }
      const y = lines.findIndex((l) => l.includes('SIGNED!'));
      // Precondition: the fallback word is what was drawn.
      expect(y, lines.join('\n')).toBeGreaterThanOrEqual(0);
      const at = (lines[y] ?? '').indexOf('SIGNED!');
      const off: string[] = [];
      g.forEachCell((c, x, yy) => {
        if (luminance(monochrome(c.fg, c.bg, c.ch).bg) > LIGHT) off.push(`lit ${x},${yy}`);
        if (yy === y && x >= at && x < at + 7 && c.underline !== true) off.push(`plain ${x}`);
      });
      expect(off, lines.join('\n')).toEqual([]);
    }
  });
});

/** Row `y` as one character per cell, so a match's index is its column (wide glyphs become `?`). */
function cellRow(g: Grid, y: number): string {
  let row = '';
  for (let x = 0; x < g.cols; x++) {
    const ch = g.at(x, y)?.ch ?? ' ';
    row += ch.length === 1 ? ch : ch === '' ? ' ' : '?';
  }
  return row;
}

describe('design follow-up: the documenter’s defects', () => {
  it.each(SIZES.filter((s) => s.name !== 'phone'))(
    'message ids are meta gray at $name: 4.5:1 on the ground',
    async ({ cols, rows }) => {
      const m = await fresh({ attractOwed: false });
      const { K } = await import('../../src/app/theme.ts');
      const app = await m.h.makeApp(withPost(m, m.w.busyWorld({ armed: true })));
      rest(app);
      const bad: string[] = [];
      let ids = 0;
      let own = 0;
      const check = (g: Grid) => {
        const { floor, end } = streamRows(m.h.lines(g));
        for (let y = floor + 1; y < end; y++)
          for (const hit of cellRow(g, y).matchAll(/#[0-9a-f]{6}(?![0-9a-z])/g)) {
            ids++;
            for (let x = hit.index; x < hit.index + 7; x++) {
              const c = g.at(x, y);
              if (c === undefined) continue;
              if (c.bg === YOU_BG) own++;
              // Behind Trey's own records gray measures 3.69:1, a palette question of its own
              // (reported, not decided here); the id still takes the same meta ink as the time.
              const floorFails = c.bg !== YOU_BG && contrast(c.fg, c.bg) < 4.5;
              if (c.fg !== K.gray || floorFails)
                bad.push(`${hit[0]}@${x},${y}: ${c.fg}/${c.bg} ${contrast(c.fg, c.bg).toFixed(2)}`);
            }
          }
      };
      check(m.h.frame(app, cols, rows));
      // Scroll up through history so Trey's own records (on his teal) come into view as well.
      for (let i = 0; i < 30 && own === 0; i++) {
        app.m.scroll(1);
        check(m.h.frame(app, cols, rows));
      }
      // Preconditions: several headers with ids, one of them on Trey's teal.
      expect(ids).toBeGreaterThanOrEqual(2);
      expect(own).toBeGreaterThan(0);
      expect(bad).toEqual([]);
    },
    60_000,
  );

  it('a framed ballot is the same plain words, never dimmed', async () => {
    const m = await fresh({ attractOwed: false });
    const base = mediaWorld(m, 'poll');
    // Nova's ballot, unverified: it keeps its dotted frame and header, with the words as its body.
    const world = {
      ...base,
      verdicts: {
        commons: {
          ...base.verdicts.commons,
          [m.h.idAt(59, 3)]: { state: 'unknown' as const, reason: 'missing signature' },
        },
      },
    };
    const app = await m.h.makeApp(withPost(m, world, world.records.commons));
    app.m.jumpLatest();
    rest(app);
    let g = m.h.frame(app, 100, 32);
    for (let i = 0; i < 200 && /tally loading…/.test(text(m, g)); i++) {
      await new Promise((r) => setTimeout(r, 25));
      await m.h.settle();
      g = m.h.frame(app, 100, 32);
    }
    const y = m.h.lines(g).findIndex((l) => l.includes('voted B on p1'));
    // Precondition: the ballot is framed (a dotted frame edge on its row), not the compact line.
    expect(y, text(m, g)).toBeGreaterThan(0);
    expect(m.h.lines(g)[y]).toContain('┊');
    expect(m.h.lines(g)[y]).not.toContain('Nova voted');
    const at = cellRow(g, y).indexOf('voted B on p1');
    const bad: string[] = [];
    for (let x = at; x < at + 'voted B on p1'.length; x++) {
      const c = g.at(x, y);
      if (c === undefined || c.ch === ' ') continue;
      const ratio = contrast(c.fg, c.bg);
      if (c.dim === true || ratio < 4.5) bad.push(`${c.ch} ${c.fg}/${c.bg} ${ratio.toFixed(2)}`);
    }
    expect(bad).toEqual([]);
  }, 60_000);
});
