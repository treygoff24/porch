/**
 * The overlays under NO_COLOR (review fix): every overlay state still reads in the monochrome pair.
 * Frames go through the host's own monochrome mapping (`monoView`); each state's word or glyph must
 * stay visible (ink on the other shade from its background), and the selection must be marked by a
 * glyph, not a tint: help's legend, the switcher's ▶ and NEEDS YOU, the browser's live and archived
 * views, and search typing, running, done (match underlined), failed and cut at the limit.
 */
import type { DisplayRecord, Result } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import { createBrowser } from '../../src/app/overlays/browser.ts';
import { createHelp, LEGEND } from '../../src/app/overlays/help.ts';
import { createSearch, type SearchResult } from '../../src/app/overlays/search.ts';
import { createSwitcher } from '../../src/app/overlays/switcher.ts';
import type { Key, Overlay } from '../../src/app/registry.ts';
import type { AppState } from '../../src/app/state.ts';
import { Grid } from '../../src/grid/grid.ts';
import { GROUND, message, monoView, Rig, summary } from '../stage/rig.ts';

const SIZES = [
  [40, 52],
  [100, 32],
  [160, 44],
] as const;
const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});
const ch = (c: string): Key => key(c, { text: c });
const flush = () => new Promise((r) => setTimeout(r, 0));

function view(o: Overlay, s: AppState, cols: number, rows: number) {
  const g = new Grid(cols, rows, GROUND);
  o.draw(g, { x: 0, y: 0, w: cols, h: rows }, s);
  return { ...monoView(g), grid: g };
}

function rig(): Rig {
  const r = new Rig();
  r.channels = [
    summary('commons', ['porch-trey', 'p-bolt'], { unread: 3, messages: 210 }),
    summary('ops', ['porch-trey', 'p-bolt'], { messages: 40 }),
    summary('old-launch', ['porch-trey'], { archived: true, messages: 77 }),
  ];
  r.views.set('ops', {
    name: 'ops',
    summary: undefined,
    records: [],
    acknowledged: undefined,
    divider: undefined,
    newCount: 0,
    needsYou: true,
    trend: 'flat',
    top: 'beginning',
    detached: false,
    error: undefined,
  });
  return r;
}

/** The visible line holding `text`, or undefined. */
const lineWith = (frame: string, text: string) => frame.split('\n').find((l) => l.includes(text));

describe('overlays in monochrome', () => {
  for (const [cols, rows] of SIZES) {
    it(`${cols}x${rows}: help's legend keeps every glyph and name`, () => {
      const o = createHelp();
      const r = rig();
      const s = r.state(cols, rows);
      let seen = '';
      for (let i = 0; i < 120; i++) {
        seen += `${view(o, s, cols, rows).text}\n`;
        o.key(key('down'), s);
      }
      for (const [glyph, , name] of LEGEND)
        expect(
          seen.split('\n').some((l) => l.includes(glyph) && l.indexOf(name) > l.indexOf(glyph)),
          `${glyph} ${name} not visible`,
        ).toBe(true);
    });

    it(`${cols}x${rows}: the switcher marks the selection with ▶ and says NEEDS YOU`, () => {
      const o = createSwitcher();
      const r = rig();
      const s = r.state(cols, rows);
      const first = view(o, s, cols, rows);
      expect(lineWith(first.text, '▶')).toContain('#commons');
      expect(lineWith(first.text, 'NEEDS YOU')).toContain('ops');
      o.key(key('down'), s);
      const second = view(o, s, cols, rows);
      expect(second.key).not.toBe(first.key);
      expect(lineWith(second.text, '▶')).toContain('ops');
    });

    it(`${cols}x${rows}: the browser's live and archived views read without colour`, async () => {
      const o = createBrowser({
        presence: async () => ({
          ok: true,
          value: { who: [], profiles: new Map(), skipped: [] },
        }),
        archive: async () => ({ ok: true, value: undefined }),
        unarchive: async () => ({ ok: true, value: undefined }),
      });
      const r = rig();
      const s = r.state(cols, rows);
      view(o, s, cols, rows);
      await flush();
      const live = view(o, s, cols, rows);
      expect(live.text).toContain('CHANNELS');
      expect(lineWith(live.text, '▶')).toContain('#commons');
      expect(lineWith(live.text, '#ops')).toContain('!!');
      expect(live.text).not.toContain('#old-launch');
      o.key(key('t', { ctrl: true }), s);
      await flush();
      const archived = view(o, s, cols, rows);
      expect(archived.text).toContain('ARCHIVED');
      expect(lineWith(archived.text, '▶')).toContain('#old-launch');
      expect(lineWith(archived.text, '#old-launch')).toContain('archived');
      expect(archived.text).not.toContain('#commons');
    });

    it(`${cols}x${rows}: every search state has its words, and the match stays underlined`, async () => {
      const hits = [message('bolt', 'the parser is fixed'), message('wisp', 'parser shipped')];
      let answer: ((r: Result<SearchResult>) => void) | undefined;
      const o = createSearch(
        () =>
          new Promise((res) => {
            answer = res;
          }),
      );
      const r = rig();
      r.current = 'commons';
      const s = r.state(cols, rows);
      expect(view(o, s, cols, rows).text).toContain('type words, then Enter');
      for (const c of 'parser') o.key(ch(c), s);
      expect(view(o, s, cols, rows).text).toContain('#commons ▸ parser');
      o.key(key('return'), s);
      await flush();
      expect(view(o, s, cols, rows).text).toContain('searching #commons…');

      answer?.({ ok: true, value: { hits, truncated: false, limit: 1000 } });
      await flush();
      const done = view(o, s, cols, rows);
      expect(done.text).toContain('2 matches, newest first');
      expect(lineWith(done.text, '▶')).toContain(hits[0]?.sender.text);
      let underlined = '';
      done.grid.forEachCell((c) => {
        if (c.underline) underlined += c.ch;
      });
      expect(underlined).toBe('parserparser');
      expect(done.text.split('parser').length - 1).toBeGreaterThanOrEqual(2);

      o.run('broken', s);
      await flush();
      answer?.({
        ok: false,
        error: { code: 'post', message: 'post search failed', retryable: false },
      });
      await flush();
      expect(view(o, s, cols, rows).text).toContain('search failed: post search failed');

      o.run('parser', s);
      await flush();
      answer?.({
        ok: true,
        value: { hits: hits as DisplayRecord[], truncated: true, limit: 1000 },
      });
      await flush();
      expect(view(o, s, cols, rows).text).toContain('1000+ matches; refine');
    });
  }
});
