import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OwnerPost } from '../src/client.ts';
import { isAttentionEligible, toDisplay } from '../src/records.ts';
import { initializePost, realPost, sandbox } from './helpers.ts';

// The capability is probed against the installed binary, never inferred from its version number.
const s = sandbox();
const info =
  realPost === undefined
    ? ''
    : execFileSync(realPost, ['version', '--json'], {
        env: s.env,
        cwd: s.cfg.ownerRoomDir,
        encoding: 'utf8',
      });
const ready = info.includes('avatars-v1') && info.includes('emotes-v1');
describe('avatars and emotes against T2', () => {
  let client: OwnerPost;
  beforeAll(async () => {
    if (!ready) return;
    await initializePost(s);
    const connected = await OwnerPost.connect({
      executable: realPost as string,
      env: s.env,
      config: s.cfg,
    });
    if (!connected.ok) throw new Error(connected.error.message);
    client = connected.value;
    const result = await client.join('commons');
    if (!result.ok) throw new Error(result.error.message);
  });
  afterAll(() => s.cleanup());
  it.skipIf(!ready)('avatar round-trip is silent — needs T2 binary', async () => {
    const before = await client.history('commons', 200);
    const pack: unknown = JSON.parse(
      readFileSync(join(process.cwd(), 'contract', 'avatars', 'valid', 'trey.json'), 'utf8'),
    );
    expect((await client.setAvatar(pack)).ok).toBe(true);
    const avatars = await client.avatars();
    expect(avatars.ok && avatars.value.get(client.owner.participant)).toEqual(pack);
    const after = await client.history('commons', 200);
    expect(after).toEqual(before);
  });
  it.skipIf(!ready)(
    'emote history/exact retrieval never contribute attention — needs T2 binary',
    async () => {
      const outcome = await client.emote('commons', 'wave');
      expect(outcome.kind).toBe('confirmed');
      if (outcome.kind !== 'confirmed') throw new Error(JSON.stringify(outcome));
      const exact = await client.message('commons', outcome.id);
      if (!exact.ok) throw new Error(exact.error.message);
      expect(exact.value.file).toBe('emote');
      expect(exact.value.signature.present).toBe(false);
      expect(exact.value.emote?.verdict).toBe('playable');
      expect(isAttentionEligible(exact.value, { room: 'someone-else' })).toBe(false);
      const display = toDisplay(exact.value, {
        anchor: s.cfg,
        verdict: { state: 'unsigned', reason: 'emote' },
      });
      expect(display.kind).toBe('emote');
      expect(display.text).toContain('wave');
      const history = await client.history('commons', 200);
      expect(history.ok && history.value.some((r) => r.id === outcome.id)).toBe(true);
    },
  );
  it.skipIf(!ready)(
    'emotes are never seen-by, reply or mark-read targets — needs T2 binary',
    async () => {
      const outcome = await client.emote('commons', 'wave');
      if (outcome.kind !== 'confirmed') throw new Error('emote');
      expect((await client.seenBy('commons', outcome.id)).ok).toBe(false);
      expect((await client.markRead('commons', outcome.id)).ok).toBe(false);
      expect((await client.send('commons', 'reply', { replyTo: outcome.id })).kind).toBe('refused');
    },
  );
});
