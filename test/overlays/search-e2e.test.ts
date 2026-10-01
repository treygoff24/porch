/**
 * Search against the installed post (plan T7, review fix): a channel whose history is larger than
 * any read Porch would page through — 9000 messages of about 1 KiB, over 8 MiB of bodies — searched
 * by post itself. The oldest match is found, matches come newest first, a pattern matching more
 * than post's limit says so, and the overlay runs end to end: type, Enter, hits drawn, Enter jumps.
 */
import { OwnerPost } from '@estate/post-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  initializePost,
  realPost,
  sandbox,
  writeMessage,
} from '../../packages/post-kit/test/helpers.ts';
import { createSearch, postSearch } from '../../src/app/overlays/search.ts';
import type { AppState } from '../../src/app/state.ts';
import { Grid } from '../../src/grid/grid.ts';
import { GROUND, lines, Rig, summary } from '../stage/rig.ts';

const TOTAL = 9000;
const FILLER = 'lorem ipsum dolor sit amet '.repeat(38); // ~1 KiB
const id = (i: number) =>
  `20260930-${String(Math.floor(i / 3600)).padStart(2, '0')}${String(Math.floor(i / 60) % 60).padStart(2, '0')}${String(i % 60).padStart(2, '0')}-${String(i).padStart(6, '0')}-abcdef`;
const sent = (i: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + i * 1000).toISOString();
const isNeedle = (i: number) => i % 1000 === 0 || i === 7;

describe('search over a large real post history', () => {
  const s = sandbox();
  let client: OwnerPost;
  let bytes = 0;

  beforeAll(async () => {
    await initializePost(s);
    const connected = await OwnerPost.connect({
      executable: realPost as string,
      env: s.env,
      config: s.cfg,
    });
    if (!connected.ok) throw new Error(connected.error.message);
    client = connected.value;
    const joined = await client.join('commons');
    if (!joined.ok) throw new Error(joined.error.message);
    for (let i = 0; i < TOTAL; i++) {
      const body = `${FILLER}${isNeedle(i) ? `Needle number ${i}` : `hay ${i}`}`;
      bytes += Buffer.byteLength(body);
      writeMessage(s, { id: id(i), from: 'crew', channel: 'commons', sent: sent(i), body });
    }
  }, 120_000);
  afterAll(() => s.cleanup());

  function state(rig: Rig): AppState {
    return rig.state(100, 32, { post: { client } as unknown as AppState['post'] });
  }

  it('finds every match, the oldest included, newest first, in over 8 MiB of history', async () => {
    expect(bytes).toBeGreaterThan(8 * 1024 * 1024);
    const rig = new Rig();
    rig.channels = [summary('commons', [], { messages: TOTAL })];
    const r = await postSearch(state(rig), 'commons', 'NEEDLE', new AbortController().signal);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.truncated).toBe(false);
    const expected = Array.from({ length: TOTAL }, (_, i) => i)
      .filter(isNeedle)
      .reverse()
      .map(id);
    expect(r.value.hits.map((h) => h.raw.id)).toEqual(expected);
    expect(r.value.hits.at(-1)?.raw.id).toBe(id(0));
    expect(r.value.hits.every((h) => !h.sender.isOwner)).toBe(true);
  }, 60_000);

  it('a pattern matching everything stops at 1000 and says it was cut', async () => {
    const rig = new Rig();
    rig.channels = [summary('commons', [], { messages: TOTAL })];
    const r = await postSearch(state(rig), 'commons', 'lorem', new AbortController().signal);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.truncated).toBe(true);
    expect(r.value.hits).toHaveLength(1000);
    expect(r.value.hits[0]?.raw.id).toBe(id(TOTAL - 1));
  }, 60_000);

  it('drives the overlay end to end: type, Enter, hits drawn, Enter jumps', async () => {
    const rig = new Rig();
    rig.channels = [summary('commons', [], { messages: TOTAL })];
    const o = createSearch();
    const st = state(rig);
    for (const c of 'needle number 7')
      o.key({ name: c, ctrl: false, alt: false, shift: false, text: c }, st);
    o.key({ name: 'return', ctrl: false, alt: false, shift: false }, st);
    for (let i = 0; i < 300 && rig.frames === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const draw = () => {
      const g = new Grid(100, 32, GROUND);
      o.draw(g, { x: 0, y: 0, w: 100, h: 32 }, st);
      return lines(g).join('\n');
    };
    // Post's preview stops before the match (1 KiB of filler comes first); the overlay reads the
    // full bodies of the hits on screen and draws again.
    expect(draw()).not.toContain('Needle number 7000');
    let text = draw();
    const both = (t: string) => t.includes('Needle number 7000') && /Needle number 7(?!\d)/.test(t);
    for (let i = 0; i < 300 && !both(text); i++) {
      await new Promise((r) => setTimeout(r, 50));
      text = draw();
    }
    // "needle number 7" matches 7 and 7000 and nothing else.
    expect(text).toContain('2 matches, newest first');
    expect(text).toContain('Needle number 7000');
    expect(text).toMatch(/Needle number 7(?!\d)/);
    o.key({ name: 'return', ctrl: false, alt: false, shift: false }, st);
    const jump = rig.calls.find((c) => c.action === 'jumpTo');
    expect(jump?.args).toEqual(['commons', id(7000)]);
  }, 60_000);
});
