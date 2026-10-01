/**
 * READY! hop end to end against the installed post (plan T7): a temporary mail root, Trey's owner
 * room, and two real agent participants. Trey sends through post-kit's PostStore; one agent reads
 * the channel, which puts it in post's seen set; the store's seen stream reaches the stage; that
 * agent hops once and gets its read mark, and the agent that has not read does neither. Then the
 * second agent reads and hops in turn.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeJson,
  OwnerPost,
  ownerEnv,
  PostStore,
  runProcess,
  toDisplay,
} from '@estate/post-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializePost, realPost, sandbox } from '../../packages/post-kit/test/helpers.ts';
import { markAttractSeen } from '../../src/app/stage/attract.ts';
import { createStage, memberBox, STAGE_HEIGHT } from '../../src/app/stage/stage.ts';
import type { AppState } from '../../src/app/state.ts';
import { IdleSteps, lines, Rig } from './rig.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('READY! from real seen sets', () => {
  const s = sandbox();
  let client: OwnerPost;
  const agents: Record<'bolt' | 'wisp', string> = { bolt: '', wisp: '' };

  async function agentPost(room: 'bolt' | 'wisp', args: string[]) {
    const out = await runProcess(realPost as string, {
      args,
      env: ownerEnv(s.env, s.cfg, agents[room] === '' ? undefined : agents[room]),
      cwd: join(s.root, room),
      timeoutMs: 10000,
    });
    if (out.code !== 0 || out.failed !== undefined) throw new Error(`${room}: ${out.stderr}`);
    const data = decodeJson(out.stdout, out.stderr);
    if (data === undefined || data.ok !== true) throw new Error(`${room}: invalid response`);
    return data;
  }

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
    for (const room of ['bolt', 'wisp'] as const) {
      mkdirSync(join(s.root, room), { mode: 0o700 });
      await agentPost(room, ['rooms', 'add', room, join(s.root, room), '--json']);
      const bound = await agentPost(room, [
        'participant',
        'bind',
        '--harness',
        'test',
        '--key',
        room,
        '--workspace',
        room,
        '--json',
      ]);
      agents[room] = bound.id as string;
      await agentPost(room, ['chat', 'commons', '--join', '--json']);
    }
  }, 60_000);
  afterAll(() => s.cleanup());

  it("each agent that reads Trey's latest send hops once, in the order post reports them", async () => {
    const store = new PostStore({ client, markReadOnView: false });
    const rig = new Rig();
    const stage = createStage({ stateDir: () => s.root, timers: new IdleSteps() });
    // The first launch has been seen already in this sandbox.
    markAttractSeen(s.root);
    const owner = {
      room: s.cfg.ownerRoom,
      participant: client.owner.participant,
      label: s.cfg.label,
      marker: s.cfg.marker,
    };
    const state = (): AppState => rig.state(100, 32, { owner });
    const seen: string[] = [];
    try {
      await store.open('commons');
      const channels = await client.channels();
      if (!channels.ok) throw new Error(channels.error.message);
      rig.channels = [...channels.value];
      rig.names.set(agents.bolt, 'Bolt');
      rig.names.set(agents.wisp, 'Wisp');
      const listed = rig.channels.find((c) => c.name === 'commons');
      expect(listed?.participants).toEqual(
        expect.arrayContaining([client.owner.participant, agents.bolt, agents.wisp]),
      );
      rig.views.set('commons', {
        name: 'commons',
        summary: listed,
        records: [],
        acknowledged: undefined,
        divider: undefined,
        newCount: 0,
        needsYou: false,
        trend: 'flat',
        top: 'beginning',
        detached: false,
        error: undefined,
      });
      rig.draw(stage, 100, 32, { state: state() });
      store.onSeen((channel, id, participant) => {
        seen.push(participant);
        stage.event({ kind: 'seen', channel, id, participant }, state());
      });

      const sent = await store.send('commons', 'ship the parser');
      if (sent.kind !== 'confirmed') throw new Error(JSON.stringify(sent));
      const record = await client.message('commons', sent.id);
      if (!record.ok) throw new Error(record.error.message);
      rig.load('commons', [toDisplay(record.value, { anchor: client.owner })]);
      stage.event({ kind: 'sent', channel: 'commons', id: sent.id, mode: 'casual' }, state());

      const readyRow = () => {
        const text = lines(rig.draw(stage, 100, 32, { state: state() }));
        const box = memberBox({ x: 0, y: 1, w: 100, h: STAGE_HEIGHT.bodies }, 'bodies', 3, 0);
        return { names: text[box.nameY] ?? '', tasks: text[box.taskY ?? -1] ?? '' };
      };
      const waitFor = async (who: string) => {
        for (let i = 0; i < 60 && !seen.includes(who); i++) await sleep(250);
        expect(seen).toContain(who);
      };

      // Nobody has read it: no marks, no hops.
      await sleep(2500);
      expect(seen).toEqual([]);
      expect(rig.clock.running).toBe(false);
      expect(readyRow().names).not.toContain('✓');

      // Bolt reads the channel; post's seen set gains Bolt; Bolt hops once.
      await agentPost('bolt', ['chat', 'commons', '--json']);
      await waitFor(agents.bolt);
      expect(seen).toEqual([agents.bolt]);
      expect(rig.clock.running).toBe(true);
      let readyFrames = 0;
      while (rig.tick() !== undefined) {
        const row = readyRow();
        if (row.tasks.includes('READY!')) readyFrames += 1;
        expect(row.tasks.match(/READY!/g)?.length ?? 0).toBeLessThanOrEqual(1);
      }
      expect(readyFrames).toBe(6);
      let row = readyRow();
      expect(row.names).toMatch(/Bolt ✓/);
      expect(row.names).not.toMatch(/Wisp ✓/);
      expect(row.names).not.toMatch(/Trey ✓/);

      // Wisp reads; only Wisp hops now.
      await agentPost('wisp', ['chat', 'commons', '--json']);
      await waitFor(agents.wisp);
      expect(seen).toEqual([agents.bolt, agents.wisp]);
      readyFrames = 0;
      while (rig.tick() !== undefined) if (readyRow().tasks.includes('READY!')) readyFrames += 1;
      expect(readyFrames).toBe(6);
      row = readyRow();
      expect(row.names).toMatch(/Bolt ✓/);
      expect(row.names).toMatch(/Wisp ✓/);
    } finally {
      store.dispose();
      stage.dispose();
    }
  }, 60_000);
});
