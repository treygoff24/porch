/**
 * The app's captures (`docs/captures/app-*`): the busy world, armed, at the three judged sizes, the
 * laptop in `NO_COLOR`, and the laptop mid-reply in signed mode. Every run draws each one and
 * checks it; `PORCH_CAPTURE=1` also writes the PNGs (and their pages) through `scripts/capture.ts`.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureGrid } from '../../scripts/capture.ts';
import { frame, key, lines, makeApp, press, SIZES, type } from './harness.ts';
import { busyWorld } from './worlds.ts';

const out = join(import.meta.dirname, '..', '..', 'docs', 'captures');
const writing = process.env.PORCH_CAPTURE === '1';

describe('app captures', () => {
  it.each(SIZES)(
    'the busy world at $name ($cols x $rows)',
    async ({ name, cols, rows }) => {
      const app = await makeApp(busyWorld({ armed: true }));
      // The laptop opens at the divider with the impostor's banner just above it; show both.
      if (name === 'laptop') app.m.scroll(8);
      const g = frame(app, cols, rows);
      const text = lines(g).join('\n');
      expect(text).toContain('✗ SIGNATURE FAILED');
      expect(text).toContain('NEW · 4');
      if (writing) await captureGrid(g, join(out, `app-${name}.png`), { html: true });
      if (name === 'laptop' && writing)
        await captureGrid(g, join(out, 'app-laptop-nocolor.png'), { noColor: true });
    },
    60_000,
  );

  it('the laptop mid-reply, in signed mode', async () => {
    const app = await makeApp(busyWorld({ armed: true }));
    press(app, key('s', { ctrl: true }));
    press(app, key('up', { ctrl: true }));
    press(app, key('r'));
    type(app, 'notes are in, tagging now');
    const g = frame(app, 100, 32);
    const text = lines(g).join('\n');
    expect(text).toContain('SIGNED ●');
    expect(text).toContain('↳ replying to Bolt');
    expect(text).toContain('notes are in, tagging now');
    if (writing) await captureGrid(g, join(out, 'app-laptop-reply-signed.png'), { html: true });
  }, 60_000);
});
