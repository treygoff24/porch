/**
 * The channel browser against the installed post (review fix): a temporary mail root, two channels.
 * Ctrl+A on #ops archives it through post-kit; the listing post gives next (what the core's poll
 * reads) has it archived; the live view no longer lists it and the archived view does; Ctrl+A there
 * restores it, and the next listing has it live again. Nothing is changed optimistically: each view
 * is drawn from post's own listing.
 *
 * The listing is `post channels --all --json`. Plain `post channels --json` hides archived channels
 * (it reports only `archived_hidden: N`), and post-kit's `channels()` asks for the plain one, so the
 * core's poll must list with `--all` for the archived view to have anything in it (reported to the
 * coordinator; this lane may not change post-kit's listing). The first test pins that fact so the
 * seam cannot be forgotten silently.
 */
import { decodeJson, OwnerPost, ownerEnv, parseChannels, runProcess } from '@estate/post-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializePost, realPost, sandbox } from '../../packages/post-kit/test/helpers.ts';
import { createBrowser } from '../../src/app/overlays/browser.ts';
import type { Key } from '../../src/app/registry.ts';
import type { AppState } from '../../src/app/state.ts';
import { Grid } from '../../src/grid/grid.ts';
import { GROUND, lines, Rig } from '../stage/rig.ts';

const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('browser archive and restore through real post', () => {
  const s = sandbox();
  let client: OwnerPost;

  beforeAll(async () => {
    await initializePost(s);
    const connected = await OwnerPost.connect({
      executable: realPost as string,
      env: s.env,
      config: s.cfg,
    });
    if (!connected.ok) throw new Error(connected.error.message);
    client = connected.value;
    for (const c of ['commons', 'ops']) {
      const joined = await client.join(c);
      if (!joined.ok) throw new Error(joined.error.message);
    }
  }, 60_000);
  afterAll(() => s.cleanup());

  /** `post channels --all --json`, parsed by post-kit's own listing parser. */
  async function allChannels() {
    const out = await runProcess(realPost as string, {
      args: ['channels', '--all', '--json'],
      env: ownerEnv(s.env, s.cfg, client.owner.participant),
      cwd: s.cfg.ownerRoomDir,
      timeoutMs: 10000,
    });
    if (out.code !== 0) throw new Error(out.stderr);
    const parsed = parseChannels(decodeJson(out.stdout, out.stderr));
    if (parsed === undefined) throw new Error('channels listing did not parse');
    return parsed;
  }

  it("post-kit's listing includes archived channels, marked archived, as post's --all does", async () => {
    const archived = await client.archive('commons');
    if (!archived.ok) throw new Error(archived.error.message);
    const plain = await client.channels();
    const all = await allChannels();
    const restored = await client.unarchive('commons');
    if (!plain.ok) throw new Error(plain.error.message);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(plain.value.find((c) => c.name === 'commons')?.archived).toBe(true);
    expect(all.find((c) => c.name === 'commons')?.archived).toBe(true);
  }, 60_000);

  it('Ctrl+A archives, the refreshed listing moves it to the archived view, Ctrl+A restores', async () => {
    const rig = new Rig();
    const refresh = async () => {
      rig.channels = await allChannels();
    };
    await refresh();
    expect(rig.channels.map((c) => [c.name, c.archived === true]).sort()).toEqual([
      ['commons', false],
      ['ops', false],
    ]);
    const o = createBrowser();
    const state = (): AppState =>
      rig.state(100, 32, { post: { client } as unknown as AppState['post'] });
    const draw = () => {
      const g = new Grid(100, 32, GROUND);
      o.draw(g, { x: 0, y: 0, w: 100, h: 32 }, state());
      return lines(g).join('\n');
    };
    const statusLine = async (text: string) => {
      for (let i = 0; i < 100; i++) {
        const found = rig.calls.find(
          (c) => c.action === 'status' && String(c.args[0]).startsWith(text),
        );
        if (found !== undefined) return found;
        await sleep(100);
      }
      throw new Error(`no status "${text}": ${JSON.stringify(rig.calls.map((c) => c.args[0]))}`);
    };
    const choose = (name: string) => {
      const listed = draw()
        .split('\n')
        .filter((l) => /#[a-z]/.test(l) && /[▶ ] #/.test(l));
      const at = listed.findIndex((l) => l.includes(`#${name}`));
      expect(at, `#${name} listed`).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 10; i++) o.key(key('up'), state());
      for (let i = 0; i < at; i++) o.key(key('down'), state());
      expect(
        draw()
          .split('\n')
          .find((l) => l.includes('▶')),
      ).toContain(`#${name}`);
    };

    draw();
    choose('ops');
    o.key(key('a', { ctrl: true }), state());
    const archived = await statusLine('archived #ops');
    expect(archived.args[1]).toBe('good');
    // Not optimistic: the live view still lists #ops until post's listing says otherwise.
    expect(draw()).toContain('#ops');

    await refresh();
    expect(rig.channels.find((c) => c.name === 'ops')?.archived).toBe(true);
    const live = draw();
    expect(live).toContain('#commons');
    expect(live).not.toContain('#ops');

    o.key(key('t', { ctrl: true }), state());
    const shelf = draw();
    expect(shelf).toContain('ARCHIVED');
    expect(shelf).toContain('#ops');
    expect(shelf).not.toContain('#commons');
    choose('ops');
    o.key(key('a', { ctrl: true }), state());
    const restored = await statusLine('restored #ops');
    expect(restored.args[1]).toBe('good');

    await refresh();
    expect(rig.channels.find((c) => c.name === 'ops')?.archived).toBe(false);
    expect(draw()).toContain('no archived channels');
    o.key(key('t', { ctrl: true }), state());
    const back = draw();
    expect(back).toContain('#ops');
    expect(back).toContain('#commons');
  }, 60_000);
});
