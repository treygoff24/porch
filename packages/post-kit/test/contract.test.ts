import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnerPost } from '../src/client.ts';
import { ownerEnv } from '../src/owner.ts';
import { parseRaw } from '../src/records.ts';
import { SendRecord } from '../src/recovery.ts';
import { decodeJson, runProcess } from '../src/run.ts';
import { PrivateAgent } from '../src/signing.ts';
import { verify } from '../src/verify.ts';
import { goldenCases, initializePost, python, realPost, sandbox } from './helpers.ts';

describe('contract with real Post, using a file-local store', () => {
  const s = sandbox();
  let client: OwnerPost;
  let peer: string;
  const peerDir = join(s.root, 'crew');
  async function peerPost(args: string[], input?: string) {
    const out = await runProcess(realPost as string, {
      args,
      env: ownerEnv(s.env, s.cfg, peer),
      cwd: peerDir,
      timeoutMs: 10000,
      ...(input === undefined ? {} : { input }),
    });
    if (out.code !== 0 || out.failed !== undefined) throw new Error(`peer post: ${out.stderr}`);
    const data = decodeJson(out.stdout, out.stderr);
    if (data === undefined || data.ok !== true) throw new Error('invalid peer response');
    return data;
  }
  function pythonVerify(id: string) {
    return python(
      s,
      'import os,subprocess,sys;original=subprocess.run\ndef run(args,*a,**kw):\n if args[0]=="post": args=[os.environ["PORCH_REAL_POST"],*args[1:]]\n return original(args,*a,**kw)\nsubprocess.run=run\nfrom porch3.verifycli import main\nprint("RC="+str(main([sys.argv[1],"--channel","commons"])))',
      [id],
    );
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
    mkdirSync(peerDir, { mode: 0o700 });
    await peerPost(['rooms', 'add', 'crew', peerDir, '--json']);
    const bound = await peerPost([
      'participant',
      'bind',
      '--harness',
      'test',
      '--key',
      'peer',
      '--workspace',
      'crew',
      '--json',
    ]);
    peer = bound.id as string;
    expect(peer).toBeTypeOf('string');
    await peerPost(['chat', 'commons', '--join', '--json']);
  });
  afterAll(() => s.cleanup());
  const capture = (name: string, value: unknown) => {
    if (process.env.PORCH_CAPTURE === '1')
      writeFileSync(
        join(import.meta.dirname, 'fixtures', `${name}.json`),
        `${JSON.stringify(value, null, 2)}\n`,
      );
  };
  it('schema includes the required stable verbs', async () => {
    const result = await runProcess(realPost as string, {
      args: ['schema'],
      env: s.env,
      cwd: s.cfg.ownerRoomDir,
      timeoutMs: 10000,
    });
    expect(result.code).toBe(0);
    const schema = decodeJson(result.stdout, result.stderr);
    expect(schema).toBeDefined();
    const text = JSON.stringify(schema);
    for (const name of ['signature', 'participant', 'history'])
      expect(text.includes(name)).toBe(true);
    capture('post-schema', schema);
  });
  it('stable participant binding and env isolation, real casual send and exact complete retrieval', async () => {
    const again = await OwnerPost.connect({
      executable: realPost as string,
      config: s.cfg,
      env: {
        ...s.env,
        POST_PARTICIPANT: 'wrong',
        CODEX_THREAD_ID: 'wrong',
        SSH_AUTH_SOCK: '/wrong',
      },
    });
    if (!again.ok) throw new Error(again.error.message);
    expect(again.value.owner.participant).toBe(client.owner.participant);
    const result = await client.send('commons', 'body with trailing spaces \r\n', {
      draftRevision: 4,
    });
    expect(result.kind).toBe('confirmed');
    if (result.kind !== 'confirmed') throw new Error(JSON.stringify(result));
    const exact = await client.message('commons', result.id);
    if (!exact.ok) throw new Error(exact.error.message);
    expect(exact.value.body).toBe('🦊 body with trailing spaces \r\n');
    expect(exact.value.bodyComplete).toBe(true);
    expect(client.transaction.ownMessageIds.has(result.id)).toBe(true);
    expect(await new SendRecord(s.cfg).list()).toEqual([]);
    capture('exact-message', exact.value.envelope);
    const history = await client.history('commons', 200);
    if (!history.ok) throw new Error(history.error.message);
    capture('history', { ok: true, messages: history.value.map((r) => r.envelope) });
  });
  it('all three implementations agree on valid v1 and v2 bytes', async () => {
    for (const name of ['raw-controls-crlf-trailing-space', 'signed-v1']) {
      const vector = goldenCases.find((v) => v.name === name);
      if (!vector) throw new Error('vector');
      const args = ['chat', 'commons', '--send', '--json', '--body-file', '-'];
      const ref = vector.record.signature_ref as { tag: string } | undefined;
      if (ref !== undefined) args.push('--signature-ref', ref.tag);
      const sent = await runProcess(realPost as string, {
        args,
        input: vector.record.body as string,
        env: ownerEnv(s.env, s.cfg, client.owner.participant),
        cwd: s.cfg.ownerRoomDir,
        timeoutMs: 10000,
      });
      const receipt = decodeJson(sent.stdout, sent.stderr);
      expect(sent.code).toBe(0);
      const message = receipt?.message as Record<string, unknown>;
      const id = message.id as string;
      const history = await runProcess(realPost as string, {
        args: ['chat', 'commons', '--history', '200', '--json'],
        env: ownerEnv(s.env, s.cfg, client.owner.participant),
        cwd: s.cfg.ownerRoomDir,
        timeoutMs: 10000,
      });
      const data = decodeJson(history.stdout, history.stderr);
      const messages = data?.messages as Record<string, unknown>[];
      const returned = messages.find((m) => m.id === id);
      expect(returned?.signed_verified).toBe(true);
      const raw = parseRaw(returned, 'commons');
      if (!raw) throw new Error('real record');
      expect((await verify(raw, s.cfg)).state).toBe('verified');
      expect(pythonVerify(id)).toContain('RC=0');
      capture(name, returned);
    }
  });
  it('private agent signs v2 through its own socket and real Post verifies; stop disarms', async () => {
    let prompts = 0;
    const agent = await PrivateAgent.start({
      keyFile: s.cfg.keyFile,
      env: s.env,
      askPassphrase: () => {
        prompts++;
        return '';
      },
    });
    try {
      expect(prompts).toBe(1);
      expect(agent.armed).toBe(true);
      expect(agent.env.SSH_AUTH_SOCK).not.toBe(process.env.SSH_AUTH_SOCK);
      const connected = await OwnerPost.connect({
        executable: realPost as string,
        env: s.env,
        config: s.cfg,
        agent,
      });
      if (!connected.ok) throw new Error(connected.error.message);
      expect(await connected.value.signing()).toBe('signed');
      // Arming is separate from per-send mode: an armed client's default is still casual.
      const casual = await connected.value.send('commons', 'still casual');
      if (casual.kind !== 'confirmed') throw new Error('casual');
      const casualRaw = await connected.value.message('commons', casual.id);
      expect(casualRaw.ok && casualRaw.value.signature.present).toBe(false);
      const signed = await connected.value.send('commons', '  signed\r\n\x1braw\x85\t \n', {
        mode: 'signed',
      });
      expect(signed.kind).toBe('confirmed');
      if (signed.kind !== 'confirmed') throw new Error(JSON.stringify(signed));
      const exact = await connected.value.message('commons', signed.id);
      if (!exact.ok) throw new Error(exact.error.message);
      expect((await verify(exact.value, s.cfg)).state).toBe('verified');
      const history = await client.history('commons', 200);
      if (!history.ok) throw new Error(history.error.message);
      expect(history.value.find((r) => r.id === signed.id)?.envelope.signed_verified).toBe(true);
      expect(pythonVerify(signed.id)).toContain('RC=0');
      expect(exact.value.envelope.signed_verified).toBeUndefined(); // verdict metadata belongs to the slice response, not envelope
      capture('signed-send', exact.value.envelope);
    } finally {
      await agent.stop();
    }
    expect(agent.armed).toBe(false);
  });
  it('seen-by reports real member ids, explicit markRead changes only the owner cursor', async () => {
    const sent = await peerPost(
      ['chat', 'commons', '--send', '--body-file', '-', '--json'],
      'seen control',
    );
    const id = (sent.message as { id: string }).id;
    const before = await client.seenBy('commons', id);
    if (!before.ok) throw new Error(before.error.message);
    expect(before.value).not.toContain(client.owner.participant);
    expect(before.value).toContain(peer);
    const marked = await client.markRead('commons', id);
    expect(marked.ok && marked.value.advanced).toBe(true);
    const after = await client.seenBy('commons', id);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value).toContain(client.owner.participant);
    expect([...after.value].sort()).toEqual([...before.value, client.owner.participant].sort());
    capture('seen-by', { ok: true, seen_by: after.value });
  });
  it('history, since, exact-message and seen-by reads leave the owner unread counts unchanged', async () => {
    const tip = await client.history('commons', 200);
    if (!tip.ok || tip.value.at(-1) === undefined) throw new Error('history needs an anchor');
    const since = tip.value.at(-1)?.id as string;
    const sent = await peerPost(
      ['chat', 'commons', '--send', '--body-file', '-', '--json'],
      'unread read control',
    );
    const id = (sent.message as { id: string }).id;
    async function unread() {
      const channels = await client.channels();
      if (!channels.ok) throw new Error(channels.error.message);
      return channels.value.find((c) => c.name === 'commons')?.unread;
    }
    const before = await unread();
    expect(before).toBeGreaterThan(0);
    for (const read of [
      () => client.history('commons', 200),
      () => client.since('commons', since),
      () => client.message('commons', id),
      () => client.seenBy('commons', id),
    ]) {
      expect((await read()).ok).toBe(true);
      expect(await unread()).toBe(before);
    }
    const seen = await client.seenBy('commons', id);
    expect(seen.ok && seen.value.includes(client.owner.participant)).toBe(false);
  });
  it('a full 1 MiB signed body is fetched completely across the JSON byte budget', async () => {
    const agent = await PrivateAgent.start({
      keyFile: s.cfg.keyFile,
      env: s.env,
      askPassphrase: () => '',
    });
    try {
      const r = await OwnerPost.connect({
        executable: realPost as string,
        config: s.cfg,
        env: s.env,
        agent,
      });
      if (!r.ok) throw new Error(r.error.message);
      const body = `${'x'.repeat(1048573)}\r\n `;
      const sent = await r.value.send('commons', body, { mode: 'signed' });
      if (sent.kind !== 'confirmed') throw new Error(JSON.stringify(sent));
      const fetched = await r.value.message('commons', sent.id);
      if (!fetched.ok) throw new Error(fetched.error.message);
      expect(fetched.value.bodyComplete).toBe(true);
      expect(fetched.value.body === body).toBe(true);
      expect((await verify(fetched.value, s.cfg)).state).toBe('verified');
      expect((await r.value.send('commons', `${body}x`, { mode: 'signed' })).kind).toBe('refused');
    } finally {
      await agent.stop();
    }
  });
  it('archive and unarchive are real Post operations', async () => {
    expect((await client.archive('commons')).ok).toBe(true);
    const archived = await client.channels();
    expect(archived.ok).toBe(true);
    expect((await client.unarchive('commons')).ok).toBe(true);
  });
});
