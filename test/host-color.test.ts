/**
 * NO_COLOR: with it set (non-empty), every cell reaches the terminal in one monochrome pair and
 * keeps its attributes. Checked on what OpenTUI would send (its captured spans), not on the grid.
 */
import { TextAttributes } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it } from 'vitest';
import { MONO_DARK, MONO_LIGHT, monochrome, noColorRequested } from '../src/grid/color.ts';
import { scanlines } from '../src/grid/grid.ts';
import { GridHost, type Scene } from '../src/host/grid-host.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const colourful: Scene = {
  ground: scanlines('#05080b', '#0a0f14'),
  draw(g) {
    g.text(0, 0, 'Trey', { fg: '#3fd9f2', bold: true });
    g.text(5, 0, 'warn', { fg: '#ff3d32', underline: true });
    g.text(10, 0, 'dim', { fg: '#434d56', dim: true });
    g.fill({ x: 0, y: 1, w: 6, h: 1 }, { bg: '#3fd9f2' });
    g.text(0, 1, 'LANE', { fg: '#05080b', bg: '#3fd9f2', italic: true });
    g.put(8, 1, '▀', { fg: '#ff5bdc', bg: '#3ee56d' });
    g.put(9, 1, '▀', { fg: '#ff5bdc' });
  },
};

async function spans(noColor: boolean) {
  const t = await createTestRenderer({ width: 16, height: 3 });
  const host = new GridHost(t.renderer, { scene: colourful, noColor });
  t.renderer.root.add(host);
  host.requestFrame();
  await sleep(60);
  const frame = t.captureSpans();
  t.renderer.destroy();
  return frame.lines.flatMap((l) => l.spans);
}

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

describe('NO_COLOR', () => {
  it('is on when NO_COLOR is set to anything but the empty string', () => {
    expect(noColorRequested({ NO_COLOR: '1' })).toBe(true);
    expect(noColorRequested({ NO_COLOR: 'false' })).toBe(true);
    expect(noColorRequested({ NO_COLOR: '' })).toBe(false);
    expect(noColorRequested({})).toBe(false);
  });

  it('keeps text readable: ink takes the other shade when it would match its background', () => {
    expect(monochrome('#3fd9f2', '#05080b')).toEqual({ fg: MONO_LIGHT, bg: MONO_DARK });
    expect(monochrome('#05080b', '#3fd9f2')).toEqual({ fg: MONO_DARK, bg: MONO_LIGHT });
    expect(monochrome('#434d56', '#05080b')).toEqual({ fg: MONO_LIGHT, bg: MONO_DARK });
    expect(monochrome('#ffffff', '#eeeeee')).toEqual({ fg: MONO_DARK, bg: MONO_LIGHT });
  });

  it('maps half-block pixels each by its own shade, so art keeps its shape', () => {
    expect(monochrome('#ff5bdc', '#3ee56d', '▀')).toEqual({ fg: MONO_LIGHT, bg: MONO_LIGHT });
    expect(monochrome('#ff5bdc', '#05080b', '▀')).toEqual({ fg: MONO_LIGHT, bg: MONO_DARK });
    expect(monochrome('#05080b', '#05080b', '▄')).toEqual({ fg: MONO_DARK, bg: MONO_DARK });
  });

  it('sends only the monochrome pair to the terminal, with every attribute kept', async () => {
    const colour = await spans(false);
    const used = new Set(colour.flatMap((s) => [hex(s.fg), hex(s.bg)]));
    expect(used.size).toBeGreaterThan(4);

    const mono = await spans(true);
    const pair = new Set(mono.flatMap((s) => [hex(s.fg), hex(s.bg)]));
    expect([...pair].sort()).toEqual([MONO_DARK, MONO_LIGHT].sort());
    const attrsOf = (list: typeof mono, text: string) =>
      list.find((s) => s.text.includes(text))?.attributes ?? -1;
    expect(attrsOf(mono, 'Trey') & TextAttributes.BOLD).toBeTruthy();
    expect(attrsOf(mono, 'warn') & TextAttributes.UNDERLINE).toBeTruthy();
    expect(attrsOf(mono, 'dim') & TextAttributes.DIM).toBeTruthy();
    expect(attrsOf(mono, 'LANE') & TextAttributes.ITALIC).toBeTruthy();
    for (const text of ['Trey', 'warn', 'dim', 'LANE']) {
      expect(attrsOf(mono, text), text).toBe(attrsOf(colour, text));
    }
  });
});
