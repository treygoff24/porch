/**
 * The foundation's demo scene: a sample arcade score bar, a big pixel-font title, one 16×16
 * half-block test sprite on Loom's glass ground with alternate-row scanlines, and one input line
 * that echoes what is typed or pasted. It exists to prove the pipeline (grid, host, input, animation
 * clock, capture, and keypress-to-echo latency for the renderer probe), not the design: the real
 * score bar, stage and composer belong to the app lanes. The lane names and counts are made up.
 *
 * Keys: Ctrl+C or Esc quits. Typed characters and bracketed pastes go into the echo line (a paste's
 * line breaks become spaces; any other control shows as U+FFFD, as the grid draws it); Backspace
 * deletes one grapheme, Ctrl+U clears the line, and Enter clears it and makes the sprite hop. A click
 * on the sprite hops it too, and a click on the mode chip toggles SIGNED/CASUAL. At rest nothing
 * moves and no frame is drawn; a hop is one finite burst on the animation clock. `PORCH_MOTION=
 * reduced|off` shows the end state only, so a hop draws nothing new. The status bar says AWAY while
 * the terminal reports that it has lost focus.
 */
import type { KeyEvent } from '@opentui/core';
import { T } from '../app/stage/theme.ts';
import { type Grid, type HitAction, type Style, scanlines } from '../grid/grid.ts';
import { halfBlocks, pixText, spritePixels } from '../grid/pixel.ts';
import { graphemes, textWidth, width } from '../grid/text.ts';
import type { Burst } from '../host/animation-clock.ts';
import type { HostApi, Scene } from '../host/grid-host.ts';

/**
 * Loom's cockpit colours that Porch keeps (Loom recon §3; the design contract's OWN-WORLD), taken
 * from the app's theme so the demo cannot drift from it.
 */
export const K = {
  glass: T.glass,
  scan: T.scan,
  bezel: T.bezel,
  bezelHi: T.bezelHi,
  white: T.white,
  data: T.data,
  gray: T.gray,
  grayDim: T.grayDim,
  green: T.green,
  cyan: T.cyan,
  magenta: T.magenta,
  red: T.red,
  violet: T.violet,
  youBg: T.youBg,
} as const;

export const DEMO_GROUND = scanlines(K.glass, K.scan, K.data);

/** The test sprite, 16×16 pixels (16 columns by 8 rows of half blocks). */
export const TEST_SPRITE: readonly string[] = [
  '.......mm.......',
  '.......gg.......',
  '....gggggggg....',
  '...gggggggggg...',
  '...gwwggggwwg...',
  '...gwkggggwkg...',
  '...gggggggggg...',
  '...ggkkkkkkgg...',
  '....gggggggg....',
  '.....dddddd.....',
  '..vvddddddddvv..',
  '..v.dddccddd.v..',
  '....dddccddd....',
  '....dddddddd....',
  '....dd....dd....',
  '...sss....sss...',
];
const SPRITE_KEYS: Readonly<Record<string, string>> = {
  m: K.magenta,
  g: K.green,
  w: K.white,
  k: '#0b1015',
  d: '#1f8a45',
  v: K.violet,
  c: K.cyan,
  s: K.gray,
};

/** How many cell rows above rest the sprite is at each of the hop's eight frames. */
const HOP = [0, 1, 2, 2, 1, 0, 1, 0] as const;
const HOP_FRAME_MS = 125;
const HOP_MS = HOP.length * HOP_FRAME_MS;

const LANES = [
  { name: 'porch-rebuild', unread: 4, trend: [1, 2, 2, 4, 6, 7], needs: false },
  { name: 'dwp-portals', unread: 12, trend: [5, 4, 3, 5, 6, 8], needs: true },
  { name: 'hangout', unread: 0, trend: [2, 1, 1, 0, 0, 0], needs: false },
] as const;

const TITLE_ROWS = [K.magenta, '#e67ef0', K.violet, '#8fb6f8', K.cyan] as const;

function spark(values: readonly number[]): string {
  const max = Math.max(1, ...values);
  return values.map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((v / max) * 7))]).join('');
}

export type DemoOptions = {
  /** `PORCH_MOTION`: `reduced` or `off` shows end states only. */
  motion?: string | undefined;
};

export type DemoScene = Scene & {
  /** Whether the chip says SIGNED (for tests). */
  readonly signed: boolean;
  /** The echo line's text (for tests). */
  readonly line: string;
};

/** Text for the echo line: one line, so a paste's line breaks become spaces. */
function oneLine(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ');
}

export function demoScene(opts: DemoOptions = {}): DemoScene {
  const still = opts.motion === 'reduced' || opts.motion === 'off';
  let signed = false;
  let line = '';
  let hopping: Burst | undefined;

  const hop = (host: HostApi) => {
    if (still || hopping !== undefined) return;
    hopping = host.animate(HOP_MS);
  };

  const hopOffset = (host: HostApi): number => {
    if (hopping === undefined) return 0;
    const t = host.now();
    if (t >= hopping.end) {
      // The burst is over: this frame is the end state, and the clock has stopped (or will).
      hopping = undefined;
      return 0;
    }
    return HOP[Math.max(0, Math.floor((t - hopping.start) / HOP_FRAME_MS))] ?? 0;
  };

  const scene: DemoScene = {
    ground: DEMO_GROUND,
    get signed() {
      return signed;
    },
    get line() {
      return line;
    },
    draw(g: Grid, host: HostApi) {
      const compact = g.cols < 46;
      let y = compact ? compactBar(g, signed) : fullBar(g, signed);
      y += 1;

      const scale = g.cols >= 150 && g.rows >= 40 ? 4 : g.cols >= 90 ? 3 : 2;
      const title = pixText('PORCH', (r) => TITLE_ROWS[r] ?? K.cyan, { sx: scale, sy: scale });
      g.blit(Math.max(0, Math.floor((g.cols - title.w) / 2)), y, halfBlocks(title.px));
      y += title.h / 2 + 1;

      const tagline = "the human's seat at the agents' table";
      g.text(Math.max(0, Math.floor((g.cols - textWidth(tagline)) / 2)), y, tagline, {
        fg: K.gray,
        italic: true,
      });
      y += 3;

      // The stage: the sprite on a floor, its name, and its magenta task line.
      const sx = Math.floor((g.cols - 16) / 2);
      const rest = y;
      const lift = hopOffset(host);
      g.blit(sx, rest - lift, halfBlocks(spritePixels(TEST_SPRITE, SPRITE_KEYS)));
      g.hit({ x: sx, y: rest - 2, w: 16, h: 10 }, { id: 'hop' });
      const floor = rest + 8;
      g.rule(Math.max(0, sx - 6), floor, 28, '▀', { fg: K.bezelHi });
      centred(g, floor + 1, 'TEST BOT', { fg: K.green, bold: true });
      centred(g, floor + 2, lift > 0 ? 'hop!' : 'checking the half-block pipeline', {
        fg: K.magenta,
      });

      echoLine(g, g.rows - 2, line);

      const status = compact
        ? 'DEMO · ^C quit · type to echo'
        : 'DEMO · ^C or esc quit · type to echo · enter or click the bot to hop · click the chip to sign';
      g.fill({ x: 0, y: g.rows - 1, w: g.cols, h: 1 }, { bg: K.bezel });
      const away = host.focused() ? '' : ' AWAY ';
      const awayW = textWidth(away);
      g.text(1, g.rows - 1, status, { fg: K.gray, bg: K.bezel }, g.cols - 2 - awayW);
      if (awayW > 0)
        g.text(g.cols - awayW, g.rows - 1, away, { fg: K.glass, bg: K.gray, bold: true });
    },
    key(key: KeyEvent, host: HostApi) {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        host.quit();
        return false;
      }
      if (key.name === 'return' || key.name === 'enter') {
        hop(host);
        if (line === '') return false;
        line = '';
        return true;
      }
      if (key.name === 'backspace') {
        if (line === '') return false;
        line = graphemes(line).slice(0, -1).join('');
        return true;
      }
      if (key.ctrl && key.name === 'u') {
        if (line === '') return false;
        line = '';
        return true;
      }
      const text = key.sequence;
      if (key.ctrl || key.meta || text === '' || !printable(text)) return false;
      line += text;
      return true;
    },
    paste(text: string) {
      const add = oneLine(text);
      if (add === '') return false;
      line += add;
      return true;
    },
    hit(action: HitAction, host: HostApi) {
      if (action.id === 'hop') {
        hop(host);
        return false;
      }
      if (action.id === 'sign') {
        signed = !signed;
        return true;
      }
      return false;
    },
    focus() {
      return true;
    },
  };
  return scene;
}

/** A key's text is typed only if it has no control character in it (an unmapped escape, say). */
function printable(s: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
  return !/[\u0000-\u001f\u007f-\u009f]/.test(s);
}

/**
 * The echo line: a prompt, the tail of the text that fits, and a block cursor. Empty, it shows a
 * hint instead.
 */
function echoLine(g: Grid, y: number, line: string): void {
  if (y < 0) return;
  g.fill({ x: 0, y, w: g.cols, h: 1 }, { bg: K.glass });
  g.text(1, y, '▸', { fg: K.cyan, bold: true });
  const room = Math.max(0, g.cols - 5);
  if (line === '') {
    g.put(3, y, ' ', { bg: K.cyan });
    g.text(5, y, 'type here', { fg: K.grayDim, italic: true }, room - 2);
    return;
  }
  // The tail that fits, measured in columns (a tab counts as up to four).
  const gs = graphemes(line);
  let used = 0;
  let from = gs.length;
  while (from > 0) {
    const g0 = gs[from - 1] ?? '';
    const w = g0 === '\t' ? 4 : width(g0);
    if (used + w > room) break;
    used += w;
    from -= 1;
  }
  const shown = gs.slice(from).join('');
  const n = g.text(3, y, shown, { fg: K.white }, room);
  g.put(3 + n, y, ' ', { bg: K.cyan });
}

function centred(g: Grid, y: number, s: string, style: Style): void {
  g.text(Math.max(0, Math.floor((g.cols - textWidth(s)) / 2)), y, s, style);
}

/** The phone's score bar: one line, then a half-block rule. Returns the rows it took. */
function compactBar(g: Grid, signed: boolean): number {
  g.fill({ x: 0, y: 0, w: g.cols, h: 1 }, { bg: K.bezel });
  g.text(1, 0, 'P1', { fg: K.cyan, bold: true, bg: K.bezel });
  const lane = LANES[0];
  let x = 4 + g.text(4, 0, `▸${lane.name.toUpperCase()}`, { fg: K.glass, bg: K.cyan, bold: true });
  x += 1;
  x += g.text(x, 0, String(lane.unread).padStart(2, '0'), {
    fg: K.data,
    bg: K.bezel,
    bold: true,
  });
  g.text(x, 0, '▲', { fg: K.magenta, bg: K.bezel });
  const needs = LANES.filter((l) => l.needs).length;
  const label = `!${needs} NEED`;
  const chip = signed ? '●' : '○';
  const lx = g.cols - textWidth(label) - 3;
  g.text(lx, 0, label, { fg: K.red, bg: K.bezel, bold: true });
  g.text(g.cols - 2, 0, chip, { fg: signed ? K.cyan : K.gray, bg: K.bezel, bold: true });
  g.hit({ x: g.cols - 2, y: 0, w: 1, h: 1 }, { id: 'sign' });
  g.rule(0, 1, g.cols, '▀', { fg: K.bezel });
  return 2;
}

/** The laptop and wide score bar: two rows (1UP, lanes, mode chip), then a rule. */
function fullBar(g: Grid, signed: boolean): number {
  const bar = K.bezel;
  g.fill({ x: 0, y: 0, w: g.cols, h: 2 }, { bg: bar });
  g.text(2, 0, '1UP', { fg: K.cyan, bold: true, bg: bar });
  g.text(6, 0, 'TREY', { fg: K.white, bold: true, bg: bar });
  g.text(2, 1, '^K STAGES', { fg: K.gray, bg: bar });

  const chipW = 12;
  const chipX = g.cols - chipW - 1;
  const chipBg = signed ? K.cyan : K.bezelHi;
  const chipFg = signed ? K.glass : K.data;
  g.fill({ x: chipX, y: 0, w: chipW, h: 2 }, { bg: chipBg });
  const chip = signed ? 'SIGNED ●' : 'CASUAL ○';
  g.text(chipX + Math.floor((chipW - textWidth(chip)) / 2), 0, chip, {
    fg: chipFg,
    bg: chipBg,
    bold: true,
  });
  g.text(
    chipX + 1,
    1,
    signed ? '^S → casual' : '^S → sign',
    { fg: signed ? K.glass : K.gray, bg: chipBg },
    chipW - 1,
  );
  g.hit({ x: chipX, y: 0, w: chipW, h: 2 }, { id: 'sign' });

  const x0 = 15;
  const laneW = Math.floor((chipX - 1 - x0) / LANES.length);
  LANES.forEach((lane, i) => {
    const x = x0 + i * laneW;
    const w = laneW - 1;
    const current = i === 0;
    const bg = current ? K.cyan : bar;
    const fg = current ? K.glass : K.data;
    g.fill({ x, y: 0, w, h: 2 }, { bg });
    g.text(x + 1, 0, `${i + 1} ${lane.name.toUpperCase()}`, { fg, bg, bold: true }, w - 1);
    let cx = x + 1 + g.text(x + 1, 1, String(lane.unread).padStart(4, '0'), { fg, bg, bold: true });
    cx += 1;
    g.text(cx, 1, spark(lane.trend), { fg: current ? K.glass : K.magenta, bg }, x + w - cx);
    if (lane.needs) {
      const label = w >= 30 ? ' ! NEEDS YOU ' : w >= 22 ? ' ! NEEDS ' : ' ! ';
      g.text(x + w - textWidth(label) - 1, 1, label, { fg: K.glass, bg: K.red, bold: true });
    }
  });
  g.rule(0, 2, g.cols, '▀', { fg: bar });
  return 3;
}
