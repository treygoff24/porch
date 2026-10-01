/**
 * One frame of the main screen, drawn from the model's snapshot (design contract, FIRST VIEWPORT):
 * the score bar, each pane's stage strip and stream, the crossed-while-typing strip, the composer
 * with its mode chip, the status line, then the mentions picker and any overlay on top.
 *
 * Nothing here moves by itself. The needs-you flash reads the burst the model started on the
 * animation clock; every other cell is a function of the snapshot.
 */
import { isMember } from '@estate/post-kit';
import type { Grid, Rect, Style } from '../grid/grid.ts';
import { textWidth } from '../grid/text.ts';
import * as edit from './composer.ts';
import { preview } from './derive.ts';
import { accentOf, bodyCells, headCells } from './heads.ts';
import { chip, clip, fitLabel, say, sayRight } from './ink.ts';
import { computeLayout, DEFAULT_STAGE_HEIGHT, type ScreenLayout } from './layout.ts';
import type { AppModel } from './model.ts';
import { allCommands, currentStage, overlay as findOverlay, type StagePane } from './registry.ts';
import type { AppState, ChannelState } from './state.ts';
import { drawStream } from './stream.ts';
import { K } from './theme.ts';

/** Rows the crossed strip takes: its title and up to three messages. */
export function crossedRows(s: AppState): number {
  if (s.crossed === undefined || s.crossed.channel !== s.current) return 0;
  return 1 + Math.min(3, s.crossed.crossed.messages.length);
}

/** The composer's text width at this size (the prompt and, on laptop and wide, the chip). */
export function composerWidth(cols: number, phone: boolean): number {
  return cols - (phone ? 5 : 6) - (phone ? 1 : 13);
}

export function screenLayout(m: AppModel, s: AppState): ScreenLayout {
  const phone = s.layout === 'phone';
  const lines = edit.visualLines(s.composer.text, composerWidth(s.cols, phone));
  const stage = currentStage();
  return computeLayout({
    cols: s.cols,
    rows: s.rows,
    split: m.isSplit(),
    composerRows: lines.length,
    crossedRows: crossedRows(s),
    stageHeight: (fit) => stage?.height(fit) ?? DEFAULT_STAGE_HEIGHT[fit],
  });
}

export function drawScreen(g: Grid, m: AppModel): void {
  m.resize(g.cols, g.rows);
  const s = m.state();
  const L = screenLayout(m, s);
  drawScoreBar(g, L.score, s, m);
  L.panes.forEach((p, i) => {
    const pane = s.panes[i];
    if (pane === undefined) return;
    const focused = i === s.focusedPane;
    // The pane's own target first: what the stage and the stream register later sits on top, so a
    // click on a message, a reply chip or a divider reaches it, and anywhere else focuses the pane.
    if (L.panes.length > 1) g.hit(p.rect, { id: 'pane', data: i });
    if (p.stage !== undefined) {
      const sp: StagePane = { channel: pane.channel, fit: p.fit, focused };
      const stage = currentStage();
      g.withClip(p.stage, () => {
        if (stage !== undefined) stage.draw(g, p.stage as Rect, sp, s);
        else drawRestingStage(g, p.stage as Rect, sp, s);
      });
    }
    if (p.floor !== undefined)
      drawFloor(g, p.floor, pane.channel, L.panes.length > 1, focused, s.noColor === true);
    const result = drawStream(g, p.stream, pane, i, s, { ensurePick: m.ensurePick && focused });
    if (focused) m.ensurePick = false;
    m.paneViews.set(i, {
      channel: pane.channel,
      visible: result.visible,
      streamRows: p.stream.h,
    });
    m.clampScroll(i, result.scroll);
  });
  if (L.divider !== undefined)
    for (let y = L.divider.y; y < L.divider.y + L.divider.h; y++)
      g.put(L.divider.x, y, '│', { fg: K.bezelHi });
  if (L.crossed !== undefined) drawCrossed(g, L.crossed, s);
  drawComposer(g, L, s, m);
  drawStatus(g, L.status, s, m);
  if (m.pickerOpen()) drawPicker(g, L, m, s.noColor === true);
  if (s.overlay !== undefined) {
    // An overlay owns the whole screen: it decides what of the app shows around it.
    const o = findOverlay(s.overlay);
    const area: Rect = { x: 0, y: 0, w: s.cols, h: s.rows };
    if (o !== undefined) g.withClip(area, () => o.draw(g, area, s));
  } else if (m.helpFallback)
    drawHelpFallback(g, { x: 0, y: L.score.h, w: s.cols, h: L.composerRule.y - L.score.h });
  const over = currentStage()?.drawOver;
  if (over !== undefined) over(g, { x: 0, y: 0, w: s.cols, h: s.rows }, s);
}

// ── score bar ────────────────────────────────────────────────────────────────────────────────

/** Is the lane's needs-you flash in an "off" phase right now (three on-off flashes)? */
function flashOff(m: AppModel, channel: string, now: number): boolean {
  const b = m.flashes.get(channel);
  if (b === undefined || now < b.start || now >= b.end) return false;
  return Math.floor((now - b.start) / 125) % 2 === 1;
}

const TREND: Record<ChannelState['trend'], { glyph: string; word: string; fg: string }> = {
  up: { glyph: '▲', word: 'UP', fg: K.green },
  flat: { glyph: '─', word: 'FLAT', fg: K.gray },
  down: { glyph: '▼', word: 'DOWN', fg: K.gray },
};

function drawScoreBar(g: Grid, area: Rect, s: AppState, m: AppModel): void {
  const lanes = m.lanes();
  // NO_COLOR: the current lane and every chip (`!2 NEED`, `! NEEDS YOU`) are bold underlined
  // words, never a solid lit bar; a needs-you flash blinks the underline instead of the fill.
  const mono = s.noColor === true;
  if (s.layout === 'phone') {
    g.fill({ x: 0, y: 0, w: area.w, h: 1 }, { bg: K.bezel });
    // Trey's marker stays in his post records; Porch never draws an emoji as art.
    let x = say(g, 1, 0, 'P1', { fg: K.cyan, bg: K.bezel, bold: true }, area.w);
    // Armed is separate from the next send's mode (the composer's chip): a key, or a red ✗ when
    // post and Porch disagree about the owner and signing is refused.
    if (s.signingBlocked !== undefined)
      x = say(g, x + 1, 0, '✗', { fg: K.red, bg: K.bezel, bold: true }, area.w);
    else if (s.armed) x = say(g, x + 1, 0, '⚿', { fg: K.green, bg: K.bezel, bold: true }, area.w);
    const cur = s.current === undefined ? undefined : s.views.get(s.current);
    const needing = lanes.filter((l) => s.views.get(l)?.needsYou === true);
    const right = needing.length > 0 ? ` !${needing.length} NEED ` : ' ALL CLEAR ';
    const rightW = textWidth(right);
    if (s.current !== undefined) {
      const label = `▸${s.current.toUpperCase()}`;
      const nx = say(
        g,
        x + 1,
        0,
        clip(label, area.w - x - rightW - 9),
        mono
          ? { fg: K.data, bg: K.bezel, bold: true, underline: true }
          : { fg: K.glass, bg: K.cyan, bold: true },
        area.w - rightW - 7,
      );
      g.hit({ x: x + 1, y: 0, w: nx - x - 1, h: 1 }, { id: 'overlay', data: 'switcher' });
      x = nx;
      if (cur !== undefined) {
        const unread = String(cur.summary?.unread ?? 0).padStart(2, '0');
        x = say(g, x + 1, 0, unread, { fg: K.data, bg: K.bezel, bold: true }, area.w - rightW - 1);
        const t = TREND[cur.trend];
        x = say(g, x, 0, t.glyph, { fg: t.fg, bg: K.bezel }, area.w - rightW - 1);
      }
    }
    const off = needing.some((l) => flashOff(m, l, s.now));
    const rx = sayRight(
      g,
      area.w - 1,
      0,
      right,
      needing.length > 0
        ? off
          ? { fg: K.red, bg: K.bezel, bold: true }
          : chip(K.red, K.glass, mono)
        : { fg: K.green, bg: K.bezel },
      x + 1,
    );
    g.hit({ x: rx, y: 0, w: area.w - 1 - rx, h: 1 }, { id: 'next-needs' });
    g.rule(0, 1, area.w, '▀', { fg: K.bezel });
    return;
  }
  // Laptop and wide: two rows and a rule.
  g.fill({ x: 1, y: 0, w: 14, h: 2 }, { bg: K.bezel });
  let x = say(g, 2, 0, '1UP', { fg: K.cyan, bg: K.bezel, bold: true }, 15);
  // 1UP and Trey's name stand alone: his marker stays in post records, never drawn as art.
  x = say(
    g,
    x + 1,
    0,
    clip(s.owner.label.toUpperCase(), 9),
    { fg: K.data, bg: K.bezel, bold: true },
    15,
  );
  say(g, 2, 1, '^K STAGES', { fg: K.gray, bg: K.bezel }, 15);
  g.hit({ x: 1, y: 0, w: 14, h: 2 }, { id: 'overlay', data: 'switcher' });
  const chipW = 14;
  const chipX = area.w - chipW - 1;
  drawModeChip(g, chipX, chipW, s);
  const lx0 = 16;
  const avail = chipX - 1 - lx0;
  const minW = 14;
  const shown = Math.max(1, Math.min(lanes.length, Math.floor(avail / minW)));
  const laneW = lanes.length === 0 ? avail : Math.floor(avail / Math.min(lanes.length, shown));
  if (lanes.length === 0)
    say(g, lx0 + 1, 0, 'no lanes yet: no joined channels', { fg: K.gray }, chipX - 1);
  // When there are more lanes than fit, the current one is always among those shown.
  let first = 0;
  const curIdx = s.current === undefined ? -1 : lanes.indexOf(s.current);
  if (curIdx >= shown) first = curIdx - shown + 1;
  for (let k = 0; k < Math.min(shown, lanes.length - first); k++) {
    const i = first + k;
    const name = lanes[i] as string;
    const view = s.views.get(name);
    const lx = lx0 + k * laneW;
    const w = laneW - 1;
    const cur = name === s.current;
    const needs = view?.needsYou === true;
    const off = flashOff(m, name, s.now);
    const lit = cur && !mono;
    const bg = lit ? K.cyan : K.bezel;
    const fg = lit ? K.glass : K.data;
    g.fill({ x: lx, y: 0, w, h: 2 }, { bg });
    say(
      g,
      lx + 1,
      0,
      clip(`${i + 1} ${name.toUpperCase()}`, w - 2),
      { fg, bg, bold: true, underline: cur && mono },
      lx + w,
    );
    const unread = String(view?.summary?.unread ?? 0).padStart(3, '0');
    let cx = say(g, lx + 1, 1, unread, { fg, bg, bold: true }, lx + w);
    const t = TREND[view?.trend ?? 'flat'];
    cx = say(g, cx + 1, 1, t.glyph, { fg: lit ? K.glass : t.fg, bg, bold: true }, lx + w);
    const needLabel = needs ? (w >= 22 ? ' ! NEEDS YOU ' : ' ! ') : '';
    const room = lx + w - textWidth(needLabel) - 1;
    if (cx + 1 + textWidth(t.word) <= room)
      say(g, cx + 1, 1, t.word, { fg: lit ? K.glass : t.fg, bg }, room);
    if (needs) {
      const style: Style = off ? { fg: K.red, bg, bold: true } : chip(K.red, K.glass, mono);
      sayRight(g, lx + w, 1, needLabel, style, lx + 1);
    }
    g.hit({ x: lx, y: 0, w, h: 2 }, { id: 'lane', data: name });
  }
  if (lanes.length > shown) {
    const more = `+${lanes.length - shown}`;
    sayRight(g, chipX - 1, 0, more, { fg: K.gray, bold: true }, lx0);
  }
  g.rule(0, 2, area.w, '▀', { fg: K.bezel });
}

/** The SIGNED/CASUAL chip and, under it, whether signing is armed. Gold never appears here. */
function drawModeChip(g: Grid, x: number, w: number, s: AppState): void {
  // NO_COLOR draws signed mode as underlined words, never a solid lit block.
  const signed = s.mode === 'signed' && s.noColor !== true;
  const bg = signed ? K.cyan : K.bezel;
  const fg = signed ? K.glass : K.data;
  g.fill({ x, y: 0, w, h: 2 }, { bg });
  const t = s.mode === 'signed' ? 'SIGNED ●' : 'CASUAL ○';
  say(
    g,
    x + Math.floor((w - textWidth(t)) / 2),
    0,
    t,
    { fg, bg, bold: true, underline: s.mode === 'signed' && !signed },
    x + w,
  );
  const armed =
    s.signingBlocked !== undefined
      ? { text: '✗ NO SIGNING', fg: signed ? K.glass : K.red }
      : s.armed
        ? { text: signed ? '^S → casual' : '⚿ ARMED ^S', fg: signed ? K.glass : K.green }
        : { text: 'NOT ARMED', fg: signed ? K.glass : K.gray };
  say(
    g,
    x + Math.floor((w - textWidth(armed.text)) / 2),
    1,
    armed.text,
    { fg: armed.fg, bg },
    x + w,
  );
  g.hit({ x, y: 0, w, h: 2 }, { id: 'mode' });
}

// ── the stage floor ──────────────────────────────────────────────────────────────────────────

/**
 * The edge the crew stand on: a rule between the stage and the stream. In a split it names the
 * pane's channel, and the focused pane (where typing goes) says so with `P1 ▸` in Trey's cyan; the
 * other pane's label is gray (under `NO_COLOR` the focused label is underlined words, not a lit
 * chip). A single pane's channel is the score bar's lit lane, so its floor is
 * the rule alone.
 */
function drawFloor(
  g: Grid,
  area: Rect,
  channel: string | undefined,
  split: boolean,
  focused: boolean,
  mono: boolean,
): void {
  g.rule(area.x, area.y, area.w, '▔', { fg: split && focused ? K.cyan : K.bezelHi });
  if (!split || channel === undefined) return;
  const label = focused ? ` P1 ▸ #${channel} ` : ` #${channel} `;
  say(
    g,
    area.x + 2,
    area.y,
    clip(label, area.w - 4),
    focused ? chip(K.cyan, K.glass, mono) : { fg: K.gray, bold: true },
    area.x + area.w - 2,
  );
}

// ── the core's resting stage ───────────────────────────────────────────────────────────────

/**
 * Until the stage lane registers its strip, the crew stand still: full bodies with their names,
 * or one row of heads. Nothing moves here.
 */
function drawRestingStage(g: Grid, area: Rect, pane: StagePane, s: AppState): void {
  const view = pane.channel === undefined ? undefined : s.views.get(pane.channel);
  const crew = (view?.summary?.participants ?? []).filter((p) => p !== s.owner.participant);
  if (crew.length === 0) {
    say(
      g,
      area.x + 2,
      area.y + Math.floor(area.h / 2) - 1,
      view === undefined ? '' : 'nobody else is here yet',
      { fg: K.gray, italic: true },
      area.x + area.w,
    );
    return;
  }
  const names = view?.records ?? [];
  const nameOf = (id: string) => {
    for (let i = names.length - 1; i >= 0; i--) {
      const r = names[i];
      if (r !== undefined && r.raw.fromParticipant === id) return r.sender.text;
    }
    return s.names.get(id) ?? id;
  };
  if (pane.fit === 'bodies') {
    const slot = 18;
    crew.slice(0, Math.max(1, Math.floor((area.w - 2) / slot))).forEach((id, i) => {
      const x = area.x + 2 + i * slot;
      const who = { id, isOwner: false };
      g.blit(x, area.y, bodyCells(who, s));
      say(
        g,
        x,
        area.y + 8,
        clip(nameOf(id).toUpperCase(), slot - 2),
        { fg: accentOf(who, s), bold: true },
        x + slot - 1,
      );
    });
    return;
  }
  const slot = 10;
  crew.slice(0, Math.max(1, Math.floor((area.w - 1) / slot))).forEach((id, i) => {
    const x = area.x + 1 + i * slot;
    const who = { id, isOwner: false };
    g.blit(x, area.y, headCells(who, s));
    if (area.h > 4)
      say(g, x, area.y + 4, clip(nameOf(id), slot - 1), { fg: accentOf(who, s) }, x + slot - 1);
  });
}

// ── crossed strip ────────────────────────────────────────────────────────────────────────────

/** "Crossed while you typed": what the send receipt said arrived meanwhile. Never a refusal. */
function drawCrossed(g: Grid, area: Rect, s: AppState): void {
  const strip = s.crossed;
  if (strip === undefined) return;
  const c = strip.crossed;
  const phone = s.layout === 'phone';
  g.fill(area, { bg: K.bezel });
  const forYou = c.addressedToYou > 0 ? ` · ${c.addressedToYou} for you` : '';
  const title = phone
    ? `↯ ${c.unseen} crossed${forYou}`
    : `↯ CROSSED WHILE YOU TYPED · ${c.unseen} new${forYou} · sent anyway`;
  let x = say(
    g,
    1,
    area.y,
    clip(title, area.w - 10),
    { fg: K.violet, bg: K.bezel, bold: true },
    area.w - 8,
  );
  x = sayRight(
    g,
    area.w - 1,
    area.y,
    phone ? ' Esc ' : ' Esc hides ',
    { fg: K.gray, bg: K.bezel },
    x + 1,
  );
  const shown = c.messages.slice(-(area.h - 1));
  shown.forEach((raw, i) => {
    const y = area.y + 1 + i;
    const name =
      (raw.fromParticipant === undefined ? undefined : s.names.get(raw.fromParticipant)) ??
      (typeof raw.envelope.display_name === 'string' ? raw.envelope.display_name : raw.from);
    const forMe = raw.envelope.addressed_to_you === true;
    let cx = say(g, 2, y, forMe ? '@you ' : '', { fg: K.cyan, bg: K.bezel, bold: true }, area.w);
    cx = say(g, cx, y, clip(name, 16), { fg: K.data, bg: K.bezel, bold: true }, area.w);
    say(
      g,
      cx + 1,
      y,
      clip(preview(raw.body, 300), area.w - cx - 2),
      { fg: K.gray, bg: K.bezel },
      area.w - 1,
    );
  });
  if (c.unseen > shown.length && area.h > 1) {
    const more = ` +${c.unseen - shown.length} more in the stream `;
    sayRight(
      g,
      area.w - 1,
      area.y + area.h - 1,
      more,
      { fg: K.gray, bg: K.bezel, italic: true },
      2,
    );
  }
}

// ── composer ─────────────────────────────────────────────────────────────────────────────────

function drawComposer(g: Grid, L: ScreenLayout, s: AppState, m: AppModel): void {
  const phone = s.layout === 'phone';
  const mono = s.noColor === true;
  const ry = L.composerRule.y;
  g.rule(0, ry, s.cols, '▄', { fg: K.bezel });
  const c = s.composer;
  if (c.replyTo !== undefined) {
    const raw =
      s.current === undefined
        ? undefined
        : s.views.get(s.current)?.records.find((r) => r.raw.id === c.replyTo);
    const who = raw === undefined ? c.replyTo : raw.sender.text;
    // The phone has room for whom, not what: the label keeps its participant suffix.
    const words = phone
      ? `↳ replying to ${fitLabel(who, s.cols - 13 - 16)}`
      : `↳ replying to ${who}${raw === undefined ? '' : ` ${preview(raw.text, 48)}`} · Esc cancels`;
    // NO_COLOR: the words alone, bold and underlined in violet on the rule, never a lit row.
    say(
      g,
      mono ? 2 : 1,
      ry,
      clip(mono ? words : ` ${words} `, s.cols - (phone ? 13 : 2) - (mono ? 1 : 0)),
      chip(K.violet, K.glass, mono),
      s.cols - 1,
    );
  }
  if (phone) {
    const t = s.mode === 'signed' ? ' SIGNED ● ' : ' CASUAL ○ ';
    const x = sayRight(
      g,
      s.cols - 1,
      ry,
      t,
      s.mode === 'signed' ? chip(K.cyan, K.glass, mono) : { fg: K.data, bg: K.bezel, bold: true },
      0,
    );
    g.hit({ x, y: ry, w: s.cols - 1 - x, h: 1 }, { id: 'mode' });
  }
  const area = L.composer;
  g.fill(area, { bg: K.bezel });
  const prompt = phone ? 'P1▸' : 'P1 ▸';
  say(g, 1, area.y, prompt, { fg: K.cyan, bg: K.bezel, bold: true }, s.cols);
  const x0 = phone ? 5 : 6;
  const width = composerWidth(s.cols, phone);
  if (!phone) {
    const t = s.mode === 'signed' ? ' SIGNED ● ' : ' CASUAL ○ ';
    const x = sayRight(
      g,
      s.cols - 1,
      area.y,
      t,
      s.mode === 'signed' ? chip(K.cyan, K.glass, mono) : { fg: K.data, bg: K.bezelHi, bold: true },
      x0 + width,
    );
    g.hit({ x, y: area.y, w: s.cols - 1 - x, h: 1 }, { id: 'mode' });
  }
  if (s.current === undefined) {
    say(
      g,
      x0,
      area.y,
      clip('no channel open · Ctrl+K', width),
      { fg: K.gray, bg: K.bezel, italic: true },
      x0 + width,
    );
    return;
  }
  if (c.text === '') {
    const hint = s.sending
      ? 'sending…'
      : phone
        ? 'type to talk'
        : 'INSERT COIN · TYPE TO TALK · Enter sends';
    g.put(x0, area.y, ' ', caretStyle(mono));
    say(g, x0 + 2, area.y, clip(hint, width - 2), { fg: K.gray, bg: K.bezel }, x0 + width);
    return;
  }
  const lines = edit.visualLines(c.text, width);
  const caret = edit.caretPosition(lines, c.caret);
  // Keep the caret's line on screen when the draft is taller than the composer.
  const first = Math.max(0, Math.min(caret.row - area.h + 1, lines.length - area.h));
  for (let r = 0; r < area.h; r++) {
    const line = lines[first + r];
    if (line === undefined) break;
    // A mention is one token: bold violet (bold and underlined without colour) among the words.
    const text: Style = { fg: K.data, bg: K.bezel };
    const token: Style = mono
      ? { fg: K.data, bg: K.bezel, bold: true, underline: true }
      : { fg: K.violet, bg: K.bezel, bold: true };
    let x = x0;
    let at = line.start;
    const limit = x0 + width + 1;
    for (const m of c.mentions ?? []) {
      const from = Math.max(m.start, line.start);
      const to = Math.min(m.end, line.end);
      if (from >= to) continue;
      x = say(g, x, area.y + r, c.text.slice(at, from), text, limit);
      x = say(g, x, area.y + r, c.text.slice(from, to), token, limit);
      at = to;
    }
    say(g, x, area.y + r, c.text.slice(at, line.end), text, limit);
  }
  const cy = area.y + caret.row - first;
  const cx = x0 + Math.min(caret.col, width);
  const under = g.at(cx, cy);
  g.put(
    cx,
    cy,
    under !== undefined && under.ch !== '' && under.ch !== ' ' ? under.ch : ' ',
    caretStyle(mono),
  );
  if (first > 0) say(g, s.cols - 2, area.y, '↑', { fg: K.gray, bg: K.bezel }, s.cols);
  void m;
}

/**
 * The composer's caret: a cyan block, or under `NO_COLOR` an underline caret in cyan (lit in the
 * monochrome pair) over the character, so no cell turns into a solid light block.
 */
function caretStyle(mono: boolean): Style {
  return mono ? { fg: K.cyan, bold: true, underline: true } : { fg: K.glass, bg: K.cyan };
}

// ── status line ──────────────────────────────────────────────────────────────────────────────

/**
 * A notice's prefix and style. Under `NO_COLOR` the `✓` and `✗` notices are bold underlined words
 * in green and red, like every chip; the failed-signature banner alone keeps reverse video
 * (coordinator ruling, T9 NO_COLOR follow-up).
 */
function tone(name: string, mono: boolean): { prefix: string; style: Style } {
  switch (name) {
    case 'good':
      return { prefix: '✓ ', style: chip(K.green, K.glass, mono) };
    case 'caution':
      return { prefix: 'CAUTION · ', style: { fg: K.data, bg: K.bezelHi, bold: true } };
    case 'warning':
      return { prefix: '✗ ', style: chip(K.red, K.glass, mono) };
    default:
      return { prefix: '', style: { fg: K.data, bg: K.bezel } };
  }
}

/** The layout chip's text: what the screen is now, and the key that flips it. */
export function layoutChipText(split: boolean): string {
  return split ? ' ◫ split · F2 ' : ' ▣ single · F2 ';
}

/**
 * On wide, where the split exists, the status line's right-hand end says which layout this is and
 * is the click target for F2. Elsewhere there is no choice to show and nothing is drawn. Returns
 * the column the chip starts at (the line's width when there is none).
 */
function drawLayoutChip(g: Grid, y: number, s: AppState): number {
  if (s.layout !== 'wide') return s.cols;
  const text = layoutChipText(s.split);
  const w = textWidth(text);
  const x = s.cols - 1 - w;
  // NO_COLOR: bold underlined words, like every chip; the glyph and the word carry the state.
  const style: Style =
    s.noColor === true
      ? { fg: K.data, bold: true, underline: true }
      : { fg: s.split ? K.cyan : K.data, bg: K.bezelHi, bold: true };
  say(g, x, y, text, style, s.cols - 1);
  g.hit({ x, y, w, h: 1 }, { id: 'layout' });
  return x;
}

function drawStatus(g: Grid, area: Rect, s: AppState, m: AppModel): void {
  const phone = s.layout === 'phone';
  const mono = s.noColor === true;
  const y = area.y;
  g.fill(area, { bg: K.bezel });
  const pane = s.panes[s.focusedPane];
  if (pane?.pick !== undefined && s.overlay === undefined) {
    let x = say(g, 1, y, ' PICK ', chip(K.cyan, K.glass, mono), s.cols);
    const acts: [string, boolean][] = [
      [phone ? '[r]eply' : '[r] reply', true],
      [phone ? '[c]' : '[c] copy', allCommands().some((c) => c.name === 'copy')],
      [phone ? '[s]' : '[s] seen', allCommands().some((c) => c.name === 'seen')],
      ['[1-9] vote', !phone && allCommands().some((c) => c.name === 'vote')],
      [phone ? '[Esc]' : '[↑↓] move  [Esc] done', true],
    ];
    for (const [t, on] of acts)
      if (on) x = say(g, x + 2, y, t, { fg: K.data, bg: K.bezel, bold: true }, s.cols - 1);
    return;
  }
  // On wide, the layout chip holds the right-hand end; everything else keeps to its left.
  const edge = drawLayoutChip(g, y, s) - 1;
  let x = 1;
  if (s.current !== undefined) {
    x = say(
      g,
      1,
      y,
      clip(`▶ #${s.current}`, phone ? 18 : 30),
      { fg: K.cyan, bg: K.bezel, bold: true },
      s.cols,
    );
    const desc = s.views.get(s.current)?.summary?.description;
    if (!phone && desc !== undefined && desc !== '')
      x = say(
        g,
        x + 1,
        y,
        clip(`│ ${desc}`, Math.max(0, Math.floor(s.cols / 3))),
        { fg: K.gray, bg: K.bezel },
        s.cols,
      );
    const cur = s.views.get(s.current);
    const err = cur?.error;
    const notJoined = cur?.summary !== undefined && !isMember(cur.summary);
    // A failure the notice already says (a refused send) shows once, not in both places.
    if (err !== undefined && s.notice?.text.includes(err) !== true)
      x = say(g, x + 1, y, clip(`✗ ${err}`, 40), { fg: K.red, bg: K.bezel }, s.cols);
    else if (err === undefined && notJoined)
      x = say(g, x + 1, y, clip('not joined', 40), { fg: K.gray, bg: K.bezel }, s.cols);
  }
  const n = s.notice;
  if (n !== undefined) {
    const t = tone(n.tone, mono);
    const text = ` ${t.prefix}${n.text} `;
    const room = edge - (phone ? 1 : x + 2);
    const nx = phone ? 1 : Math.max(x + 2, edge - textWidth(text));
    if (phone) g.fill(area, { bg: K.bezel });
    say(g, nx, y, clip(text, room), t.style, edge);
    return;
  }
  const hints = phone ? 'F1 help' : '^K stages · Tab next! · ^S sign · ^U read · F1 help';
  const hx = edge - textWidth(hints);
  if (hx > x + 1) {
    say(g, hx, y, hints, { fg: K.gray, bg: K.bezel }, edge);
    g.hit({ x: hx, y, w: textWidth(hints), h: 1 }, { id: 'overlay', data: 'help' });
  }
  void m;
}

// ── mentions picker ──────────────────────────────────────────────────────────────────────────

function drawPicker(g: Grid, L: ScreenLayout, m: AppModel, mono: boolean): void {
  const list = m.mentionCandidates();
  const h = list.length + 2;
  const w = Math.min(L.cols - 2, 64);
  const area: Rect = { x: 1, y: L.composerRule.y - h, w, h };
  g.fill(area, { bg: K.bezel });
  g.box(area, 'single', { fg: K.violet, bg: K.bezel });
  say(
    g,
    area.x + 2,
    area.y,
    ' mention · Tab completes ',
    { fg: K.violet, bg: K.bezel, bold: true },
    area.x + w - 1,
  );
  list.forEach((c, i) => {
    const sel = i === (m.picker?.index ?? 0);
    // NO_COLOR: the selected row is bold underlined violet words, not a lit row.
    const style: Style = sel
      ? mono
        ? { fg: K.violet, bg: K.bezel, bold: true, underline: true }
        : { fg: K.glass, bg: K.violet, bold: true }
      : { fg: K.data, bg: K.bezel };
    const y = area.y + 1 + i;
    const right = area.x + w - 1;
    g.fill({ x: area.x + 1, y, w: w - 2, h: 1 }, { bg: style.bg ?? K.bezel });
    // The name alone: what goes into the message is the id post resolves, which the row hides.
    // A room or a lineage (label === insert) keeps its `@`, since that is what it inserts.
    const name = c.label === c.insert ? `@${c.insert}` : c.label;
    const room = w - 4;
    const shown = clip(name, c.hint === undefined ? room : Math.max(8, room - 12));
    const x = say(g, area.x + 2, y, shown, style, right);
    if (c.hint === undefined) return;
    // The directory, model and effort in gray parentheses: text another agent reported, so gray
    // and nothing else. On the lit row gray would vanish into the violet, so it takes the row's
    // own colour, unbolded; in NO_COLOR it is plain next to the underlined name.
    const rowBg = style.bg ?? K.bezel;
    const dir: Style = sel && !mono ? { fg: K.glass, bg: rowBg } : { fg: K.gray, bg: rowBg };
    const left = room - textWidth(shown) - 1;
    if (left >= 5) say(g, x + 1, y, clip(`(${c.hint})`, left), dir, right);
  });
}

// ── help, until the overlay lane's help is registered ───────────────────────────────────────

const HELP: readonly [string, string][] = [
  ['Enter', 'send · Shift/Alt+Enter new line'],
  ['Ctrl+S', 'SIGNED / CASUAL (when armed)'],
  ['Ctrl+K / Ctrl+B', 'switcher / browser'],
  ['Ctrl+F', 'search'],
  ['Tab · Alt+1–9', 'lane that needs you · lane N'],
  ['Ctrl+U', 'mark read through what you see'],
  ['Ctrl+G · Ctrl+O', 'latest · load older'],
  ['Ctrl+↑/↓', 'pick a message (r replies)'],
  ['PgUp/PgDn', 'scroll'],
  ['F2 · Ctrl+\\', 'split / single (wide)'],
  ['Esc', 'pick → reply → strip → notice'],
  ['Ctrl+Q · Ctrl+C', 'quit (drafts kept)'],
];

function drawHelpFallback(g: Grid, area: Rect): void {
  const w = Math.min(area.w - 2, 60);
  const h = Math.min(area.h, HELP.length + 3);
  const box: Rect = { x: area.x + Math.floor((area.w - w) / 2), y: area.y + 1, w, h };
  g.fill(box, { bg: K.bezel });
  g.box(box, 'double', { fg: K.cyan, bg: K.bezel });
  say(
    g,
    box.x + 2,
    box.y,
    ' HELP · Esc or F1 closes ',
    { fg: K.cyan, bg: K.bezel, bold: true },
    box.x + w - 1,
  );
  HELP.slice(0, h - 2).forEach(([k, v], i) => {
    const y = box.y + 1 + i;
    const x = say(
      g,
      box.x + 2,
      y,
      k.padEnd(17),
      { fg: K.data, bg: K.bezel, bold: true },
      box.x + w - 1,
    );
    say(g, x, y, clip(v, box.x + w - 2 - x), { fg: K.gray, bg: K.bezel }, box.x + w - 1);
  });
}
