/**
 * The core's message renderers, registered first so a feature's renderer with a `match` (an image,
 * a poll) takes the records it claims and leaves the rest (I6).
 *
 * The contract a renderer works to: for a `message`, the stream draws the gutter head, the header
 * line (sender, time, verification) and the reply line itself, and hands the renderer only the
 * body's area; for an `emote` or an `event` the renderer draws the whole entry. `measure` returns
 * rows for a width, and `draw` stays inside its area. An unset background keeps the block's own
 * (Trey's youBg), so a renderer never paints over it.
 */
import type { DisplayRecord } from '@estate/post-kit';
import type { Grid, Rect, Style } from '../grid/grid.ts';
import { wrap } from '../grid/text.ts';
import { ballotOf, directoryFor, mentionSpans } from './derive.ts';
import { accentOf, hintOf, whoOf } from './heads.ts';
import { clip, say } from './ink.ts';
import { type MessageRenderer, registerMessageRenderer } from './registry.ts';
import type { AppState } from './state.ts';
import { K } from './theme.ts';

/** A body's lines for a width. */
export function bodyLines(r: DisplayRecord, width: number): string[] {
  const lines = wrap(r.text, Math.max(1, width));
  return lines.length === 0 ? [''] : lines;
}

/**
 * One line of body text with its mentions lit: one naming Trey in cyan, one naming another known
 * participant, lineage or room in bold violet. An `@word` that names nobody stays plain.
 */
export function drawBodyLine(
  g: Grid,
  x: number,
  y: number,
  line: string,
  style: Style,
  maxX: number,
  dir: { owner: ReadonlySet<string>; known: ReadonlySet<string> },
): void {
  let cx = x;
  let last = 0;
  for (const span of mentionSpans(line)) {
    const name = span.name.toLowerCase();
    const own = dir.owner.has(name);
    if (!own && !dir.known.has(name)) continue;
    cx = say(g, cx, y, line.slice(last, span.start), style, maxX);
    cx = say(
      g,
      cx,
      y,
      line.slice(span.start, span.end),
      { ...style, fg: own ? K.cyan : K.violet, bold: true, underline: own },
      maxX,
    );
    last = span.end;
  }
  say(g, cx, y, line.slice(last), style, maxX);
}

export function channelDirectory(r: DisplayRecord, s: AppState) {
  const view = s.views.get(r.raw.storageChannel);
  const dir = directoryFor(
    { room: s.owner.room, participant: s.owner.participant },
    view?.records.map((d) => d.raw) ?? [],
    [...(view?.summary?.participants ?? []), ...(view?.summary?.members ?? [])],
  );
  // A mention of a participant is drawn as its name (`@Fern` for `@loom-52b3dee9`), so the name
  // lights as the id does.
  const known = new Set(dir.known);
  for (const id of dir.known) {
    const name = s.names.get(id);
    if (name !== undefined && !dir.owner.has(id)) known.add(name.toLowerCase());
  }
  return { owner: dir.owner, known };
}

export const messageRenderer: MessageRenderer = {
  kind: 'message',
  measure: (r, width) => bodyLines(r, width).length,
  draw(g: Grid, area: Rect, r: DisplayRecord, s: AppState) {
    const dir = channelDirectory(r, s);
    const failed = r.verdict.state === 'failed';
    // A send post has not confirmed yet is gray; the real record replaces it in full colour.
    const style: Style = { fg: failed || r.pending === true ? K.gray : K.data, italic: failed };
    bodyLines(r, area.w).forEach((line, i) => {
      if (i < area.h) drawBodyLine(g, area.x, area.y + i, line, style, area.x + area.w, dir);
    });
  },
};

/** A ballot's words: `voted A on p1`. Never the raw `🗳️ p1: a`; the poll card counts the votes. */
export function ballotWords(text: string): string | undefined {
  const b = ballotOf(text);
  return b === undefined ? undefined : `voted ${b.choice.toUpperCase()} on ${b.poll}`;
}

/**
 * A ballot's body, in plain words. The stream shows an unframed ballot as one plain line of its
 * own (`Nova voted A on p1`); this draws the body of a framed one (unverified or failed), whose
 * frame and header the stream still draws. Never `dim` (coordinator ruling): the words carry
 * content, so they keep `gray`'s 4.5:1 on the ground.
 */
export const ballotRenderer: MessageRenderer = {
  kind: 'message',
  match: (r) => ballotOf(r.text) !== undefined,
  measure: () => 1,
  draw(g, area, r) {
    const failed = r.verdict.state === 'failed';
    g.text(area.x, area.y, ballotWords(r.text) ?? '', { fg: K.gray, italic: failed }, area.w);
  },
};

/** `✦ Bolt · hop`: the sender's name in their colour, the emote's name in gray. */
export const emoteRenderer: MessageRenderer = {
  kind: 'emote',
  measure: () => 1,
  draw(g, area, r, s) {
    const prefix = `✦ ${r.sender.text} `;
    const name = r.text.startsWith(prefix) ? r.text.slice(prefix.length) : 'emoted';
    const max = area.x + area.w;
    let x = say(g, area.x, area.y, '✦ ', { fg: K.violet }, max);
    x = say(g, x, area.y, r.sender.text, { fg: accentOf(whoOf(r, s), s), bold: true }, max);
    const hint = hintOf(r, s);
    if (hint !== undefined) x = say(g, x + 1, area.y, `· ${clip(hint, 24)}`, { fg: K.gray }, max);
    say(g, x, area.y, ` · ${name}`, { fg: K.gray }, max);
  },
};

/** Joins, profile changes and other events: one gray line. */
export const eventRenderer: MessageRenderer = {
  kind: 'event',
  measure: () => 1,
  draw(g, area, r) {
    const who = r.sender.text;
    const event = r.raw.event ?? 'event';
    const line =
      event === 'join'
        ? `→ ${who} joined`
        : event === 'profile'
          ? `· ${who} changed their profile`
          : `· ${who}: ${event}`;
    g.text(area.x, area.y, line, { fg: K.gray, italic: true }, area.w);
  },
};

// Registered when this module first loads; `plugins.ts` imports it before any plug-in.
registerMessageRenderer(messageRenderer);
registerMessageRenderer(ballotRenderer);
registerMessageRenderer(emoteRenderer);
registerMessageRenderer(eventRenderer);
