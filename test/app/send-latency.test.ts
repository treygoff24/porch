/**
 * Trey's live test, 2026-10-01: "two to four seconds between pressing Enter and the message
 * appearing at all". Post took ~10 ms; Porch waited for the next poll tick. Now his words are on
 * screen at Enter as a pending entry (gray, `sending…`), and the receipt reads the channel at once.
 */
import type { SendOutcome } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import { K } from '../../src/app/theme.ts';
import { find, frame, key, lines, makeApp, OWNER, press, record, settle, type } from './harness.ts';
import { busyWorld } from './worlds.ts';

const WORDS = 'ahoy there matey';

/** How many screen rows show `text`. */
function rowsWith(app: Awaited<ReturnType<typeof makeApp>>, text: string): number {
  return lines(frame(app, 100, 32)).filter((l) => l.includes(text)).length;
}

/** The real record post would hold for the send (marker first, as a casual send is stored). */
function real(id: string) {
  const r = record({
    minutes: 70,
    seq: 1,
    from: OWNER.room,
    participant: OWNER.participant,
    body: `${OWNER.marker} ${WORDS}`,
  });
  return { ...r, id };
}

function deferredSend() {
  let settleSend: (o: SendOutcome) => void = () => {};
  return {
    outcome: () =>
      new Promise<SendOutcome>((resolve) => {
        settleSend = resolve;
      }),
    resolve: (o: SendOutcome) => settleSend(o),
  };
}

describe('own message at Enter', () => {
  it('shows before post has answered, dimmed with sending…, and cannot be picked', async () => {
    const d = deferredSend();
    const app = await makeApp(busyWorld({ outcome: d.outcome }));
    type(app, WORDS);
    press(app, key('return'));
    await settle();
    // The send has not resolved, yet the words are in the stream (and the draft is still kept).
    expect(app.sends).toHaveLength(1);
    const pending = app.m.state().views.get('commons')?.pending;
    expect(pending?.map((p) => p.text)).toEqual([WORDS]);
    const g = frame(app, 100, 32);
    const text = lines(g);
    // The header row says so (the status line says it too, but it is not beside the P1 tag).
    expect(text.some((l) => l.includes('P1') && l.includes('sending…'))).toBe(true);
    // The stream's copy is gray; a confirmed message of his would be body-text white.
    const at = find(g, WORDS);
    expect(at).toBeDefined();
    expect(g.at(at?.x ?? 0, at?.y ?? 0)?.fg).toBe(K.gray);
    // Stream row + composer row: the words show in both while the draft is kept.
    expect(text.filter((l) => l.includes(WORDS))).toHaveLength(2);
    // Not a record post holds: nothing can acknowledge, pick or reply to it.
    expect(app.m.records('commons').some((r) => r.body.includes(WORDS))).toBe(false);
    d.resolve({ kind: 'refused', code: 'x', message: 'no' });
    await settle();
  });

  it('a receipt reads the channel at once and the real record replaces it, once', async () => {
    const d = deferredSend();
    const app = await makeApp(busyWorld({ outcome: d.outcome }));
    let finishRefresh: () => void = () => {};
    app.source.onRefresh = (channel) =>
      new Promise<void>((resolve) => {
        finishRefresh = () => {
          const id = '20260930-221000-000001-aaaaaa';
          app.source.setRecords(channel, [...(app.source.all.get(channel) ?? []), real(id)]);
          resolve();
        };
      });
    type(app, WORDS);
    press(app, key('return'));
    await settle();
    expect(app.source.refreshed).toEqual([]);
    d.resolve({ kind: 'confirmed', id: '20260930-221000-000001-aaaaaa' });
    await settle();
    // No timer ran: the receipt itself asked for the read.
    expect(app.source.refreshed).toEqual(['commons']);
    // The draft cleared on the receipt; the pending entry is the one row with the words.
    expect(rowsWith(app, WORDS)).toBe(1);
    expect(app.m.state().views.get('commons')?.pending).toHaveLength(1);
    finishRefresh();
    await settle();
    expect(app.m.state().views.get('commons')?.pending).toBeUndefined();
    expect(rowsWith(app, WORDS)).toBe(1);
    expect(rowsWith(app, 'sending…')).toBe(0);
  });

  it('never shows twice when the real record is read before the refresh answers', async () => {
    const d = deferredSend();
    const app = await makeApp(busyWorld({ outcome: d.outcome }));
    const id = '20260930-221000-000001-aaaaaa';
    app.source.onRefresh = () => new Promise<void>(() => {});
    type(app, WORDS);
    press(app, key('return'));
    await settle();
    d.resolve({ kind: 'confirmed', id });
    await settle();
    // A regular poll brings the record while the refresh is still in flight.
    app.source.setRecords('commons', [...(app.source.all.get('commons') ?? []), real(id)]);
    await settle();
    expect(rowsWith(app, WORDS)).toBe(1);
    expect(rowsWith(app, 'sending…')).toBe(0);
  });

  it('never shows twice when a poll brings the record before the receipt comes back', async () => {
    const d = deferredSend();
    const app = await makeApp(busyWorld({ outcome: d.outcome }));
    type(app, WORDS);
    press(app, key('return'));
    await settle();
    app.source.setRecords('commons', [
      ...(app.source.all.get('commons') ?? []),
      real('20260930-221000-000001-aaaaaa'),
    ]);
    await settle();
    // No outcome yet (the status line still says sending…), but no pending row is drawn.
    expect(app.m.state().views.get('commons')?.pending).toBeUndefined();
    d.resolve({ kind: 'confirmed', id: '20260930-221000-000001-aaaaaa' });
    await settle();
    expect(rowsWith(app, WORDS)).toBe(1);
  });

  it('a refused send removes it, keeps the draft and shows the existing banner', async () => {
    const d = deferredSend();
    const app = await makeApp(busyWorld({ outcome: d.outcome }));
    type(app, WORDS);
    press(app, key('return'));
    await settle();
    expect(app.m.state().views.get('commons')?.pending).toHaveLength(1);
    d.resolve({ kind: 'refused', code: 'not_a_member', message: 'post said no' });
    await settle();
    expect(app.m.state().views.get('commons')?.pending).toBeUndefined();
    expect(app.m.notice?.text).toBe('not sent: post said no');
    expect(app.m.composer().text).toBe(WORDS);
    // Nothing was sent that post holds, so nothing is read for it either.
    expect(app.source.refreshed).toEqual([]);
    expect(rowsWith(app, 'sending…')).toBe(0);
    // Only the draft remains on screen.
    expect(rowsWith(app, WORDS)).toBe(1);
  });

  it('an uncertain send removes it, keeps the recovery notice and reads the channel once', async () => {
    const d = deferredSend();
    const app = await makeApp(busyWorld({ outcome: d.outcome }));
    type(app, WORDS);
    press(app, key('return'));
    await settle();
    d.resolve({ kind: 'uncertain', reason: 'timed out', recordId: 'r1' });
    await settle();
    expect(app.m.state().views.get('commons')?.pending).toBeUndefined();
    expect(app.m.notice?.text).toContain('send uncertain');
    expect(app.source.refreshed).toEqual(['commons']);
  });
});
