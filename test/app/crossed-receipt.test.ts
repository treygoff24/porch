/**
 * The crossed-while-typing strip is built from a real receipt (T6 ruling): an agent posts into the
 * channel while Trey is typing, then Trey's send comes back with `crossed`. This runs the installed
 * post against a file-local store and checks the receipt still has the shape the strip's frame
 * tests read from `fixtures/crossed-receipt.json`. `PORCH_CAPTURE=1` rewrites that fixture.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeJson,
  OwnerPost,
  ownerEnv,
  parseCrossed,
  type RunSpec,
  runProcess,
} from '@estate/post-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { initializePost, realPost, sandbox } from '../../packages/post-kit/test/helpers.ts';

const fixture = join(import.meta.dirname, 'fixtures', 'crossed-receipt.json');

describe('a real send receipt carries what crossed it', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  it('an agent posting while Trey types comes back in the receipt, mention and all', async () => {
    if (!realPost) throw new Error('the installed post is required (PORCH_REAL_POST)');
    const post = realPost;
    await initializePost(s);
    // The client runs post as usual; this keeps the exact bytes of its send receipt.
    let receipt: string | undefined;
    const run = async (exe: string, spec: RunSpec) => {
      const out = await runProcess(exe, spec);
      if (spec.args.includes('--send')) receipt = out.stdout;
      return out;
    };
    const connected = await OwnerPost.connect({
      executable: post,
      env: s.env,
      config: s.cfg,
      run,
    });
    if (!connected.ok) throw new Error(connected.error.message);
    const client = connected.value;
    const joined = await client.join('commons');
    if (!joined.ok) throw new Error(joined.error.message);
    const crewDir = join(s.root, 'crew');
    mkdirSync(crewDir, { mode: 0o700 });
    let agent = '';
    const agentPost = async (args: string[], input?: string) => {
      const out = await runProcess(post, {
        args,
        env: ownerEnv(s.env, s.cfg, agent),
        cwd: crewDir,
        timeoutMs: 10000,
        ...(input === undefined ? {} : { input }),
      });
      const data = decodeJson(out.stdout, out.stderr);
      if (out.code !== 0 || data?.ok !== true) throw new Error(`agent post: ${out.stderr}`);
      return data;
    };
    await agentPost(['rooms', 'add', 'crew', crewDir, '--json']);
    const bound = await agentPost([
      'participant',
      'bind',
      '--harness',
      'test',
      '--key',
      'bolt',
      '--workspace',
      'crew',
      '--json',
    ]);
    agent = bound.id as string;
    await agentPost(['chat', 'commons', '--join', '--json']);
    await agentPost(['profile', 'set', '--name', 'Bolt', '--json']);
    // Trey has read everything so far; then, while he types, Bolt posts twice.
    const seen = await runProcess(post, {
      args: ['chat', 'commons', '--discard', '--json'],
      env: ownerEnv(s.env, s.cfg, client.owner.participant),
      cwd: s.cfg.ownerRoomDir,
      timeoutMs: 10000,
    });
    expect(seen.code).toBe(0);
    const send = ['chat', 'commons', '--send', '--json', '--body-file', '-'];
    await agentPost(send, 'pushed the sprite fix to the branch, frames look right now');
    await agentPost(send, '@mara the release notes need your call before I tag it');
    const sent = await client.send('commons', 'nice, merging now');
    expect(sent.kind).toBe('confirmed');
    if (sent.kind !== 'confirmed') throw new Error(JSON.stringify(sent));
    expect(sent.crossed?.unseen).toBe(2);
    expect(sent.crossed?.addressedToYou).toBe(1);
    expect(sent.crossed?.messages.map((m) => m.body)).toEqual([
      'pushed the sprite fix to the branch, frames look right now',
      '@mara the release notes need your call before I tag it',
    ]);
    if (process.env.PORCH_CAPTURE === '1') {
      if (receipt === undefined) throw new Error('no receipt was kept');
      writeFileSync(fixture, `${JSON.stringify(JSON.parse(receipt), null, 2)}\n`);
    }
    // The committed fixture parses to the same shape the live receipt has.
    const stored = parseCrossed(JSON.parse(readFileSync(fixture, 'utf8')).crossed, 'commons');
    expect(stored?.unseen).toBe(2);
    expect(stored?.addressedToYou).toBe(1);
    expect(stored?.messages.map((m) => m.from)).toEqual(['crew', 'crew']);
  }, 30000);
});
