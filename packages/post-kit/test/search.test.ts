/**
 * `OwnerPost.search`: post's own bounded search of one channel. The fake runner pins the argv and
 * the parse; the real-post half proves post answers that argv the way the parse expects (literal,
 * case-insensitive, newest first, `truncated` at the limit, a dash-led pattern taken as a pattern).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OwnerPost, SEARCH_LIMIT } from '../src/client.ts';
import type { RunSpec } from '../src/run.ts';
import { initializePost, jsonOutcome, realPost, sandbox, writeMessage } from './helpers.ts';

const hit = (id: string, extra: Record<string, unknown> = {}) => ({
  channel: 'commons',
  id,
  from: 'agent',
  from_participant: 'p-agent',
  display_name: 'Agent',
  sent: '2026-09-30T23:00:00Z',
  preview: 'a needle here',
  matched: ['body'],
  origin: 'chat',
  subject: '',
  source: 'channel',
  ...extra,
});

describe('OwnerPost.search over a fake post', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  function client(answer: () => unknown) {
    const run = vi.fn(async (_exe: string, spec: RunSpec) => {
      if (spec.args[0] === 'owner')
        return jsonOutcome({
          ok: true,
          state: 'configured',
          owner: {
            room: 'mara',
            marker: s.cfg.marker,
            label: s.cfg.label,
            principal: s.cfg.principal,
            namespace: s.cfg.namespace,
            sidecar_dir: s.cfg.sidecarDir,
            allowed_signers: s.cfg.allowedSigners,
          },
        });
      if (spec.args[0] === 'participant')
        return jsonOutcome({
          ok: true,
          status: 'bound',
          id: 'porch-abcdef',
          participant: { id: 'porch-abcdef', workspace: 'mara', harness: 'porch' },
        });
      if (spec.args[0] === 'profile') return jsonOutcome({ ok: true, room: 'mara' });
      if (spec.args[0] === 'search') return jsonOutcome(answer());
      throw new Error(`unexpected ${spec.args.join(' ')}`);
    });
    return { run, connect: () => OwnerPost.connect({ config: s.cfg, env: s.env, run }) };
  }

  it('asks post for a bounded, literal search of the one channel, the pattern after --', async () => {
    const { run, connect } = client(() => ({
      ok: true,
      count: 1,
      limit: 1000,
      truncated: false,
      results: [hit('20260930-230000-000001-abcdef')],
    }));
    const c = await connect();
    if (!c.ok) throw new Error(c.error.message);
    const r = await c.value.search('commons', '-needle');
    if (!r.ok) throw new Error(r.error.message);
    expect(run.mock.calls.at(-1)?.[1].args).toEqual([
      'search',
      '--channel',
      'commons',
      '--limit',
      String(SEARCH_LIMIT),
      '--json',
      '--',
      '-needle',
    ]);
    expect(r.value).toEqual({
      truncated: false,
      limit: 1000,
      hits: [
        {
          channel: 'commons',
          id: '20260930-230000-000001-abcdef',
          from: 'agent',
          fromParticipant: 'p-agent',
          displayName: 'Agent',
          sent: '2026-09-30T23:00:00Z',
          preview: 'a needle here',
          matched: ['body'],
        },
      ],
    });
  });

  it('passes the limit and the truncation through', async () => {
    const { run, connect } = client(() => ({
      ok: true,
      truncated: true,
      results: [hit('a-1'), hit('a-2', { from_participant: undefined, display_name: null })],
    }));
    const c = await connect();
    if (!c.ok) throw new Error(c.error.message);
    const r = await c.value.search('commons', 'needle', { limit: 2 });
    if (!r.ok) throw new Error(r.error.message);
    expect(run.mock.calls.at(-1)?.[1].args.slice(3, 5)).toEqual(['--limit', '2']);
    expect(r.value.truncated).toBe(true);
    expect(r.value.limit).toBe(2);
    expect(r.value.hits[1]?.fromParticipant).toBeUndefined();
    expect(r.value.hits[1]?.displayName).toBeUndefined();
  });

  it('refuses unsafe names, empty or control-character patterns and out-of-range limits before running post', async () => {
    const { run, connect } = client(() => ({ ok: true, truncated: false, results: [] }));
    const c = await connect();
    if (!c.ok) throw new Error(c.error.message);
    const before = run.mock.calls.length;
    const cases: [string, string, number | undefined][] = [
      ['-rf', 'x', undefined],
      ['a/b', 'x', undefined],
      ['commons', '', undefined],
      ['commons', 'a\nb', undefined],
      ['commons', 'a\u0000b', undefined],
      ['commons', 'x'.repeat(1025), undefined],
      ['commons', 'x', 0],
      ['commons', 'x', 1001],
      ['commons', 'x', 1.5],
    ];
    for (const [channel, pattern, limit] of cases) {
      const r = await c.value.search(channel, pattern, limit === undefined ? {} : { limit });
      expect(r.ok, `${channel} ${JSON.stringify(pattern).slice(0, 20)} ${limit}`).toBe(false);
    }
    expect(run.mock.calls.length).toBe(before);
  });

  it('a malformed answer is an error, never a silent empty result', async () => {
    for (const bad of [
      { ok: true, results: [] },
      { ok: true, truncated: false },
      { ok: true, truncated: false, results: 'no' },
      { ok: true, truncated: false, results: [{ id: 'x' }] },
      { ok: true, truncated: false, results: [hit('../escape')] },
    ]) {
      const { connect } = client(() => bad);
      const c = await connect();
      if (!c.ok) throw new Error(c.error.message);
      const r = await c.value.search('commons', 'needle');
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('an answer that breaks the request is an error: more hits than the limit, or another channel', async () => {
    const cases: [string, number, unknown][] = [
      ['over the limit', 1, { ok: true, truncated: false, results: [hit('a-1'), hit('a-2')] }],
      [
        'another channel',
        1000,
        { ok: true, truncated: false, results: [hit('a-1'), hit('a-2', { channel: 'secret' })] },
      ],
      [
        'no channel',
        1000,
        { ok: true, truncated: false, results: [hit('a-1', { channel: undefined })] },
      ],
    ];
    for (const [what, limit, bad] of cases) {
      const { connect } = client(() => bad);
      const c = await connect();
      if (!c.ok) throw new Error(c.error.message);
      const r = await c.value.search('commons', 'needle', { limit });
      expect(r.ok, what).toBe(false);
    }
    // At the limit exactly, from the asked channel, it is fine.
    const { connect } = client(() => ({
      ok: true,
      truncated: true,
      results: [hit('a-1'), hit('a-2')],
    }));
    const c = await connect();
    if (!c.ok) throw new Error(c.error.message);
    const r = await c.value.search('commons', 'needle', { limit: 2 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.hits.map((h) => h.channel)).toEqual(['commons', 'commons']);
  });

  it("the caller's signal reaches post's process, so Esc can stop a running search", async () => {
    const { run, connect } = client(() => ({ ok: true, truncated: false, results: [] }));
    const c = await connect();
    if (!c.ok) throw new Error(c.error.message);
    const ac = new AbortController();
    await c.value.search('commons', 'needle', { signal: ac.signal });
    expect(run.mock.calls.at(-1)?.[1].signal).toBe(ac.signal);
  });
});

describe('OwnerPost.search against the installed post', () => {
  const s = sandbox();
  let client: OwnerPost;
  const id = (i: number) =>
    `20260930-${String(230000 + Math.floor(i / 60) * 100 + (i % 60)).padStart(6, '0')}-${String(i).padStart(6, '0')}-abcdef`;
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
    for (let i = 0; i < 30; i++)
      writeMessage(s, {
        id: id(i),
        from: 'crew',
        channel: 'commons',
        sent: `2026-09-30T23:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
        body: i % 10 === 3 ? `the NeEdLe ${i}` : i === 20 ? '-dash first' : `hay ${i}`,
      });
  }, 60_000);
  afterAll(() => s.cleanup());

  it('finds literal, case-insensitive body matches, newest first', async () => {
    const r = await client.search('commons', 'needle');
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.truncated).toBe(false);
    expect(r.value.hits.map((h) => h.id)).toEqual([id(23), id(13), id(3)]);
    expect(r.value.hits[0]?.preview).toContain('NeEdLe 23');
    expect(r.value.hits[0]?.from).toBe('crew');
  });

  it('is literal: regex syntax matches nothing it should not', async () => {
    const r = await client.search('commons', 'n.edle');
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.hits).toEqual([]);
  });

  it('says when it stopped at the limit', async () => {
    const r = await client.search('commons', 'needle', { limit: 2 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.truncated).toBe(true);
    expect(r.value.hits.map((h) => h.id)).toEqual([id(23), id(13)]);
  });

  it('takes a dash-led pattern as the pattern', async () => {
    const r = await client.search('commons', '-dash');
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.hits.map((h) => h.id)).toEqual([id(20)]);
  });

  it('an unknown channel is an error', async () => {
    const r = await client.search('nowhere', 'needle');
    expect(r.ok).toBe(false);
  });
});
