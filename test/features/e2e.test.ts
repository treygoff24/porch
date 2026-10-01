import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAvatar } from '@estate/pixel';
import {
  appendEvent,
  buildConfig,
  DraftSpace,
  OwnerPost,
  PrivateAgent,
  SendRecord,
  toDisplay,
  verify,
} from '@estate/post-kit';
import { encode } from 'fast-png';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializePost, realPost, sandbox } from '../../packages/post-kit/test/helpers.ts';
import { Decisions } from '../../src/app/features/decisions.ts';
import { Images } from '../../src/app/features/images.ts';
import { featureCommands, featureRuntime } from '../../src/app/features/index.ts';
import { decisionActor } from '../../src/app/features/lookup.ts';
import { pollRenderer } from '../../src/app/features/polls.ts';
import { Recovery } from '../../src/app/features/recovery.ts';
import { type EmoteSendRequest, FeatureRuntime } from '../../src/app/features/runtime.ts';
import { afterProposal, sentTime } from '../../src/app/features/time.ts';
import type { AppState, CommandContext } from '../../src/app/registry.ts';
import { messageRenderer } from '../../src/app/renderers.ts';
import { T } from '../../src/app/stage/theme.ts';
import { context, offTheme, state } from './helpers.ts';

const box = sandbox();
let client: OwnerPost;
let agent: PrivateAgent;
let recovery: SendRecord;
let s: AppState;
let sendingInContext = false;
let loseNextReceipt = false;
function ctx(): CommandContext {
  return {
    ...context(s),
    send: Object.assign(
      async (req: Parameters<CommandContext['send']>[0]) => {
        sendingInContext = true;
        try {
          const emote = (req as Partial<EmoteSendRequest>).emote;
          return emote
            ? await client.emote(req.channel, emote.name, emote.at)
            : await client.transaction.send(req);
        } finally {
          sendingInContext = false;
        }
      },
      { emotes: true as const },
    ),
  };
}
async function refresh() {
  const history = await client.history('commons', 10000);
  if (!history.ok) throw new Error(history.error.message);
  const records = await Promise.all(
    history.value.map(async (r) =>
      toDisplay(r, {
        anchor: client.owner,
        verdict: await verify(r, client.owner, { env: box.env }),
      }),
    ),
  );
  s = {
    ...s,
    views: new Map([
      [
        'commons',
        {
          ...(s.views.get('commons') ?? state().views.get('commons')),
          name: 'commons',
          records,
          summary: undefined,
          acknowledged: undefined,
          divider: undefined,
          newCount: 0,
          needsYou: false,
          trend: 'flat',
          top: 'beginning',
          detached: false,
          error: undefined,
        },
      ],
    ]),
    ownMessageIds: client.transaction.ownMessageIds,
  };
}
const find = (name: string) => {
  const c = featureCommands.find((c) => c.name === name);
  if (!c) throw new Error(name);
  return c;
};
describe('features against installed post in a throwaway mail root', () => {
  beforeAll(async () => {
    if (!realPost) throw new Error('installed post required');
    await initializePost(box);
    agent = await PrivateAgent.start({
      keyFile: box.cfg.keyFile,
      env: box.env,
      askPassphrase: () => '',
    });
    recovery = new SendRecord(
      new DraftSpace({
        ownerRoom: box.cfg.ownerRoom,
        ownerRoomDir: box.cfg.ownerRoomDir,
        mailRoot: box.cfg.mailRoot,
      }),
    );
    const { runProcess } = await import('@estate/post-kit');
    const connected = await OwnerPost.connect({
      config: box.cfg,
      env: box.env,
      executable: realPost,
      agent,
      recovery,
      run: async (exe, spec) => {
        if (spec.args.includes('--send') || spec.args.includes('--emote'))
          expect(sendingInContext, 'feature bypassed CommandContext.send').toBe(true);
        const result = await runProcess(exe, spec);
        if (loseNextReceipt && spec.args.includes('--send')) {
          loseNextReceipt = false;
          return { ...result, stdout: 'unreadable receipt' };
        }
        return result;
      },
    });
    if (!connected.ok) throw new Error(connected.error.message);
    client = connected.value;
    expect((await client.join('commons')).ok).toBe(true);
    s = {
      ...state(),
      owner: {
        room: client.owner.ownerRoom,
        participant: client.owner.participant,
        label: client.owner.label,
        marker: client.owner.marker,
      },
      armed: true,
      post: {
        client,
        agent,
        recovery,
        config: buildConfig({
          ownerRoom: box.cfg.ownerRoom,
          ownerRoomDir: box.cfg.ownerRoomDir,
          mailRoot: box.cfg.mailRoot,
          marker: box.cfg.marker,
          label: box.cfg.label,
        }),
      },
    };
  });
  afterAll(async () => {
    if (agent) await agent.stop();
    box.cleanup();
  });
  it('poll votes, exact copy/save and seen use real message receipts', async () => {
    const c = ctx();
    expect(
      (
        await c.send({
          channel: 'commons',
          body: '📊 POLL p-test: Ship?\na) Yes\nb) No',
          mode: 'casual',
          draftRevision: 0,
        })
      ).kind,
    ).toBe('confirmed');
    await refresh();
    const vote = ctx();
    await find('vote').run('p-test a', vote);
    expect(vote.status).toHaveBeenCalledWith(expect.stringContaining('sent '));
    s = { ...s, mode: 'signed' };
    await find('vote').run('p-test b', ctx());
    await refresh();
    const renderer = pollRenderer();
    const poll = s.views.get('commons')?.records.find((r) => r.text.startsWith('📊 POLL'));
    if (!poll) throw new Error('missing poll');
    const { Grid } = await import('../../src/grid/grid.ts');
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ] as const) {
      const grid = new Grid(cols, rows, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
      const draw = () => renderer.draw(grid, { x: 0, y: 0, w: cols, h: rows }, poll, s);
      draw();
      await vi.waitFor(() => {
        draw();
        expect(grid.toText()).toContain('a) Yes (0)');
        expect(grid.toText()).toContain('b) No (1)');
        expect(grid.toText()).toContain('▀');
      });
    }
    const seen = ctx();
    await find('seen').run('', seen);
    expect(seen.status).toHaveBeenCalledWith(expect.stringContaining('seen-by'));
    const copy = vi.spyOn(featureRuntime, 'copy').mockResolvedValue('copied');
    try {
      await find('copy').run('', ctx());
      expect(copy).toHaveBeenCalledWith(expect.stringContaining('🗳️ p-test: b'));
    } finally {
      copy.mockRestore();
    }
    const save = ctx();
    await find('save').run('', save);
    const status = vi.mocked(save.status).mock.calls[0]?.[0] ?? '';
    expect(status).toContain('saved 4 records');
    const path = status.split(' → ')[1];
    if (!path) throw new Error(status);
    expect(readFileSync(path, 'utf8')).toContain('📊 POLL p-test');
  });
  it('signed decisions project from exact verified action bytes and anchor badges', async () => {
    const decisions = new Decisions();
    await refresh();
    const anchor = s.views.get('commons')?.records.find((r) => r.kind === 'message');
    if (!anchor) throw new Error('no anchor');
    const proposal = ctx();
    await decisions
      .commands()
      .find((c) => c.name === 'decision')
      ?.run(`${anchor.raw.id} porch Ship it`, proposal);
    expect(proposal.status).toHaveBeenCalledWith(expect.stringContaining('sent '));
    const beforeGuard = await client.history('commons', 10000);
    const casual = context({ ...s, mode: 'casual' });
    await decisions
      .commands()
      .find((c) => c.name === 'accept')
      ?.run('dr-1', casual);
    expect(casual.send).not.toHaveBeenCalled();
    expect(casual.status).toHaveBeenCalledWith(expect.stringContaining('SIGNED'));
    expect(await client.history('commons', 10000)).toEqual(beforeGuard);
    const accept = ctx();
    await decisions
      .commands()
      .find((c) => c.name === 'accept')
      ?.run('dr-1', accept);
    expect(accept.status).toHaveBeenCalledWith(expect.stringContaining('sent '));
    const sentId = vi.mocked(accept.status).mock.calls[0]?.[0]?.slice(5) ?? '';
    const actor = await decisionActor(box.cfg.mailRoot, sentId);
    if (!actor) throw new Error('no actor');
    expect(await verify(actor, client.owner, { env: box.env })).toEqual(
      expect.objectContaining({ state: 'verified' }),
    );
    const records = await decisions.refresh(s);
    expect(records.get('dr-1')?.state).toBe('ratified');
    expect(decisions.badge(s, anchor.raw.id)).toContain('ratified');
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ] as const) {
      const { Grid } = await import('../../src/grid/grid.ts');
      const g = new Grid(cols, rows, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
      decisions.renderer().draw(g, { x: 0, y: 0, w: cols, h: rows }, anchor, s);
      expect(g.toText()).toContain('DR·ratified');
      // The record's ink is theme ink: the body in `data`, the badge in its state colour.
      expect(offTheme(g)).toEqual([]);
      // A poll or image anchor carries the badge as a footnote under its own body, in `gray`.
      const under = new Grid(cols, rows, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
      decisions.decorate(messageRenderer).draw(under, { x: 0, y: 0, w: cols, h: rows }, anchor, s);
      expect(under.toText()).toContain('ratified');
      expect(offTheme(under)).toEqual([]);
    }
    const duplicateDir = join(box.cfg.mailRoot, 'channels', 'archive-copy', 'messages');
    mkdirSync(duplicateDir, { recursive: true });
    const actorBytes = readFileSync(
      join(box.cfg.mailRoot, 'channels', 'commons', 'messages', `${sentId}.msg`),
    );
    writeFileSync(join(duplicateDir, `${sentId}.msg`), actorBytes);
    await expect(decisionActor(box.cfg.mailRoot, sentId)).rejects.toThrow('duplicate');
    expect((await new Decisions().refresh(s)).get('dr-1')?.state).toBe('needs_operator_decision');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(duplicateDir, `${sentId}.msg`));
    const runDecision = async (name: string, args: string) => {
      const c = ctx();
      await decisions
        .commands()
        .find((command) => command.name === name)
        ?.run(args, c);
      expect(c.status).toHaveBeenCalledWith(expect.stringContaining('sent '));
    };
    await runDecision('decision', `${anchor.raw.id} porch Replacement`);
    await runDecision('accept', 'dr-2');
    await runDecision('supersede', 'dr-1 dr-2');
    expect((await decisions.refresh(s)).get('dr-1')?.state).toBe('superseded');
    await runDecision('decision', `${anchor.raw.id} porch Declined`);
    await runDecision('reject', 'dr-3');
    expect((await decisions.refresh(s)).get('dr-3')?.state).toBe('rejected');
    await runDecision('decision', `${anchor.raw.id} porch External action`);
    const after = afterProposal((await decisions.refresh(s)).get('dr-4')?.created);
    if (after === undefined) throw new Error('missing proposal time');
    const delay = Math.max(0, Math.ceil(Number(after - BigInt(Date.now()) * 1000000n) / 1000000));
    await new Promise((resolve) => setTimeout(resolve, delay + 5));
    expect(
      (
        await ctx().send({
          channel: 'commons',
          body: '⚖️ DR dr-4 accepted',
          mode: 'signed',
          draftRevision: 0,
        })
      ).kind,
    ).toBe('confirmed');
    await refresh();
    await decisions.observe(s);
    expect((await decisions.refresh(s)).get('dr-4')?.state).toBe('ratified');
  }, 10000);
  it('image attachments use confirmed receipt trust after real post delivery', async () => {
    const path = join(box.root, 'source.png');
    writeFileSync(
      path,
      encode({
        width: 1,
        height: 2,
        channels: 4,
        data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
      }),
    );
    const images = new Images(new FeatureRuntime({ spool: join(box.root, 'spool'), env: box.env }));
    const c = ctx();
    await images.command().run(path, c);
    expect(c.status).toHaveBeenCalledWith(expect.stringContaining('sent '));
    await refresh();
    const r = s.views.get('commons')?.records.at(-1);
    if (!r) throw new Error('missing image');
    expect(r.text).toContain('/spool/');
    expect(images.trusted(r, s)).toBe(true);
    await images.load(r, s);
    const { Grid } = await import('../../src/grid/grid.ts');
    const grid = new Grid(40, 52, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
    images.renderer().draw(grid, { x: 0, y: 0, w: 40, h: 52 }, r, s);
    expect(grid.toText()).toContain('▀');
  });
  it('refuses signed actors from another channel or sent before their proposal', async () => {
    s = { ...s, mode: 'signed' };
    const log = join(box.cfg.ownerRoomDir, 'decision-records.jsonl');
    expect((await client.join('other-decisions')).ok).toBe(true);
    const cross = await ctx().send({
      channel: 'other-decisions',
      body: '⚖️ DR dr-90 accepted',
      mode: 'signed',
      draftRevision: 0,
    });
    const early = await ctx().send({
      channel: 'commons',
      body: '⚖️ DR dr-91 accepted',
      mode: 'signed',
      draftRevision: 0,
    });
    if (cross.kind !== 'confirmed' || early.kind !== 'confirmed')
      throw new Error('test actors did not land');
    const sameSecond = await ctx().send({
      channel: 'commons',
      body: '⚖️ DR dr-92 accepted',
      mode: 'signed',
      draftRevision: 0,
    });
    if (sameSecond.kind !== 'confirmed') throw new Error('same-second actor did not land');
    const raw = await decisionActor(box.cfg.mailRoot, sameSecond.id);
    const time = sentTime(raw?.sent);
    if (time === undefined) throw new Error('missing same-second time');
    const floorSecond = new Date(Number(time / 1000000n)).toISOString().replace('.000Z', 'Z');
    for (const [dr, actor, created] of [
      ['dr-90', cross.id, new Date(Date.now() - 10000).toISOString()],
      ['dr-91', early.id, new Date().toISOString()],
      ['dr-92', sameSecond.id, floorSecond],
    ] as const) {
      await appendEvent(
        {
          type: 'proposed',
          dr,
          title: 'Replay check',
          project: 'porch',
          channel: 'commons',
          anchor_message_id: early.id,
          created,
        },
        log,
      );
      await appendEvent({ type: 'ratified', dr, actor_message_id: actor }, log);
    }
    const decisions = new Decisions();
    const projected = await decisions.refresh(s);
    expect(projected.get('dr-90')?.state).toBe('needs_operator_decision');
    expect(projected.get('dr-91')?.state).toBe('needs_operator_decision');
    expect(projected.get('dr-92')?.state).toBe('needs_operator_decision');
    // The cached authenticity memo must still honor a changed proposal context.
    expect((await decisions.refresh(s)).get('dr-90')?.state).toBe('needs_operator_decision');
    const wrongChannel = context({ ...s, current: 'other-decisions' });
    await decisions
      .commands()
      .find((c) => c.name === 'accept')
      ?.run('dr-90', wrongChannel);
    expect(wrongChannel.send).not.toHaveBeenCalled();
    expect(wrongChannel.status).toHaveBeenCalledWith(expect.stringContaining('proposal channel'));
  });
  it('restore checks history, keeps evidence and words, never sends or auto-discards', async () => {
    loseNextReceipt = true;
    const sent = await ctx().send({
      channel: 'commons',
      body: 'recovery words',
      mode: 'casual',
      draftRevision: 0,
    });
    expect(sent.kind).toBe('uncertain');
    if (sent.kind !== 'uncertain') throw new Error('expected uncertain receipt');
    const old = sent.recordId;
    const before = await client.history('commons', 10000);
    const ui = new Recovery();
    const c = ctx();
    await ui.command().run('', c);
    expect(c.openOverlay).toHaveBeenCalledWith('recovery');
    const { Grid } = await import('../../src/grid/grid.ts');
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ] as const) {
      const grid = new Grid(cols, rows, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
      ui.overlay().draw(grid, { x: 0, y: 0, w: cols, h: rows }, s);
      expect(grid.toText()).toContain('likely landed in');
      expect(grid.toText()).toContain('recovery words');
      // The selection marker is Trey's cyan, as in every other list; the card stays pink.
      const marks: string[] = [];
      grid.forEachCell((c) => {
        if (c.ch === '▶') marks.push(c.fg);
      });
      expect(marks).toEqual([T.cyan]);
      expect(grid.toText()).not.toMatch(/\d{20}-[0-9a-f]{6}/);
    }
    const key = { name: 'enter', ctrl: false, alt: false, shift: false };
    ui.overlay().key(key, { ...s, current: 'elsewhere' });
    expect(s.actions.status).toHaveBeenCalledWith('open #commons before restoring; record kept');
    ui.overlay().key(key, { ...s, composer: { ...s.composer, text: 'new draft' } });
    expect(s.actions.status).toHaveBeenCalledWith('draft kept; clear it before restoring');
    ui.overlay().key(key, s);
    await vi.waitFor(() => expect(s.actions.setDraft).toHaveBeenCalledWith('recovery words'));
    expect(await recovery.restore(old)).toEqual(
      expect.objectContaining({ text: 'recovery words' }),
    );
    expect(c.status).not.toHaveBeenCalledWith(expect.stringContaining('sent '));
    expect(s.actions.status).toHaveBeenCalledWith(expect.stringContaining('likely landed in'));
    expect(await client.history('commons', 10000)).toEqual(before);
    await ui.command().run('', ctx());
    const originalRestore = recovery.restore.bind(recovery);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.spyOn(recovery, 'restore').mockImplementation(async (id) => {
      await blocked;
      return originalRestore(id);
    });
    const frames = vi.mocked(s.actions.requestFrame).mock.calls.length;
    vi.mocked(s.actions.setDraft).mockClear();
    ui.overlay().key(key, s);
    expect(slow).toHaveBeenCalledWith(old);
    ui.overlay().key({ ...key, name: 'escape' }, s);
    s.actions.setDraft('new words');
    release();
    await vi.waitFor(() =>
      expect(vi.mocked(s.actions.requestFrame).mock.calls.length).toBeGreaterThan(frames),
    );
    expect(s.actions.setDraft).toHaveBeenCalledTimes(1);
    expect(s.actions.setDraft).toHaveBeenLastCalledWith('new words');
    slow.mockRestore();
    expect((await recovery.list()).some((r) => r.id === old)).toBe(true);
  });
  it('archive and unarchive read back post channel state', async () => {
    await find('archive').run('', ctx());
    const before = await client.channels();
    // channels() lists archived channels too (the browser's archived view), marked `archived`.
    expect(before.ok && before.value.find((c) => c.name === 'commons')?.archived).toBe(true);
    await find('unarchive').run('', ctx());
    const after = await client.channels();
    expect(after.ok && after.value.find((c) => c.name === 'commons')?.archived).toBe(false);
  });
  it('emote lands as an opaque record and contributes no attention', async () => {
    const { runProcess, ownerEnv, decodeJson } = await import('@estate/post-kit');
    const peerDir = join(box.root, 'crew');
    mkdirSync(peerDir, { mode: 0o700 });
    let peer: string | undefined;
    const peerPost = async (args: string[]) => {
      const out = await runProcess(realPost ?? '', {
        args,
        env: ownerEnv(box.env, box.cfg, peer),
        cwd: peerDir,
        timeoutMs: 10000,
      });
      if (out.code !== 0) throw new Error(out.stderr);
      const data = decodeJson(out.stdout, out.stderr);
      if (!data?.ok) throw new Error('invalid peer response');
      return data;
    };
    await peerPost(['rooms', 'add', 'crew', peerDir, '--json']);
    const bound = await peerPost([
      'participant',
      'bind',
      '--harness',
      'test',
      '--key',
      'features-peer',
      '--workspace',
      'crew',
      '--json',
    ]);
    peer = String(bound.id);
    await peerPost(['chat', 'commons', '--join', '--json']);
    await ctx().send({
      channel: 'commons',
      body: 'ordinary attention control',
      mode: 'casual',
      draftRevision: 0,
    });
    const peerBefore = await peerPost(['channels', '--json']);
    expect((peerBefore.channels as { unread: number }[])[0]?.unread).toBeGreaterThan(0);
    expect((await client.setAvatar(defaultAvatar('mara'))).ok).toBe(true);
    s = { ...s, avatars: new Map([[s.owner.participant, defaultAvatar('mara')]]) };
    const misrouted = {
      ...ctx(),
      send: Object.assign(
        async (req: Parameters<CommandContext['send']>[0]) => {
          sendingInContext = true;
          try {
            return await client.transaction.send(req);
          } finally {
            sendingInContext = false;
          }
        },
        { emotes: true as const },
      ),
    };
    const wordsBefore = await client.history('commons', 10000);
    await find('emote').run('wave', misrouted);
    expect(await client.history('commons', 10000)).toEqual(wordsBefore);
    expect(misrouted.status).not.toHaveBeenCalledWith(expect.stringContaining('sent '));
    const before = await client.channels();
    const c = ctx();
    await find('emote').run('wave', c);
    expect(c.status).toHaveBeenCalledWith(expect.stringContaining('sent '));
    const after = await client.channels();
    expect(after).toEqual(before);
    expect(await peerPost(['channels', '--json'])).toEqual(peerBefore);
    await refresh();
    expect(s.views.get('commons')?.records.at(-1)?.kind).toBe('emote');
    const { isAttentionEligible } = await import('@estate/post-kit');
    const r = s.views.get('commons')?.records.at(-1);
    if (!r) throw new Error('no emote');
    expect(isAttentionEligible(r.raw, { room: 'bolt' })).toBe(false);
  });
});
