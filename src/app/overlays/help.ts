/**
 * Help: the instruction card (F1 or `?`). The keys from the plan's one precedence table, each with
 * what it does; a legend that draws every state the way the screen draws it (the gold chip, the
 * dotted frame, the lilac divider; each with its glyph and word, so it reads in NO_COLOR, where a
 * chip is underlined words as on screen, and only the failure banner keeps reverse video, as safety
 * emphasis: coordinator ruling, T9 fix round 2); and every
 * registered slash command with what it does. Two columns when wide, one when narrow; ↑↓ and
 * PgUp/PgDn scroll when it does not fit. Esc, F1 or `?` closes.
 */
import type { Grid, Rect } from '../../grid/grid.ts';
import { textWidth, wrap } from '../../grid/text.ts';
import { chip as chipStyle } from '../ink.ts';
import { allCommands, type Key, type KeyResult, type Overlay } from '../registry.ts';
import { T } from '../stage/theme.ts';
import type { AppState } from '../state.ts';
import { card, footer, isDown, isEsc, isUp } from './kit.ts';

export const HELP = 'help';

type Row =
  | { kind: 'head'; text: string }
  | { kind: 'key'; keys: string; what: string }
  | { kind: 'legend'; glyph: string; colour: string; name: string; what: string; chip: boolean }
  | { kind: 'gap' };

/** Every key, each with what it does. Alternatives for one action share a line (`F1, ?`). */
export const KEYS: readonly (readonly [string, string])[] = [
  ['Enter', 'send'],
  ['Shift+Enter', 'new line (Alt+Enter too)'],
  ['@', 'mention someone; Tab completes'],
  ['Ctrl+S', 'flip SIGNED / CASUAL (when armed)'],
  ['Ctrl+K', 'quick switcher'],
  ['Ctrl+B, ← (empty)', 'channel browser'],
  ['Ctrl+F', 'search this channel'],
  ['Tab', 'next lane that needs you'],
  ['Alt+1-9', 'go to lane N'],
  ['↑ (empty)', 'pick a message'],
  ['r', 'reply to the picked message'],
  ['1-9', 'vote on a picked poll'],
  ['c / s', 'copy / seen-by of the pick'],
  ['Ctrl+↑ ↓', 'pick, even with a draft'],
  ['Ctrl+U', 'mark read through the newest'],
  ['Ctrl+G', 'jump to latest'],
  ['Ctrl+O', 'load older'],
  ['Ctrl+R', 'reveal the next image'],
  ['Ctrl+V', 'attach a copied image (Mac)'],
  ['PgUp PgDn', 'scroll'],
  ['F2, Ctrl+\\', 'split / single screen (wide); click the layout chip'],
  ['Esc', 'clear pick, then reply, then notice'],
  ['F1, ? (empty)', 'this card'],
  ['Ctrl+Q, Ctrl+C', 'quit (draft kept)'],
];

/**
 * Each state as the screen draws it: `[glyph, colour, name, what, chip]`. A chip is drawn as the
 * screen's own chip (` ✓ SIGNED ` in dark ink on gold); the rest as the glyph and the word in the
 * colour.
 */
export const LEGEND: readonly (readonly [string, string, string, string, boolean?])[] = [
  ['✓', T.gold, 'SIGNED', "gold chip: Trey's signature checked out; gold means nothing else", true],
  ['┏━┓', T.red, 'FAILED', 'red frame and banner: claims Trey, do not act on it'],
  ['┌┈┐', T.gray, '? UNVERIFIED', 'dotted frame: signature not checked yet'],
  ['!', T.red, 'NEEDS YOU', 'a lane is waiting on you', true],
  ['P1', T.cyan, 'TREY', 'cyan is you: your messages, your cursor, @mentions of you', true],
  ['───', T.violet, 'NEW', 'unread below this line'],
  ['✓', T.green, 'READY!', 'an agent has read your latest'],
  ['✦', T.violet, 'EMOTE', 'an agent emoted; never wakes anyone'],
];

/** The legend's sample column: the widest sample (`┌┈┐ ? UNVERIFIED`) and a space. */
const LEGEND_COL =
  Math.max(
    ...LEGEND.map(([glyph, , name, , chip]) =>
      chip === true ? textWidth(` ${glyph} ${name} `) : 4 + textWidth(name),
    ),
  ) + 1;

/** A command's usage line as its form and what it does (`/dr — list decision records`). */
export function commandHelp(usage: string): { form: string; what: string } {
  const at = usage.indexOf(' — ');
  if (at < 0) return { form: usage.trim(), what: '' };
  return { form: usage.slice(0, at).trim(), what: usage.slice(at + 3).trim() };
}

function rows(): { left: Row[]; right: Row[] } {
  const left: Row[] = [{ kind: 'head', text: 'KEYS' }];
  for (const [keys, what] of KEYS) left.push({ kind: 'key', keys, what });
  const right: Row[] = [{ kind: 'head', text: 'LEGEND' }];
  for (const [glyph, colour, name, what, chip] of LEGEND)
    right.push({ kind: 'legend', glyph, colour, name, what, chip: chip === true });
  const commands = allCommands();
  if (commands.length > 0) {
    right.push({ kind: 'gap' }, { kind: 'head', text: 'COMMANDS' });
    for (const c of commands) {
      const { form, what } = commandHelp(c.usage);
      right.push({ kind: 'key', keys: form, what });
    }
  }
  return { left, right };
}

/** One screen line of the card: drawn at (x, y). */
type Line = (g: Grid, x: number, y: number) => void;

/**
 * A row as the lines it takes at width `w`. Nothing is cut off: descriptions wrap under themselves,
 * and a key (or a command's form) too wide for the label column takes a line of its own with the
 * description below it. Every key line carries its action beside or under it.
 */
export function lay(row: Row, w: number, mono = false): Line[] {
  switch (row.kind) {
    case 'head':
      return [(g, x, y) => g.text(x, y, row.text, { fg: T.orange, bold: true }, w)];
    case 'gap':
      return [() => {}];
    case 'key': {
      const kw = Math.min(15, Math.max(8, Math.floor(w * 0.4)));
      const labels = wrap(row.keys, w);
      const what = wrap(row.what, Math.max(1, w - kw));
      const key =
        (text: string): Line =>
        (g, x, y) =>
          g.text(x, y, text, { fg: T.white, bold: true }, w);
      const desc =
        (text: string): Line =>
        (g, x, y) =>
          g.text(x + kw, y, text, { fg: T.data }, w - kw);
      if (labels.some((l) => textWidth(l) > kw - 1)) return [...labels.map(key), ...what.map(desc)];
      return Array.from({ length: Math.max(labels.length, what.length) }, (_, i) => {
        const l = labels[i];
        const d = what[i];
        return (g: Grid, x: number, y: number) => {
          if (l !== undefined) key(l)(g, x, y);
          if (d !== undefined) desc(d)(g, x, y);
        };
      });
    }
    case 'legend': {
      // Every sample sits in one column, so every description starts at the same place; a card too
      // narrow for both puts the description under its sample.
      const chip = ` ${row.glyph} ${row.name} `;
      const sample: Line = (g, x, y) => {
        if (row.chip) g.text(x, y, chip, chipStyle(row.colour, T.glass, mono), w);
        else {
          g.text(x, y, row.glyph, { fg: row.colour, bold: true }, 4);
          g.text(x + 4, y, row.name, { fg: row.colour, bold: true }, w - 4);
        }
      };
      const beside = w - LEGEND_COL >= 24;
      const at = beside ? LEGEND_COL : 4;
      const what = wrap(row.what, Math.max(1, w - at)).map(
        (d): Line =>
          (g, x, y) =>
            g.text(x + at, y, d, { fg: T.data }, w - at),
      );
      if (!beside) return [sample, ...what];
      return what.map((d, i) => (g: Grid, x: number, y: number) => {
        if (i === 0) sample(g, x, y);
        d(g, x, y);
      });
    }
  }
}

const layAll = (rows: readonly Row[], w: number, mono: boolean): Line[] =>
  rows.flatMap((r) => lay(r, w, mono));

export function createHelp(): Overlay & { reset(): void } {
  let top = 0;
  let lastRows = 0;
  let lastCount = 0;
  return {
    id: HELP,
    reset() {
      top = 0;
    },
    draw(g: Grid, area: Rect, s: AppState): void {
      const inner = card(g, area, 'HOW TO PLAY', T.orange, { maxW: 120, mono: s.noColor === true });
      const { left, right } = rows();
      const two = inner.w >= 76;
      const half = Math.floor((inner.w - 3) / 2);
      const mono = s.noColor === true;
      const lines = two ? undefined : layAll([...left, { kind: 'gap' }, ...right], inner.w, mono);
      const leftLines = two ? layAll(left, half, mono) : [];
      const rightLines = two ? layAll(right, inner.w - half - 3, mono) : [];
      const count = lines?.length ?? Math.max(leftLines.length, rightLines.length);
      const view = Math.max(0, inner.h - 1);
      lastRows = view;
      lastCount = count;
      top = Math.max(0, Math.min(top, count - view));
      for (let i = 0; i < view; i++) {
        const y = inner.y + i;
        if (lines === undefined) {
          leftLines[top + i]?.(g, inner.x, y);
          g.put(inner.x + half + 1, y, '┆', { fg: T.deep });
          rightLines[top + i]?.(g, inner.x + half + 3, y);
        } else lines[top + i]?.(g, inner.x, y);
      }
      const more = top + view < count ? '↓ more · ' : '';
      footer(g, inner, `${more}Esc closes`);
    },
    key(k: Key, s: AppState): KeyResult {
      if (isEsc(k) || k.name === 'f1' || k.text === '?') {
        top = 0;
        s.actions.closeOverlay();
      } else if (isUp(k)) top = Math.max(0, top - 1);
      else if (isDown(k)) top = Math.min(Math.max(0, lastCount - lastRows), top + 1);
      else if (k.name === 'pageup') top = Math.max(0, top - Math.max(1, lastRows - 1));
      else if (k.name === 'pagedown')
        top = Math.min(Math.max(0, lastCount - lastRows), top + Math.max(1, lastRows - 1));
      return 'handled';
    },
  };
}
