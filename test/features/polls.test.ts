import { expect, it, vi } from 'vitest';
import { Polls } from '../../src/app/features/polls.ts';
import { Grid } from '../../src/grid/grid.ts';
import { offTheme, record, state, withClient } from './helpers.ts';

it('fetches on open and Ctrl+O once, merges arrivals during fetch, and excludes failed owner ballots', async () => {
  const poll = record('📊 POLL p1: Ship?\na) Yes\nb) No');
  const a = record('🦊 🗳️ p1: a', {
    from: 'mara',
    id: '20260930-230001-000001-abcdef',
    sent: '2026-09-30T23:00:01Z',
  });
  const b = record('🦊 🗳️ p1: b', {
    from: 'mara',
    id: '20260930-230002-000001-abcdef',
    sent: '2026-09-30T23:00:02Z',
  });
  const failed = {
    ...b,
    text: '🗳️ p1: a',
    raw: { ...b.raw, id: '20260930-230003-000001-abcdef', sent: '2026-09-30T23:00:03Z' },
    verdict: { state: 'failed' as const, reason: 'wrong signature' },
  };
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const historyPage = vi.fn(async () => {
    await blocked;
    return { ok: true as const, value: { messages: [poll.raw, a.raw], skipped: undefined } };
  });
  const s = withClient(state([poll, a]), {
    historyPage,
    owner: { ownerRoom: 'mara', marker: '🦊', label: 'Mara' } as NonNullable<
      ReturnType<typeof state>['post']
    >['client']['owner'],
  });
  const polls = new Polls();
  const renderer = polls.renderer();
  const grid = new Grid(40, 52, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
  const draw = (snapshot = s) => renderer.draw(grid, { x: 0, y: 0, w: 40, h: 52 }, poll, snapshot);
  draw();
  draw();
  const opened = polls.open(s, 'commons');
  const next = { ...s, views: new Map(s.views) };
  const view = next.views.get('commons');
  if (!view) throw new Error('missing view');
  next.views.set('commons', { ...view, records: [poll, a, b, failed] });
  draw(next);
  expect(historyPage).toHaveBeenCalledTimes(1);
  release();
  await opened;
  draw(next);
  expect(grid.toText()).toContain('a) Yes (0)');
  expect(grid.toText()).toContain('b) No (1)');
  expect(grid.toText()).toContain('1 votes');
  // The card's ink is theme ink: the rows in `data`, the footer in `gray`, nothing off-palette.
  expect(offTheme(grid)).toEqual([]);
  draw(next);
  expect(historyPage).toHaveBeenCalledTimes(1);
  expect(polls.key().key({ name: 'o', ctrl: true, alt: false, shift: false }, next)).toBe('pass');
  polls.key().key({ name: 'o', ctrl: true, alt: false, shift: false }, next);
  expect(historyPage).toHaveBeenCalledTimes(2);
  await polls.open(next, 'commons');
  expect(historyPage).toHaveBeenCalledTimes(2);
  await polls.open(next, 'commons');
  expect(historyPage).toHaveBeenCalledTimes(3);
});
