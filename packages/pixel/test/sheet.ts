/**
 * The pixel capture sheets, for judging the avatars and emotes by eye (task T4's close condition).
 * Everything is drawn into Porch's own grid with the package's rasteriser, the way the stage will
 * draw it, and screenshot through `captureGrid` from `scripts/capture.ts`.
 *
 *   node --import tsx packages/pixel/test/sheet.ts [--out docs/captures]
 *
 * Writes `pixel-sheet.png` (the palette, the six starter packs with every frame, every built-in
 * emote and every custom emote as key frames) and `pixel-defaults.png` (every default character
 * and variant, and defaults for a set of example ids).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { captureGrid } from '../../../scripts/capture.ts';
import { drawPix, Grid, scanlines } from '../../../src/grid/index.ts';
import { characterAvatar, DEFAULT_CHARACTERS } from '../src/generator.ts';
import {
  ACCENT_ALLOWED,
  type AvatarPack,
  applyImpersonationCap,
  BUILTIN_EMOTES,
  defaultAvatar,
  type FrozenEmote,
  framePixels,
  freezeEmote,
  mirrorX,
  PALETTE_NAMES,
  type Pixel,
  parseAvatar,
  playEmote,
  resolveAccent,
  SPRITE_PALETTE,
  type SpriteFrame,
  toHalfBlocks,
} from '../src/index.ts';

const K = {
  glass: '#05080b',
  scan: '#0a0f14',
  data: '#dfe6ea',
  gray: '#8f9aa2',
  dim: '#434d56',
  magenta: '#ff5bdc',
  green: '#3ee56d',
};
const ROOT = join(import.meta.dirname, '../../..');
const EXAMPLES = ['trey', 'bolt', 'wisp', 'mochi', 'ribbit', 'blob'] as const;
const OWNER = 'trey';

type Who = { name: string; pack: AvatarPack; isOwner: boolean; accent: number };

function example(name: string): Who {
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'packages/pixel/examples', `${name}.json`)));
  const { pack, rules } = parseAvatar(bytes);
  if (pack === null) throw new Error(`${name}: ${rules.join(', ')}`);
  const isOwner = name === OWNER;
  return { name, pack, isOwner, accent: resolveAccent(pack, { isOwner }, name) };
}

/** A sprite frame blitted at cell `x`, `y` (its top-left, 16 or 8 pixels wide). */
function sprite(g: Grid, x: number, y: number, px: Pixel[][], who: Who, target: 'body' | 'head') {
  const capped = applyImpersonationCap(px, target, who, who.accent);
  g.blit(x, y, toHalfBlocks(capped, SPRITE_PALETTE));
}

/** Headroom above a composed emote frame, in pixels: particles rise into it. */
const HEAD_ROOM = 16;
const PAD_X = 2;

/**
 * One emote frame composed as the stage composes it: sprite (offset, mirrored, or hidden), then
 * particles, into a canvas with room above for particles and at the sides for a shake.
 */
function composed(f: SpriteFrame, size: number): Pixel[][] {
  const w = size + PAD_X * 2 + 2;
  const h = size + HEAD_ROOM;
  const canvas: Pixel[][] = Array.from({ length: h }, () => new Array<Pixel>(w).fill(null));
  const put = (x: number, y: number, v: Pixel) => {
    const row = canvas[y];
    if (row !== undefined && x >= 0 && x < w && v !== null) row[x] = v;
  };
  if (f.visible) {
    const px = f.flipX ? mirrorX(f.px) : f.px;
    px.forEach((row, y) => {
      row.forEach((v, x) => {
        put(PAD_X + x + f.dx, HEAD_ROOM + y + f.dy, v);
      });
    });
  }
  for (const p of f.particles) {
    const top = p.y - p.px.length + 1;
    p.px.forEach((row, y) => {
      row.forEach((v, x) => {
        put(PAD_X + p.x + x, HEAD_ROOM + top + y, v);
      });
    });
  }
  return canvas;
}

/**
 * Up to `max` distinct key frames of an emote, in time order, with their start times. The cap is
 * applied to the sprite before particles are added, as the stage does, so a spark's lemon pixels
 * never count against the sender.
 */
function keyFrames(emote: FrozenEmote, who: Who, max: number): { t: number; px: Pixel[][] }[] {
  const player = playEmote(emote, 'body', 'full');
  const all: { t: number; px: Pixel[][] }[] = [];
  let last = '';
  for (let t = 0; t < player.durationMs; t += 125) {
    const f = player.frameAt(t);
    if (f === null) continue;
    const px = composed({ ...f, px: applyImpersonationCap(f.px, 'body', who, who.accent) }, 16);
    const key = JSON.stringify(px);
    if (key === last) continue;
    last = key;
    all.push({ t, px });
  }
  if (all.length <= max) return all;
  return Array.from(
    { length: max },
    (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))],
  ).filter((f): f is { t: number; px: Pixel[][] } => f !== undefined);
}

function title(g: Grid, x: number, y: number, s: string, colour = K.data) {
  drawPix(g, x, y, s, colour, { shadow: K.dim });
}

/** An emote panel: the name and length, then its key frames (each 20 columns by 16 rows). */
function emotePanel(g: Grid, x: number, y: number, label: string, emote: FrozenEmote, who: Who) {
  const player = playEmote(emote, 'body', 'full');
  g.text(x, y, label, { fg: K.data, bold: true });
  const meta = `${player.durationMs}ms · ${who.name}`;
  g.text(x + label.length + 1, y, meta, { fg: K.gray });
  keyFrames(emote, who, 5).forEach((f, i) => {
    const fx = x + i * 20;
    g.blit(fx, y + 1, toHalfBlocks(f.px, SPRITE_PALETTE));
    g.text(fx + 2, y + 17, `${f.t}ms`, { fg: K.dim });
  });
}

/** Draw with `rows` to spare, then again at exactly the height used. */
function fitted(draw: (rows: number) => { g: Grid; used: number }): Grid {
  return draw(draw(400).used + 1).g;
}

function sheet(rows: number): { g: Grid; used: number } {
  const who = EXAMPLES.map(example);
  const cols = 212;
  const g = new Grid(cols, rows, scanlines(K.glass, K.scan, K.data));
  let y = 1;
  title(g, 2, y, 'PIXEL', K.magenta);
  g.text(26, y + 1, '@estate/pixel · format 1 · the starter kit and the emote library', {
    fg: K.gray,
  });
  y += 5;

  // The palette.
  SPRITE_PALETTE.forEach((hex, i) => {
    const x = 2 + i * 13;
    g.fill({ x, y, w: 4, h: 2 }, { bg: hex });
    g.text(x + 5, y, i.toString(16), { fg: K.data, bold: true });
    g.text(x + 5, y + 1, PALETTE_NAMES[i] ?? '', { fg: K.gray });
  });
  y += 4;

  title(g, 2, y, 'STARTER KIT', K.green);
  y += 5;
  for (const w of who) {
    const tag = SPRITE_PALETTE[w.accent] ?? K.data;
    g.text(2, y, ` ${w.name.toUpperCase()} `, { fg: K.glass, bg: tag, bold: true });
    const note = w.isOwner ? 'owner: cyan allowed' : `accent ${w.pack.accent}`;
    const custom = Object.keys(w.pack.emotes ?? {});
    g.text(
      w.name.length + 5,
      y,
      `${note}${custom.length > 0 ? ` · emotes: ${custom.join(', ')}` : ''}`,
      {
        fg: K.gray,
      },
    );
    const names = Object.keys(w.pack.body);
    names.forEach((n, i) => {
      const x = 2 + i * 19;
      sprite(g, x, y + 1, framePixels(w.pack.body[n] ?? []), w, 'body');
      g.text(x, y + 9, n, { fg: K.dim });
    });
    Object.keys(w.pack.head).forEach((n, i) => {
      const x = 2 + 9 * 19 + i * 11;
      sprite(g, x, y + 3, framePixels(w.pack.head[n] ?? []), w, 'head');
      g.text(x, y + 9, n, { fg: K.dim });
    });
    y += 11;
  }

  title(g, 2, y, 'BUILT-IN EMOTES', K.green);
  g.text(62, y + 1, 'builtin-1 · key frames at 125ms sub-ticks · each played by a starter', {
    fg: K.gray,
  });
  y += 5;
  const builtins = Object.keys(BUILTIN_EMOTES);
  builtins.forEach((name, i) => {
    const w = who[(i + 1) % who.length] as Who;
    const plain = { ...w.pack, emotes: {} };
    const frozen = freezeEmote(plain, name);
    if (frozen === null) return;
    const x = i % 2 === 0 ? 2 : 104;
    emotePanel(g, x, y, name, frozen.emote, w);
    if (i % 2 === 1 || i === builtins.length - 1) y += 19;
  });

  title(g, 2, y, 'CUSTOM EMOTES', K.green);
  y += 5;
  let n = 0;
  for (const w of who) {
    for (const name of Object.keys(w.pack.emotes ?? {})) {
      const frozen = freezeEmote(w.pack, name);
      if (frozen === null) continue;
      emotePanel(g, n % 2 === 0 ? 2 : 104, y, name, frozen.emote, w);
      if (n % 2 === 1) y += 19;
      n += 1;
    }
  }
  if (n % 2 === 1) y += 19;
  if (y > rows) throw new Error(`sheet needs ${y} rows`);
  return { g, used: y };
}

const IDS = [
  'claude-0f00ba11',
  'codex-5eed1234',
  'sol-review',
  'opus-lane-t4',
  'cairn',
  'rowan',
  'loom-main',
  'fable-1',
  'glm-flash',
  'post-bridge',
  'atlas-9',
  'wren',
  'porch-build',
  'ledger',
  'quill',
  'marlowe',
  'tinker',
  'pip',
  'juniper',
  'otto',
];

function defaults(rows: number): { g: Grid; used: number } {
  const cols = 212;
  const g = new Grid(cols, rows, scanlines(K.glass, K.scan, K.data));
  let y = 1;
  title(g, 2, y, 'DEFAULT AVATARS', K.magenta);
  g.text(66, y + 1, 'defaultAvatar(participant id) · for anyone who has not drawn their own', {
    fg: K.gray,
  });
  y += 6;
  title(g, 2, y, 'EVERY CHARACTER', K.green);
  y += 5;
  let i = 0;
  for (const c of DEFAULT_CHARACTERS) {
    for (let v = 0; v < c.variants; v++) {
      const worn = ACCENT_ALLOWED.filter((a) => a !== 3);
      const accent = worn[(i * 4 + 1) % worn.length] ?? 4;
      const pack = characterAvatar(c.name, v, accent, [i, i + 1, i + 2]);
      const w: Who = { name: c.name, pack, isOwner: false, accent };
      const x = 2 + (i % 10) * 20;
      const yy = y + Math.floor(i / 10) * 11;
      sprite(g, x, yy, framePixels(pack.body.idle), w, 'body');
      g.text(x, yy + 8, `${c.name} ${v + 1}`, { fg: K.dim });
      i += 1;
    }
  }
  y += Math.ceil(i / 10) * 11 + 1;

  title(g, 2, y, 'BY PARTICIPANT ID', K.green);
  y += 5;
  IDS.forEach((id, j) => {
    const pack = defaultAvatar(id);
    const accent = resolveAccent(pack, { isOwner: false }, id);
    const w: Who = { name: id, pack, isOwner: false, accent };
    const x = 2 + (j % 10) * 20;
    const yy = y + Math.floor(j / 10) * 15;
    sprite(g, x, yy, framePixels(pack.body.idle), w, 'body');
    sprite(g, x + 4, yy + 9, framePixels(pack.head.idle), w, 'head');
    g.text(x, yy + 8, id.slice(0, 18), { fg: SPRITE_PALETTE[accent] ?? K.data });
  });
  y += Math.ceil(IDS.length / 10) * 15 + 1;

  title(g, 2, y, 'EVERY POSE', K.green);
  y += 5;
  const poses = ['idle', 'blink', 'talk', 'wave', 'think', 'celebrate', 'sleep'];
  IDS.slice(0, 5).forEach((id, j) => {
    const pack = defaultAvatar(id);
    const accent = resolveAccent(pack, { isOwner: false }, id);
    const w: Who = { name: id, pack, isOwner: false, accent };
    poses.forEach((p, k) => {
      const x = 2 + k * 20;
      sprite(g, x, y, framePixels(pack.body[p] ?? pack.body.idle), w, 'body');
      if (j === 0) g.text(x, y + 8, p, { fg: K.dim });
    });
    ['idle', 'blink', 'talk', 'sleep'].forEach((p, k) => {
      sprite(g, 2 + 7 * 20 + k * 11, y + 2, framePixels(pack.head[p] ?? pack.head.idle), w, 'head');
    });
    y += j === 0 ? 10 : 9;
  });
  if (y > rows) throw new Error(`defaults sheet needs ${y} rows`);
  return { g, used: y };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'docs/captures' } } });
  const out = values.out ?? 'docs/captures';
  process.stdout.write(`${await captureGrid(fitted(sheet), join(out, 'pixel-sheet.png'))}\n`);
  process.stdout.write(`${await captureGrid(fitted(defaults), join(out, 'pixel-defaults.png'))}\n`);
}

if (import.meta.main) await main();
