/**
 * The quick switcher (Ctrl+K): type to filter the live channels, ↑↓ to choose, Enter to open, Esc
 * to close. Archived channels are left out (they live in the browser's archived view). A name that
 * starts with the filter ranks above one that only contains it; otherwise post's order stands.
 * Each row carries its unread count and, when a lane needs Trey, the words NEEDS YOU. A channel Trey
 * has not joined says `not joined` in gray: it opens, and his first message there joins it.
 */
import { type ChannelSummary, isMember } from '@estate/post-kit';
import type { Grid, Rect } from '../../grid/grid.ts';
import type { Key, KeyResult, Overlay } from '../registry.ts';
import { T } from '../stage/theme.ts';
import type { AppState } from '../state.ts';
import {
  card,
  edit,
  field,
  footer,
  isDown,
  isEnter,
  isEsc,
  isUp,
  scrollFor,
  trunc,
} from './kit.ts';

export const SWITCHER = 'switcher';

export function matches(channels: readonly ChannelSummary[], filter: string): ChannelSummary[] {
  const q = filter.trim().toLowerCase();
  const live = channels.filter((c) => !c.archived);
  if (q === '') return live;
  const starts = live.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = live.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}

export function createSwitcher(): Overlay & { reset(): void } {
  let filter = '';
  let sel = 0;
  let top = 0;
  const reset = () => {
    filter = '';
    sel = 0;
    top = 0;
  };
  return {
    id: SWITCHER,
    reset,
    draw(g: Grid, area: Rect, s: AppState): void {
      const inner = card(g, area, 'STAGE SELECT', T.magenta, {
        maxW: 72,
        mono: s.noColor === true,
      });
      field(g, inner.x, inner.y, inner.w, '▸ ', filter);
      const list = matches(s.channels, filter);
      sel = Math.max(0, Math.min(sel, list.length - 1));
      const rows = Math.max(0, inner.h - 3);
      top = scrollFor(sel, rows, list.length, top);
      if (list.length === 0)
        g.text(inner.x, inner.y + 2, trunc(`no channel matches "${filter}"`, inner.w), {
          fg: T.gray,
        });
      for (let i = 0; i < rows; i++) {
        const c = list[top + i];
        if (c === undefined) break;
        const y = inner.y + 2 + i;
        const on = top + i === sel;
        const bg = on ? T.deep : undefined;
        if (on) g.fill({ x: inner.x, y, w: inner.w, h: 1 }, { bg: T.deep });
        const style = (fg: string, bold = false) =>
          bg === undefined ? { fg, bold } : { fg, bg, bold };
        let x = inner.x;
        x += g.text(x, y, on ? '▶ ' : '  ', style(T.cyan, true));
        const view = s.views.get(c.name);
        const needs = view?.needsYou === true;
        const unread = c.unread ?? 0;
        const notJoined = !isMember(c);
        const right = needs
          ? '!! NEEDS YOU'
          : unread > 0
            ? `${unread} new`
            : notJoined
              ? 'not joined'
              : '';
        const nameW = Math.max(1, inner.w - 2 - (right === '' ? 0 : right.length + 1));
        const current = c.name === s.current;
        g.text(
          x,
          y,
          trunc(`#${c.name}${current ? ' ·here' : ''}`, nameW),
          style(on ? T.cyan : T.data, true),
        );
        if (right !== '')
          g.text(
            inner.x + inner.w - right.length,
            y,
            right,
            needs || unread > 0 ? style(needs ? T.red : T.orange, true) : style(T.gray),
          );
      }
      footer(
        g,
        inner,
        inner.w < 40 ? '↑↓ Enter Esc' : 'type to filter · ↑↓ choose · Enter open · Esc close',
      );
    },
    key(k: Key, s: AppState): KeyResult {
      const list = matches(s.channels, filter);
      if (isEsc(k)) {
        reset();
        s.actions.closeOverlay();
      } else if (isEnter(k)) {
        const c = list[Math.max(0, Math.min(sel, list.length - 1))];
        if (c !== undefined) {
          reset();
          s.actions.closeOverlay();
          s.actions.openChannel(c.name);
        }
      } else if (isUp(k)) sel = Math.max(0, sel - 1);
      else if (isDown(k)) sel = Math.min(Math.max(0, list.length - 1), sel + 1);
      else {
        const next = edit(filter, k);
        if (next !== undefined) {
          filter = next;
          sel = 0;
          top = 0;
        }
      }
      return 'handled';
    },
  };
}
