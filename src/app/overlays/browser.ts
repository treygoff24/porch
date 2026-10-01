/**
 * The channel browser (Ctrl+B, or ← at column 0 of an empty composer). ↑↓ choose; Enter or →
 * opens; Ctrl+A archives the chosen channel, or restores it in the archived view; Ctrl+T toggles
 * between live and archived channels; Esc closes.
 *
 * Everything shown is post's: the listing in `AppState.channels`, which must come from
 * `post channels --all --json` (plain `post channels` hides archived channels, so the archived view
 * would be empty), and presence from `post who` (a participant is "live" when a `post watch` is
 * running for it right now; a lease alone is not presence). Presence is read once each time the browser opens. Archive
 * and restore go through post-kit's client; the result is reported in the status line and the
 * listing changes when the core's next poll reads it, never optimistically.
 */
import type { Presence, Result } from '@estate/post-kit';
import type { Grid, Rect } from '../../grid/grid.ts';
import type { Key, KeyResult, Overlay } from '../registry.ts';
import { T } from '../stage/theme.ts';
import type { AppState } from '../state.ts';
import { card, chord, footer, isDown, isEnter, isEsc, isUp, scrollFor, trunc } from './kit.ts';

export const BROWSER = 'browser';
const PRESENCE_TTL_MS = 30_000;

export type BrowserDeps = {
  presence(s: AppState): Promise<Result<Presence>>;
  archive(s: AppState, channel: string): Promise<Result<void>>;
  unarchive(s: AppState, channel: string): Promise<Result<void>>;
};

const missing = <T>(): Promise<Result<T>> =>
  Promise.resolve({
    ok: false,
    error: { code: 'no_post', message: 'post is not connected', retryable: false },
  });

/** The client the app connected, through `AppState.post`. */
export const clientDeps: BrowserDeps = {
  presence: (s) => s.post?.client.presence() ?? missing(),
  archive: (s, c) => s.post?.client.archive(c) ?? missing(),
  unarchive: (s, c) => s.post?.client.unarchive(c) ?? missing(),
};

export function createBrowser(deps: BrowserDeps = clientDeps): Overlay & { reset(): void } {
  let archived = false;
  let sel = 0;
  let top = 0;
  let open = false;
  let loadedAt = Number.NEGATIVE_INFINITY;
  let live: ReadonlySet<string> | undefined;
  let presenceError: string | undefined;
  let busy: string | undefined;

  /**
   * Which opening of the browser is current. Closing (Esc, opening a channel, a fresh open) moves
   * it on, so a presence read or an archive that finishes later is dropped by a closed browser
   * and asks for no frame: an overlay nobody sees must not draw.
   */
  let generation = 0;
  const current = (mine: number) => open && mine === generation;
  /** The latest presence read; an older one finishing late is dropped. */
  let reads = 0;

  const reset = () => {
    archived = false;
    sel = 0;
    top = 0;
    open = false;
    generation += 1;
  };

  const loadPresence = (s: AppState) => {
    loadedAt = Date.now();
    live = undefined;
    presenceError = undefined;
    const mine = generation;
    const read = ++reads;
    const latest = () => current(mine) && read === reads;
    void deps
      .presence(s)
      .then((r) => {
        if (!latest()) return;
        if (r.ok) live = new Set(r.value.who.filter((w) => w.liveWatch).map((w) => w.id));
        else presenceError = r.error.message;
      })
      .catch((err: unknown) => {
        if (latest()) presenceError = err instanceof Error ? err.message : 'presence failed';
      })
      .finally(() => {
        if (latest()) s.actions.requestFrame();
      });
  };

  const listFor = (s: AppState) => s.channels.filter((c) => c.archived === archived);

  return {
    id: BROWSER,
    reset,
    draw(g: Grid, area: Rect, s: AppState): void {
      // Presence is read when the browser opens, and again if it has stayed open a while.
      if (!open || Date.now() - loadedAt > PRESENCE_TTL_MS) {
        open = true;
        loadPresence(s);
      }
      const inner = card(g, area, archived ? 'ARCHIVED' : 'CHANNELS', archived ? T.gray : T.blue, {
        maxW: 96,
        mono: s.noColor === true,
      });
      const list = listFor(s);
      sel = Math.max(0, Math.min(sel, list.length - 1));
      const wide = inner.w >= 64;
      const listW = wide ? Math.floor(inner.w * 0.45) : inner.w;
      // Narrow: the list takes the rows it needs (leaving the detail at least nine), the detail
      // the rest, so a tall phone screen shows every member rather than a column of blank rows.
      const avail = Math.max(0, inner.h - 1);
      const rows = wide ? avail : Math.min(list.length, Math.max(3, avail - 10));
      const detailRows = wide ? 0 : Math.max(0, avail - rows - 1);
      top = scrollFor(sel, rows, list.length, top);
      if (list.length === 0)
        g.text(inner.x, inner.y, archived ? 'no archived channels' : 'no live channels', {
          fg: T.gray,
        });
      for (let i = 0; i < rows; i++) {
        const c = list[top + i];
        if (c === undefined) break;
        const y = inner.y + i;
        const on = top + i === sel;
        if (on) g.fill({ x: inner.x, y, w: listW, h: 1 }, { bg: T.deep });
        const st = (fg: string, bold = false) => (on ? { fg, bg: T.deep, bold } : { fg, bold });
        g.text(inner.x, y, on ? '▶ ' : '  ', st(T.cyan, true));
        const needs = !archived && s.views.get(c.name)?.needsYou === true;
        const unread = c.unread ?? 0;
        const right = archived ? 'archived' : needs ? '!!' : unread > 0 ? String(unread) : '';
        const nameW = Math.max(1, listW - 3 - right.length);
        g.text(
          inner.x + 2,
          y,
          trunc(`#${c.name}`, nameW),
          st(on ? T.cyan : archived ? T.gray : T.data, true),
        );
        if (right !== '')
          g.text(
            inner.x + listW - right.length,
            y,
            right,
            st(needs ? T.red : archived ? T.gray : T.orange, true),
          );
      }
      const chosen = list[sel];
      if (chosen !== undefined) {
        const box = wide
          ? { x: inner.x + listW + 2, y: inner.y, w: inner.w - listW - 2, h: inner.h - 1 }
          : { x: inner.x, y: inner.y + rows + 1, w: inner.w, h: detailRows };
        if (!wide && detailRows > 0) g.rule(inner.x, box.y - 1, inner.w, '┄', { fg: T.deep });
        detail(g, box, s, chosen.name, live, presenceError, busy);
      }
      const hint = archived
        ? 'Enter open · ^A restore · ^T live · Esc'
        : 'Enter open · ^A archive · ^T archived · Esc';
      footer(
        g,
        inner,
        inner.w < 44 ? (archived ? '^A restore ^T live Esc' : '^A archive ^T archived Esc') : hint,
      );
    },
    key(k: Key, s: AppState): KeyResult {
      const list = listFor(s);
      const chosen = list[Math.max(0, Math.min(sel, list.length - 1))];
      if (isEsc(k)) {
        reset();
        s.actions.closeOverlay();
      } else if (isEnter(k) || (k.name === 'right' && !k.ctrl)) {
        if (chosen !== undefined) {
          reset();
          s.actions.closeOverlay();
          s.actions.openChannel(chosen.name);
        }
      } else if (isUp(k)) sel = Math.max(0, sel - 1);
      else if (isDown(k)) sel = Math.min(Math.max(0, list.length - 1), sel + 1);
      else if (chord(k, 't')) {
        archived = !archived;
        sel = 0;
        top = 0;
      } else if (chord(k, 'a') && chosen !== undefined && busy === undefined) {
        const restoring = archived;
        const name = chosen.name;
        busy = restoring ? `restoring #${name}…` : `archiving #${name}…`;
        const mine = generation;
        s.actions.status(busy);
        const action = restoring ? deps.unarchive(s, name) : deps.archive(s, name);
        void action
          .then((r) => {
            if (r.ok)
              s.actions.status(
                restoring ? `restored #${name}` : `archived #${name}: history is kept`,
                'good',
              );
            else
              s.actions.status(
                `could not ${restoring ? 'restore' : 'archive'} #${name}: ${r.error.message}`,
                'warning',
              );
          })
          .catch((err: unknown) =>
            s.actions.status(
              `could not ${restoring ? 'restore' : 'archive'} #${name}: ${err instanceof Error ? err.message : 'failed'}`,
              'warning',
            ),
          )
          .finally(() => {
            busy = undefined;
            // The status line reports the outcome either way; only a visible browser redraws.
            if (current(mine)) s.actions.requestFrame();
          });
      }
      return 'handled';
    },
  };
}

/** The chosen channel: its description, and its members with presence. */
function detail(
  g: Grid,
  box: Rect,
  s: AppState,
  channel: string,
  live: ReadonlySet<string> | undefined,
  presenceError: string | undefined,
  busy: string | undefined,
): void {
  if (box.h <= 0 || box.w <= 0) return;
  const c = s.channels.find((x) => x.name === channel);
  let y = box.y;
  const end = box.y + box.h;
  const line = (text: string, style: { fg: string; bold?: boolean; italic?: boolean }) => {
    if (y < end) g.text(box.x, y, trunc(text, box.w), style);
    y += 1;
  };
  line(`#${channel}`, { fg: T.cyan, bold: true });
  if (c?.description !== undefined) line(c.description, { fg: T.data, italic: true });
  if (c?.messages !== undefined) line(`${c.messages} messages`, { fg: T.gray });
  if (busy !== undefined) line(busy, { fg: T.gray });
  const members = (c?.participants ?? []).filter((id) => id !== s.owner.participant);
  if (presenceError !== undefined) line(`presence unavailable: ${presenceError}`, { fg: T.gray });
  else if (live === undefined) line('reading presence…', { fg: T.gray });
  else {
    const here = members.filter((id) => live.has(id)).length;
    line(`${here} of ${members.length} live`, { fg: here > 0 ? T.green : T.gray });
  }
  const hints = s.hints(channel);
  for (const id of members) {
    if (y >= end) break;
    const on = live?.has(id) === true;
    const name = s.names.get(id) ?? id;
    const mark = live === undefined ? '·' : on ? '●' : '○';
    const word = live === undefined ? '' : on ? ' live' : ' away';
    g.text(box.x, y, mark, { fg: on ? T.green : T.grayDim });
    const n = g.text(box.x + 2, y, trunc(name, box.w - 2 - word.length), { fg: T.data });
    let at = box.x + 2 + n;
    if (word !== '') at += g.text(at, y, word, { fg: on ? T.green : T.gray });
    // Another member with the same name: their directory (or id tail), gray, in what is left.
    const hint = hints.get(id);
    const left = box.x + box.w - at - 3;
    if (hint !== undefined && hint !== '' && left >= 6)
      g.text(at, y, trunc(` · ${hint}`, left + 3), { fg: T.gray });
    y += 1;
  }
}
