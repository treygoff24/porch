/**
 * The app's pure parts: the layout's arithmetic, the composer's edits, the short id and preview,
 * and how a terminal key becomes the table's key.
 */
import { describe, expect, it } from 'vitest';
import * as edit from '../../src/app/composer.ts';
import { preview, shortId } from '../../src/app/derive.ts';
import { toKey } from '../../src/app/keys.ts';
import { computeLayout, layoutKind, MIN_STREAM_ROWS } from '../../src/app/layout.ts';

const ev = (
  name: string,
  sequence: string,
  mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'option', boolean>> = {},
) => ({
  name,
  sequence,
  ctrl: mods.ctrl ?? false,
  meta: mods.meta ?? false,
  shift: mods.shift ?? false,
  option: mods.option ?? false,
});

describe('layout', () => {
  it('picks phone, laptop and wide by width', () => {
    expect([40, 59, 60, 100, 139, 140, 160].map(layoutKind)).toEqual([
      'phone',
      'phone',
      'laptop',
      'laptop',
      'laptop',
      'wide',
      'wide',
    ]);
  });

  it.each([
    [40, 52, false],
    [100, 32, false],
    [160, 44, true],
    [100, 20, false],
  ])('at %ix%i (split %s) tiles the screen without overlap', (cols, rows, split) => {
    const L = computeLayout({
      cols,
      rows,
      split,
      composerRows: 9,
      crossedRows: 4,
      stageHeight: (fit) => (fit === 'bodies' ? 10 : 5),
    });
    // Bottom up: status, composer (capped), its rule, the strip, then the panes.
    expect(L.status.y).toBe(rows - 1);
    expect(L.composer.h).toBe(cols < 60 ? 4 : 5);
    expect(L.composer.y + L.composer.h).toBe(L.status.y);
    expect(L.composerRule.y).toBe(L.composer.y - 1);
    expect(L.panes.length).toBe(split ? 2 : 1);
    for (const p of L.panes) {
      expect(p.stream.y + p.stream.h).toBeLessThanOrEqual(L.crossed?.y ?? L.composerRule.y);
      expect(p.stream.y).toBeGreaterThanOrEqual(L.score.y + L.score.h);
      if (p.stage !== undefined) expect(p.stage.y + p.stage.h).toBeLessThanOrEqual(p.stream.y);
    }
    if (split) {
      const [a, b] = L.panes;
      expect(L.divider).toBeDefined();
      expect((a?.rect.x ?? 0) + (a?.rect.w ?? 0)).toBeLessThanOrEqual(L.divider?.x ?? 0);
      expect(b?.rect.x).toBeGreaterThan(L.divider?.x ?? 0);
    }
  });

  it('gives the stream its minimum before the stage gets bodies', () => {
    const L = computeLayout({
      cols: 100,
      rows: 24,
      split: false,
      composerRows: 1,
      crossedRows: 0,
      stageHeight: (fit) => (fit === 'bodies' ? 10 : 5),
    });
    const pane = L.panes[0];
    expect(pane?.fit).toBe('heads');
    expect(pane?.stream.h).toBeGreaterThanOrEqual(MIN_STREAM_ROWS);
  });
});

describe('the composer', () => {
  it('moves and deletes by grapheme, never inside an emoji', () => {
    let e: edit.Edit = { text: '', caret: 0 };
    e = edit.insert(e, 'hi 👩‍💻 there');
    e = edit.home(e);
    e = edit.right(edit.right(edit.right(e)));
    e = edit.right(e);
    expect(e.text.slice(0, e.caret)).toBe('hi 👩‍💻');
    e = edit.backspace(e);
    expect(e.text).toBe('hi  there');
  });

  it('wraps at the width and puts the caret on the right visual line', () => {
    const lines = edit.visualLines('alpha beta gamma delta', 11);
    expect(lines.map((l) => l.text.trimEnd())).toEqual(['alpha beta', 'gamma delta']);
    const pos = edit.caretPosition(lines, 13);
    expect(pos.row).toBe(1);
  });

  it('finds the @word at the caret and completes it with a trailing space', () => {
    const e = { text: 'ping @no', caret: 8 };
    expect(edit.mentionAt(e)).toEqual({ start: 5, query: 'no' });
    expect(edit.completeMention(e, 'test-nova02')).toEqual({
      text: 'ping @test-nova02 ',
      caret: 18,
    });
    expect(edit.mentionAt({ text: 'mail a@b', caret: 8 })).toBeUndefined();
  });

  it('turns controls in pasted text into nothing it would send', () => {
    const cleaned = [...edit.cleanInput('a\x1b[31mb\x07c\x7f')];
    expect(cleaned.join('')).toContain('a');
    expect(cleaned.filter((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)).toEqual([]);
  });
});

describe('ids and previews', () => {
  it('a short id is the first six of the last segment', () => {
    expect(shortId('20260930-214100-000001-61b241')).toBe('61b241');
  });

  it('a preview collapses whitespace and never splits a grapheme', () => {
    expect(preview('one\n  two\tthree', 40)).toBe('one two three');
    expect(preview('👩‍💻👩‍💻👩‍💻', 2)).toBe('👩‍💻…');
    expect(preview('é'.normalize('NFD').repeat(3), 2)).toBe(`${'é'.normalize('NFD')}…`);
  });
});

describe('a terminal key', () => {
  it('carries text only when it is typing', () => {
    expect(toKey(ev('a', 'a')).text).toBe('a');
    expect(toKey(ev('a', '\x01', { ctrl: true })).text).toBeUndefined();
    expect(toKey(ev('1', '\x1b1', { meta: true }))).toMatchObject({ alt: true });
    expect(toKey(ev('1', '\x1b1', { meta: true })).text).toBeUndefined();
    expect(toKey(ev('left', '\x1b[1;3D', { option: true })).alt).toBe(true);
    expect(toKey(ev('', '\x1b[13;2u')).text).toBeUndefined();
    expect(toKey(ev('é', 'é')).text).toBe('é');
  });
});
