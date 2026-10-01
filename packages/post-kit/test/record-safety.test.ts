import { afterAll, describe, expect, it } from 'vitest';
import { parseMessages, parseRaw, toDisplay } from '../src/records.ts';
import { interpret } from '../src/run.ts';
import { parseCrossed } from '../src/wire.ts';
import { jsonOutcome, sandbox } from './helpers.ts';

describe('untrusted records and failure text at the display boundary', () => {
  const s = sandbox();
  afterAll(() => s.cleanup());
  const envelope = {
    id: 'id',
    from: 'crew',
    channel: 'commons',
    sent: 'now',
    body: '\x1b[31mhello\u202e',
  };
  it('crossed messages retain raw bytes and can only be displayed after sanitization', () => {
    const { channel: _channel, ...receiptMessage } = envelope;
    const crossed = parseCrossed(
      {
        unseen: 1,
        addressed_to_you: 1,
        messages: [{ ...receiptMessage, addressed_to_you: false }],
      },
      'commons',
    );
    expect(crossed?.messages).toHaveLength(1);
    const record = crossed?.messages[0];
    if (!record) throw new Error('crossed message missing');
    expect(record.body).toBe(envelope.body);
    expect(record.bodyComplete).toBe(false);
    expect(toDisplay(record, { anchor: s.cfg }).text).toBe('[31mhello');
  });
  it('PostError strips terminal and bidi controls from JSON failures and raw stderr', () => {
    for (const out of [
      jsonOutcome({ ok: false, error: { code: 'bad', message: 'error\x1b[31m\u202e' } }, 65),
      { code: 65, stdout: '', stderr: 'error\x1b[31m\u202e' },
    ]) {
      const result = interpret(out, 'read');
      expect(result).toMatchObject({ ok: false, error: { message: 'error[31m' } });
    }
  });
  it('I2 bad payload becomes a bubble; oversized emote envelope is omitted without losing good history', () => {
    const bubble = parseRaw(
      { ...envelope, event: 'emote', emote: { name: 'wave', steps: 'bad' } },
      'commons',
    );
    expect(bubble?.emote?.verdict).toBe('bubble');
    expect(bubble && toDisplay(bubble, { anchor: s.cfg }).text).toBe('✦ crew wave');
    const oversized = { ...envelope, event: 'emote', future: 'x'.repeat(4096) };
    expect(parseRaw(oversized, 'commons')).toBeUndefined();
    expect(
      parseMessages({ ok: true, messages: [oversized, envelope] }, 'commons')?.map((r) => r.id),
    ).toEqual(['id']);
  });
});
