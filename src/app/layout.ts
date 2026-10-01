/**
 * Where everything goes (plan T6, "Layouts"; design contract, FIRST VIEWPORT).
 *
 * Top to bottom: the score bar, then one pane (two on wide when split) with its stage strip and its
 * message stream, then the crossed-while-typing strip when there is one, the composer's rule row,
 * the composer, and the status line.
 *
 * - Phone (under 60 columns): a one-line score bar, and the stage is always one row of heads.
 * - Laptop (60–139) and wide (140 and over): a two-line score bar. Wide splits into two panes with
 *   a one-column divider unless the split is toggled off.
 * - A pane's stage shows full bodies when its height leaves at least 12 stream rows under the
 *   bodies strip; otherwise one row of heads. The rule depends on height only, not on the split.
 * - Under the stage, one floor row: the edge the crew stand on, so the stream below starts clear of
 *   the task lines. In a split it carries the pane's channel and which pane has focus.
 */
import type { Rect } from '../grid/grid.ts';
import type { StageFit } from './registry.ts';
import type { LayoutKind } from './state.ts';

/** Stream rows a bodies stage must leave below it, or the stage collapses to heads. */
export const MIN_STREAM_ROWS = 12;
/** The stage's floor under each strip. */
export const FLOOR_ROWS = 1;
/** The core's own strip heights, used until a stage registers its own. */
export const DEFAULT_STAGE_HEIGHT: Readonly<Record<StageFit, number>> = { bodies: 10, heads: 6 };

export function layoutKind(cols: number): LayoutKind {
  return cols < 60 ? 'phone' : cols < 140 ? 'laptop' : 'wide';
}

export type PaneLayout = {
  /** The whole pane: stage and stream. */
  rect: Rect;
  /** The stage strip, absent when the pane is too short for even a row of heads. */
  stage: Rect | undefined;
  /** The stage's floor: one row between the stage and the stream (absent with the stage). */
  floor: Rect | undefined;
  fit: StageFit;
  stream: Rect;
};

export type ScreenLayout = {
  kind: LayoutKind;
  cols: number;
  rows: number;
  score: Rect;
  panes: PaneLayout[];
  /** The one-column divider between split panes. */
  divider: Rect | undefined;
  crossed: Rect | undefined;
  composerRule: Rect;
  composer: Rect;
  status: Rect;
};

export type LayoutInput = {
  cols: number;
  rows: number;
  split: boolean;
  composerRows: number;
  crossedRows: number;
  stageHeight(fit: StageFit): number;
};

/** The largest number of rows the composer grows to before it scrolls. */
export function composerMaxRows(kind: LayoutKind): number {
  return kind === 'phone' ? 4 : 5;
}

export function computeLayout(input: LayoutInput): ScreenLayout {
  const { cols, rows } = input;
  const kind = layoutKind(cols);
  const scoreRows = kind === 'phone' ? 2 : 3;
  const status: Rect = { x: 0, y: rows - 1, w: cols, h: 1 };
  const composerRows = Math.max(1, Math.min(input.composerRows, composerMaxRows(kind)));
  const composer: Rect = { x: 0, y: status.y - composerRows, w: cols, h: composerRows };
  const composerRule: Rect = { x: 0, y: composer.y - 1, w: cols, h: 1 };
  // The strip never takes the stream's last rows: it shrinks to what leaves six.
  const middleTop = scoreRows;
  const room = composerRule.y - middleTop;
  const crossedRows = Math.max(0, Math.min(input.crossedRows, room - 6));
  const crossed: Rect | undefined =
    crossedRows > 0
      ? { x: 0, y: composerRule.y - crossedRows, w: cols, h: crossedRows }
      : undefined;
  const middle: Rect = { x: 0, y: middleTop, w: cols, h: Math.max(0, room - crossedRows) };
  const split = kind === 'wide' && input.split;
  const rects: Rect[] = [];
  let divider: Rect | undefined;
  if (split) {
    const left = Math.floor((cols - 1) / 2);
    rects.push({ x: 0, y: middle.y, w: left, h: middle.h });
    divider = { x: left, y: middle.y, w: 1, h: middle.h };
    rects.push({ x: left + 1, y: middle.y, w: cols - left - 1, h: middle.h });
  } else rects.push(middle);
  const panes = rects.map((rect) => paneLayout(rect, kind, input.stageHeight));
  return {
    kind,
    cols,
    rows,
    score: { x: 0, y: 0, w: cols, h: scoreRows },
    panes,
    divider,
    crossed,
    composerRule,
    composer,
    status,
  };
}

function paneLayout(
  rect: Rect,
  kind: LayoutKind,
  stageHeight: (fit: StageFit) => number,
): PaneLayout {
  const bodies = stageHeight('bodies');
  const heads = stageHeight('heads');
  const fit: StageFit =
    kind !== 'phone' && rect.h - bodies - FLOOR_ROWS >= MIN_STREAM_ROWS ? 'bodies' : 'heads';
  const h = fit === 'bodies' ? bodies : heads;
  // A pane too short for heads, the floor and three stream rows keeps the stream and drops both.
  if (rect.h - h - FLOOR_ROWS < 3)
    return { rect, stage: undefined, floor: undefined, fit: 'heads', stream: rect };
  const below = rect.y + h + FLOOR_ROWS;
  return {
    rect,
    stage: { x: rect.x, y: rect.y, w: rect.w, h },
    floor: { x: rect.x, y: rect.y + h, w: rect.w, h: FLOOR_ROWS },
    fit,
    stream: { x: rect.x, y: below, w: rect.w, h: rect.y + rect.h - below },
  };
}
