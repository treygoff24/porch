/**
 * The attract screen: the arcade cabinet's idle loop, drawn over the whole screen. It shows the
 * PORCH title, the crew whose avatars post holds, a high-score table of the live channels by their
 * message count (post's own count from `post channels`, nothing invented), and "PRESS ANY KEY".
 *
 * Motion (ruling 4): one bounded burst of {@link ATTRACT_MS} in which the title's colours cycle and
 * the crew hop one after another, then a still frame that draws nothing more. Reduced and off
 * motion show only the still frame.
 *
 * The first-launch marker lives at `~/.local/state/porch-next/attract-seen` (plan T7);
 * `PORCH_STATE_DIR` moves it, which is how tests point it at a temporary directory.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { framePixels, resolveAccent } from '@estate/pixel';
import type { Grid, Rect } from '../../grid/grid.ts';
import { halfBlocks, pixText } from '../../grid/pixel.ts';
import { textWidth } from '../../grid/text.ts';
import { monoPixels, monoThinPixels } from '../mono-art.ts';
import type { AppState } from '../state.ts';
import { packFor } from './crew.ts';
import { drawSprite, SIZE, type Target } from './sprites.ts';
import { centre, trunc } from './text.ts';
import { T, TITLE_ROWS } from './theme.ts';

/** The attract loop's one burst: sixteen frames at 8 fps. */
export const ATTRACT_MS = 2000;
export const PRESS_ANY_KEY = '▶ PRESS ANY KEY ◀';
/** The hit action covering the attract screen (a click dismisses it, like a key). */
export const ATTRACT_HIT = 'stage:attract';

/** Where the first-launch marker lives. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PORCH_STATE_DIR;
  return dir !== undefined && dir !== '' ? dir : join(homedir(), '.local', 'state', 'porch-next');
}

export const MARKER = 'attract-seen';

/** Whether porch-next has shown its attract screen on this account before. */
export function attractSeen(dir: string): boolean {
  return existsSync(join(dir, MARKER));
}

/** Record that it has. A failure to write is not fatal: the screen shows again next launch. */
export function markAttractSeen(dir: string, at: Date = new Date()): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, MARKER), `${at.toISOString()}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST';
  }
}

const RANKS = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH'] as const;

/**
 * Draw the attract screen. `k` is the burst's sub-tick (0-15) while it animates, or undefined for
 * the still frame.
 */
export function drawAttract(g: Grid, area: Rect, s: AppState, k: number | undefined): void {
  g.fill(area, { bg: T.glass });
  for (let y = area.y + 1; y < area.y + area.h; y += 2)
    g.fill({ x: area.x, y, w: area.w, h: 1 }, { bg: T.scan });
  g.hit(area, { id: ATTRACT_HIT });
  const compact = area.w < 60;
  const cx = area.x;
  let y = area.y + (compact ? 3 : 2);

  const scale = area.w >= 150 && area.h >= 40 ? 4 : area.w >= 90 ? 3 : 2;
  const shift = k ?? 0;
  const title = pixText('PORCH', (r) => TITLE_ROWS[(r + shift) % TITLE_ROWS.length] ?? T.violet, {
    sx: scale,
    sy: scale,
  });
  // NO_COLOR: line work from scale 3 up; below that a stroke is all edge (line work would light it
  // solid), so the phone's logo is a dither.
  const mono = scale >= 3 ? monoPixels : monoThinPixels;
  g.blit(
    cx + Math.max(0, Math.floor((area.w - title.w) / 2)),
    y,
    halfBlocks(s.noColor === true ? mono(title.px) : title.px),
  );
  y += title.h / 2 + 1;

  const tagline = "the human's seat at the agents' table";
  g.text(centre(cx, area.w, trunc(tagline, area.w)), y, trunc(tagline, area.w), {
    fg: T.gray,
    italic: true,
  });
  y += 2;

  // The crew: Trey and every agent whose avatar post holds, as many as fit.
  const target: Target = compact || area.h < 36 ? 'head' : 'body';
  const size = SIZE[target];
  const slot = size.w + 2;
  const ids = [
    s.owner.participant,
    ...[...s.avatars.keys()].filter((id) => id !== s.owner.participant),
  ];
  const shown = ids.slice(0, Math.max(1, Math.floor(area.w / slot)));
  const x0 = cx + Math.max(0, Math.floor((area.w - shown.length * slot) / 2)) + 1;
  const crewArea = { x: area.x, y: y, w: area.w, h: size.h + 1 };
  shown.forEach((id, i) => {
    const isOwner = id === s.owner.participant;
    const pack = packFor(id, s);
    const accent = resolveAccent(pack, { isOwner }, id);
    const lift = k !== undefined && Math.floor(k / 2) % shown.length === i ? 1 : 0;
    drawSprite(
      g,
      x0 + i * slot,
      y + 1,
      target,
      framePixels(pack[target].idle),
      { isOwner, accent, mono: s.noColor === true },
      crewArea,
      undefined,
      lift,
    );
  });
  y += size.h + 2;

  // "Press any key" blinks at 2 Hz while the burst runs, and stays lit in the still frame.
  if (k === undefined || k % 4 < 2)
    g.text(centre(cx, area.w, PRESS_ANY_KEY), y, PRESS_ANY_KEY, { fg: T.orange, bold: true });
  y += 2;

  const live = s.channels
    .filter((c) => !c.archived && c.messages !== undefined)
    .sort((a, b) => (b.messages ?? 0) - (a.messages ?? 0) || a.name.localeCompare(b.name));
  const rows = Math.min(live.length, RANKS.length, Math.max(0, area.y + area.h - 3 - (y + 2)));
  if (rows > 0) {
    const tw = Math.min(40, area.w - 4);
    const tx = cx + Math.floor((area.w - tw) / 2);
    const heading = 'HIGH SCORES';
    g.text(centre(cx, area.w, heading), y, heading, { fg: T.pink, bold: true });
    g.rule(tx, y + 1, tw, '─', { fg: T.deep });
    y += 2;
    for (let i = 0; i < rows; i++) {
      const c = live[i];
      if (c === undefined) break;
      const score = String(c.messages ?? 0)
        .padStart(5, '0')
        .slice(-5);
      const nameCols = Math.max(1, tw - 4 - 7);
      const name = trunc(c.name.toUpperCase(), nameCols);
      g.text(tx, y + i, RANKS[i] ?? '', { fg: T.gray });
      g.text(tx + 4, y + i, name, { fg: T.data, bold: true });
      const dots = tw - 4 - textWidth(name) - 7;
      if (dots > 0) g.text(tx + 5 + textWidth(name), y + i, '·'.repeat(dots), { fg: T.grayDim });
      g.text(tx + tw - 5, y + i, score, { fg: T.violet, bold: true });
    }
  }

  const bottom = area.y + area.h - 1;
  g.text(area.x + 2, bottom, 'CREDIT 01', { fg: T.gray });
  const brand = 'porch-next';
  if (area.w > 24) g.text(area.x + area.w - textWidth(brand) - 2, bottom, brand, { fg: T.gray });
}
