/**
 * Quitting never loses typing: drafts are saved; if saving fails, each unsaved draft is rescued
 * into a recovery record; if that fails too, Porch refuses to quit and says why. Ctrl+Q, Ctrl+C,
 * `/quit` and `/q` all take that path.
 */
import { describe, expect, it } from 'vitest';
import type { DraftStore, RescueStore } from '../../src/app/model.ts';
import { frame, key, lines, makeApp, press, settle, type } from './harness.ts';
import { busyWorld } from './worlds.ts';

function stores(opts: { saveFails?: boolean; rescueFails?: boolean } = {}) {
  const saved: Map<string, string>[] = [];
  const rescued: { channel: string; text: string; replyTo?: string }[] = [];
  const drafts: DraftStore = {
    load: async () => new Map(),
    save: async (d) => {
      if (opts.saveFails) throw new Error('disk full');
      saved.push(new Map(d));
    },
  };
  const rescue: RescueStore = {
    record: async (channel, text, o) => {
      if (opts.rescueFails) throw new Error('read-only');
      rescued.push({ channel, text, ...(o?.replyTo === undefined ? {} : { replyTo: o.replyTo }) });
      return 'rec-1';
    },
  };
  return { drafts, rescue, saved, rescued };
}

describe('quitting', () => {
  it('saves the drafts, then quits', async () => {
    const s = stores();
    const app = await makeApp(busyWorld({ drafts: s.drafts, rescue: s.rescue }));
    type(app, 'half a thought');
    press(app, key('q', { ctrl: true }));
    await settle();
    expect(s.saved.at(-1)?.get('commons')).toBe('half a thought');
    expect(s.rescued).toEqual([]);
    expect(app.host.quits).toBe(1);
  });

  it('rescues each unsaved draft (with its reply) when saving fails, then quits', async () => {
    const s = stores({ saveFails: true });
    const app = await makeApp(busyWorld({ drafts: s.drafts, rescue: s.rescue }));
    press(app, key('up', { ctrl: true }));
    press(app, key('r'));
    type(app, 'half a reply');
    const replyTo = app.m.composer().replyTo;
    expect(replyTo).toBeDefined();
    press(app, key('q', { ctrl: true }));
    await settle();
    expect(s.rescued).toEqual([{ channel: 'commons', text: 'half a reply', replyTo }]);
    expect(app.host.quits).toBe(1);
  });

  it('refuses to quit, and says why, when neither saving nor rescue works', async () => {
    const s = stores({ saveFails: true, rescueFails: true });
    const app = await makeApp(busyWorld({ drafts: s.drafts, rescue: s.rescue }));
    type(app, 'do not lose me');
    press(app, key('q', { ctrl: true }));
    await settle();
    expect(app.host.quits).toBe(0);
    expect(app.m.composer().text).toBe('do not lose me');
    expect(lines(frame(app, 100, 32)).join('\n')).toContain(
      'not quitting: drafts could not be saved',
    );
  });

  it.each([
    ['Ctrl+Q', (app: Awaited<ReturnType<typeof makeApp>>) => press(app, key('q', { ctrl: true }))],
    ['Ctrl+C', (app: Awaited<ReturnType<typeof makeApp>>) => press(app, key('c', { ctrl: true }))],
    [
      '/quit',
      (app: Awaited<ReturnType<typeof makeApp>>) => {
        type(app, '/quit');
        press(app, key('return'));
      },
    ],
    [
      '/q',
      (app: Awaited<ReturnType<typeof makeApp>>) => {
        type(app, '/q');
        press(app, key('return'));
      },
    ],
  ])('%s quits through the same path', async (_name, act) => {
    const s = stores();
    const app = await makeApp(busyWorld({ drafts: s.drafts, rescue: s.rescue }));
    act(app);
    await settle();
    expect(app.host.quits).toBe(1);
    expect(s.saved.length).toBeGreaterThan(0);
    expect(app.sends).toEqual([]);
  });
});
