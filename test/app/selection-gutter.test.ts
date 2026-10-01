/**
 * The selection gutter fills the selected message's own rows and nothing above them. A group's
 * head is four rows tall and runs down beside the group's later short messages, so selecting one
 * of those must leave the head whole (it used to paint the bezel over the head's bottom row).
 */
import { describe, expect, it } from 'vitest';
import { K } from '../../src/app/theme.ts';
import { find, frame, key, makeApp, press, record, summary } from './harness.ts';

const COLS = 100;
const ROWS = 30;
const HEAD_ROWS = 4;

/**
 * Three messages from one sender inside a group window; the head outlasts the first two. `at`
 * shifts the minutes: the stream caches a message's height by id, so a test with a different last
 * message needs ids of its own.
 */
async function group(last = 'third line', at = 0) {
  return makeApp({
    channels: [summary('commons', { unread: 0 })],
    records: {
      commons: [
        record({ minutes: at - 3, body: 'first line' }),
        record({ minutes: at - 2, body: 'second line' }),
        record({ minutes: at - 1, body: last }),
      ],
    },
  });
}

describe('selection gutter', () => {
  it('selecting a later message of a group leaves the head above it whole', async () => {
    const app = await group();
    const before = frame(app, COLS, ROWS);
    const head = find(before, 'Bolt');
    const third = find(before, 'third line');
    if (head === undefined || third === undefined) throw new Error('group not drawn');
    // The precondition that makes this a test: the head reaches the last message's row.
    expect(third.y).toBeLessThan(head.y + HEAD_ROWS);

    press(app, key('up', { ctrl: true })); // picks the newest message, the group's last
    const after = frame(app, COLS, ROWS);
    expect(find(after, 'third line')?.y).toBe(third.y);

    for (let dy = 0; dy < HEAD_ROWS; dy++)
      for (let x = 1; x <= 8; x++)
        expect(after.at(x, head.y + dy), `head cell ${x},${head.y + dy}`).toEqual(
          before.at(x, head.y + dy),
        );
  });

  it('fills the selected message’s own rows in the gutter, and only those', async () => {
    const app = await group('third line\nfourth\nfifth\nsixth', -20);
    press(app, key('up', { ctrl: true }));
    const g = frame(app, COLS, ROWS);
    const head = find(g, 'Bolt');
    const third = find(g, 'third line');
    if (head === undefined || third === undefined) throw new Error('group not drawn');
    // Its first row is beside the head's last, so the head keeps the gutter there; the rows past
    // the head's end are the message's own in every gutter column, margin included.
    expect(third.y).toBe(head.y + HEAD_ROWS - 1);
    for (const dy of [1, 2, 3])
      for (let x = 0; x <= 8; x++)
        expect(g.at(x, third.y + dy)?.bg, `col ${x} row ${third.y + dy}`).toBe(K.bezel);
    // The message above is not selected: its margin column stays plain.
    expect(g.at(0, third.y - 1)?.bg).not.toBe(K.bezel);
    // Nor is the row after the message.
    expect(g.at(0, third.y + 4)?.bg).not.toBe(K.bezel);
  });
});
