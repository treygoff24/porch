/**
 * The app with the real plug-ins loaded (plugins.ts: the stage strip and the overlays), as boot
 * loads them. Core tests elsewhere use stand-ins; this file checks the pieces fit:
 *
 * - every size draws with the real stage and every real overlay open;
 * - the core resets an overlay it closes or replaces, so the overlay's own work stops;
 * - an archived channel is never the launch channel (post's listing includes archived ones);
 * - the features plug-in registers its commands, paste handler and post-poll observer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import '../../src/app/plugins.ts';
import {
  allCommands,
  allPasteHandlers,
  allPollObservers,
  registerOverlay,
} from '../../src/app/registry.ts';
import { frame, key, makeApp, press, SIZES, summary } from './harness.ts';
import { busyWorld } from './worlds.ts';

// The stage's first-launch marker goes to a temporary directory, never ~/.local/state/porch-next.
// The stage resolves the directory when it first needs it, after this runs. The marker is written
// so the attract screen is not owed and every frame below is the app itself.
const stateDir = mkdtempSync(join(tmpdir(), 'porch-integrated-'));
writeFileSync(join(stateDir, 'attract-seen'), 'integrated test\n');
const priorStateDir = process.env.PORCH_STATE_DIR;
process.env.PORCH_STATE_DIR = stateDir;
afterAll(() => {
  if (priorStateDir === undefined) delete process.env.PORCH_STATE_DIR;
  else process.env.PORCH_STATE_DIR = priorStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

let resets = 0;
registerOverlay({
  id: 'resettable',
  draw() {},
  key: () => 'handled',
  reset() {
    resets += 1;
  },
});

describe.each(SIZES)('real plug-ins at $name', ({ cols, rows }) => {
  it('draws the stage and each real overlay', async () => {
    const app = await makeApp(busyWorld());
    expect(() => frame(app, cols, rows)).not.toThrow();
    for (const id of ['help', 'switcher', 'browser', 'search', 'recovery']) {
      app.m.openOverlay(id);
      expect(app.m.overlay).toBe(id);
      expect(() => frame(app, cols, rows)).not.toThrow();
      app.m.closeOverlay();
    }
    // F1 reaches the real help overlay, which draws its own card.
    press(app, key('f1'));
    expect(app.m.overlay).toBe('help');
    expect(frame(app, cols, rows).toText()).toContain('HOW TO PLAY');
  });
});

describe('overlay reset', () => {
  it('runs when the core closes or replaces an overlay, not when reopening the same one', async () => {
    const app = await makeApp(busyWorld());
    resets = 0;
    app.m.openOverlay('resettable');
    app.m.openOverlay('resettable');
    expect(resets).toBe(0);
    app.m.openOverlay('help');
    expect(resets).toBe(1);
    app.m.openOverlay('resettable');
    app.m.closeOverlay();
    expect(resets).toBe(2);
  });
});

describe('archived channels', () => {
  it('are never the launch channel', async () => {
    const app = await makeApp({
      channels: [summary('commons', { archived: true }), summary('ops')],
    });
    expect(app.m.current).toBe('ops');
  });
});

describe('features plug-in', () => {
  it('registers its commands, the image paste handler and the decision observer', () => {
    const names = allCommands().map((c) => c.name);
    for (const name of ['img', 'vote', 'restore', 'copy', 'save', 'seen', 'archive', 'emote'])
      expect(names).toContain(name);
    expect(allPasteHandlers().map((h) => h.id)).toContain('features-images');
    expect(allPollObservers().map((o) => o.id)).toContain('features-decisions');
  });
});
