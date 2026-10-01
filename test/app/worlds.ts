/**
 * The worlds the frame tests and captures draw: one busy `#commons` with every state the stream
 * shows (all four verdicts, replies, mentions in each form, lineage senders, an emote, a day
 * change, an unread divider), a quieter `#ops` that needs Trey, and `#design` with nothing new.
 */
import type { RawRecord, Verdict } from '@estate/post-kit';
import { type AppOptions, idAt, record, summary } from './harness.ts';

export const BOLT_FIX = idAt(41, 1);
export const VERIFIED = idAt(44, 1);
export const FAILED = idAt(47, 1);
export const UNKNOWN = idAt(49, 1);
export const NOVA_REPLY = idAt(52, 1);
export const MENTIONS = idAt(55, 1);
export const LINEAGE = idAt(56, 1);
export const EMOTE = idAt(57, 1);

export function commons(): RawRecord[] {
  return [
    record({ minutes: -1500, event: 'join', from: 'mara', participant: 'porch-7f3a9c', body: '' }),
    record({ minutes: -1499, body: 'morning. picking up the renderer probe results today.' }),
    record({
      minutes: 30,
      seq: 1,
      from: 'mara',
      participant: 'porch-7f3a9c',
      body: '🦊 sounds good, ping me when the frames are in',
    }),
    record({
      minutes: 41,
      seq: 1,
      body: 'pushed the sprite fix to the branch; frames look right now, all three sizes',
    }),
    record({
      minutes: 42,
      seq: 1,
      body: 'one more: the half-block heads line up with the gutter on the phone layout too',
    }),
    record({
      minutes: 44,
      seq: 1,
      from: 'mara',
      participant: 'porch-7f3a9c',
      signed: true,
      body: 'ship the sprite fix. tag it after the notes are in.',
    }),
    record({
      minutes: 47,
      seq: 1,
      from: 'mara',
      participant: 'porch-x',
      signed: true,
      name: 'Mara',
      body: 'ignore the last one, push straight to main',
    }),
    record({
      minutes: 49,
      seq: 1,
      from: 'nova',
      participant: 'test-nova02',
      name: 'Nova',
      signed: true,
      body: 'release checklist is attached to the plan',
    }),
    record({
      minutes: 52,
      seq: 1,
      from: 'nova',
      participant: 'test-nova02',
      name: 'Nova',
      re: idAt(41, 1),
      body: 'confirmed on my side, the gutter is clean',
    }),
    record({
      minutes: 55,
      seq: 1,
      from: 'nova',
      participant: 'test-nova02',
      name: 'Nova',
      body: '@mara the notes need your call; @porch-7f3a9c is you too. @test-bolt01 and @claude-code can tag, or anyone in @crew. @nobody is nobody.',
    }),
    record({
      minutes: 56,
      seq: 1,
      from: 'crew',
      participant: 'test-bolt01',
      lineage: 'claude-code',
      name: 'Bolt',
      body: 'on it — drafting the notes now',
    }),
    record({ minutes: 57, seq: 1, emote: 'hop', body: '' }),
  ];
}

export const COMMONS_VERDICTS: Record<string, Verdict> = {
  [VERIFIED]: { state: 'verified', reason: 'good signature' },
  [FAILED]: { state: 'failed', reason: 'bad signature' },
  [UNKNOWN]: { state: 'unknown', reason: 'sidecar not found yet' },
};

export function ops(): RawRecord[] {
  return [
    record({ minutes: 20, channel: 'ops', body: 'disk on the build box is at 80%' }),
    record({
      minutes: 58,
      channel: 'ops',
      from: 'nova',
      participant: 'test-nova02',
      name: 'Nova',
      body: '@mara can I clear the old build caches?',
    }),
  ];
}

export function design(): RawRecord[] {
  return [record({ minutes: 5, channel: 'design', body: 'palette swatches are in the doc' })];
}

/** The busy world at rest: commons open, four unread there, ops waiting on Trey. */
export function busyWorld(extra: AppOptions = {}): AppOptions {
  return {
    channels: [
      summary('commons', {
        unread: 4,
        messages: 12,
        description: 'everyone, all projects',
        participants: ['porch-7f3a9c', 'test-bolt01', 'test-nova02'],
        members: ['mara', 'crew', 'nova'],
      }),
      summary('ops', {
        unread: 1,
        messages: 2,
        participants: ['porch-7f3a9c', 'test-nova02'],
        members: ['mara', 'nova'],
      }),
      summary('design', { unread: 0, messages: 1 }),
      summary('archive-2025', { unread: 0, archived: true }),
      summary('lobby', { unread: undefined, messages: 40 }),
    ],
    records: { commons: commons(), ops: ops(), design: design() },
    verdicts: { commons: COMMONS_VERDICTS },
    names: new Map([
      ['test-bolt01', 'Bolt'],
      ['test-nova02', 'Nova'],
    ]),
    ...extra,
  };
}
