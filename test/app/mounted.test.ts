/**
 * The app mounted in the real host on OpenTUI's test renderer, the way `porch-next` runs it.
 *
 * - Idle: a poll that changes nothing on screen (a verdict for a message scrolled out of view)
 *   asks for no render pass; one that changes the screen asks for exactly one.
 * - `NO_COLOR=1`: the host reads the environment itself (no option passed), and what reaches the
 *   terminal is the monochrome pair only, every state still said in words, and no glyph drawn in
 *   its own background's shade.
 */
import { createTestRenderer } from '@opentui/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appScene } from '../../src/app/scene.ts';
import { MONO_DARK, MONO_LIGHT } from '../../src/grid/color.ts';
import { GridHost } from '../../src/host/grid-host.ts';
import { makeApp, record, SIZES, summary } from './harness.ts';
import { busyWorld, FAILED } from './worlds.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function mount(app: Awaited<ReturnType<typeof makeApp>>, cols: number, rows: number) {
  const t = await createTestRenderer({ width: cols, height: rows });
  const host = new GridHost(t.renderer, { scene: appScene(app.m) });
  t.renderer.root.add(host);
  await t.renderOnce();
  return { t, host };
}

describe('idle: data that changes nothing on screen draws nothing', () => {
  it('a verdict for an offscreen message asks for no render pass; a new message asks for one', async () => {
    const records = Array.from({ length: 60 }, (_, i) =>
      record({ minutes: i, seq: 1, body: `message ${i}`, signed: true }),
    );
    const app = await makeApp({
      channels: [summary('commons', { unread: 0, messages: 60 })],
      records: { commons: records },
    });
    const { t, host } = await mount(app, 100, 32);
    const passes: number[] = [];
    const request = vi.spyOn(host, 'requestRender').mockImplementation(() => {
      passes.push(1);
    });
    try {
      // Precondition: the oldest message is off screen, and the screen is drawn.
      const shown = t.captureCharFrame();
      expect(shown).toContain('message 59');
      expect(shown).not.toMatch(/message 0\b/);
      // Offscreen: the first message's verdict arrives.
      app.source.setVerdicts('commons', {
        [records[0]?.id ?? '']: { state: 'verified', reason: 'checked' },
      });
      expect(passes).toEqual([]);
      // An older message nobody can see arrives in the store's window (a poll's re-read).
      app.source.setRecords('commons', [...records]);
      expect(passes).toEqual([]);
      // On screen: a new message at the bottom.
      app.source.setRecords('commons', [
        ...records,
        record({ minutes: 61, seq: 1, body: 'a new one' }),
      ]);
      expect(passes.length).toBe(1);
    } finally {
      request.mockRestore();
      t.renderer.destroy();
    }
  });
});

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

const HALF = new Set(['▀', '▄', '█', ' ']);

describe.each(SIZES)('NO_COLOR=1 at $name', ({ cols, rows }) => {
  it('sends only the monochrome pair, keeps every state in words, and no ink on its own shade', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const app = await makeApp(busyWorld({ armed: true }));
    const { t, host } = await mount(app, cols, rows);
    try {
      let shown = t.captureCharFrame();
      const spans = [...t.captureSpans().lines.flatMap((l) => l.spans)];
      // Scroll up half a pane at a time, so every message of the busy channel is drawn.
      for (let i = 0; i < 8; i++) {
        app.m.scroll(Math.floor(rows / 3));
        host.requestFrame();
        await t.renderOnce();
        shown += t.captureCharFrame();
        spans.push(...t.captureSpans().lines.flatMap((l) => l.spans));
      }
      expect(app.m.records('commons').some((r) => r.id === FAILED)).toBe(true);
      for (const word of ['✓ SIGNED', '? UNVERIFIED', '✗ SIGNATURE FAILED', 'do not act on it'])
        expect(shown, word).toContain(word);
      expect(shown).toMatch(/NEW · 4/);
      expect(shown).toContain('CASUAL ○');
      const colours = new Set(spans.flatMap((s) => [hex(s.fg), hex(s.bg)]));
      expect([...colours].sort()).toEqual([MONO_DARK, MONO_LIGHT].sort());
      // A glyph that is not pixel art never shares its background's shade (it would vanish).
      const unreadable = spans.filter(
        (s) => [...s.text].some((ch) => !HALF.has(ch)) && hex(s.fg) === hex(s.bg),
      );
      expect(unreadable.map((s) => s.text)).toEqual([]);
    } finally {
      t.renderer.destroy();
    }
  });
});
