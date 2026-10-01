/** Capture feature states using T1's unchanged grid capture pipeline. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAvatar } from '@estate/pixel';
import { encode } from 'fast-png';
import { captureGrid } from '../../scripts/capture.ts';
import { Images } from '../../src/app/features/images.ts';
import { pollRenderer } from '../../src/app/features/polls.ts';
import { Recovery } from '../../src/app/features/recovery.ts';
import { FeatureRuntime } from '../../src/app/features/runtime.ts';
import { Grid } from '../../src/grid/grid.ts';
import { context, record, state, withClient } from './helpers.ts';

export async function captureFeatures() {
  const root = mkdtempSync(join(tmpdir(), 'porch-features-capture-'));
  try {
    const path = join(root, 'colour-study.png');
    const data = new Uint8Array(24 * 12 * 4);
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 24; x++) {
        const i = (y * 24 + x) * 4;
        data.set([Math.floor((255 * x) / 24), Math.floor((255 * y) / 12), 180, 255], i);
      }
    writeFileSync(path, encode({ width: 24, height: 12, data, channels: 4 }));
    const own = record(path, { id: '20260930-230002-000001-abcdef', from: 'mara' });
    const foreign = record('/tmp/untrusted.png', { id: '20260930-230009-000001-abcdef' });
    const poll = record('📊 POLL p1: Ship the arcade?\na) Yes, crew ready\nb) Hold for review', {
      id: '20260930-230010-000001-abcdef',
    });
    const votes = [
      record('🦊 🗳️ p1: a', {
        from: 'mara',
        fromParticipant: 'p-mara',
        id: '20260930-230011-000001-abcdef',
      }),
      record('🗳️ p1: b', {
        from: 'bolt',
        fromParticipant: 'bolt',
        id: '20260930-230012-000001-abcdef',
      }),
    ];
    const base = state([own, foreign, poll, ...votes]);
    const s = {
      ...base,
      ownMessageIds: new Set([own.raw.id]),
      avatars: new Map([
        ['p-mara', defaultAvatar('mara')],
        ['bolt', defaultAvatar('bolt')],
      ]),
    };
    const images = new Images(
      new FeatureRuntime({ env: { HOME: root }, spool: join(root, 'spool') }),
    );
    await images.load(own, s);
    const ui = new Recovery();
    const landed = record('🦊 Keep the release notes', { from: 'mara' });
    const stamp = (BigInt(Date.parse(landed.raw.sent)) * 1000000n).toString().padStart(20, '0');
    const recoveryState = withClient(
      s,
      {
        historyPage: async () => ({
          ok: true,
          value: { messages: [landed.raw], skipped: undefined },
        }),
      },
      {
        list: async () => [
          {
            id: `${stamp}-landed`,
            channel: 'commons',
            text: 'Keep the release notes',
            reply_to: null,
          },
          {
            id: `${stamp}-missing`,
            channel: 'commons',
            text: 'Hold for the device check',
            reply_to: null,
          },
        ],
      },
    );
    await ui.command().run('', context(recoveryState));
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ] as const) {
      const g = new Grid(cols, rows, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
      g.text(1, 1, 'PORCH · FEATURES', { fg: '#3fd9f2', bold: true }, cols - 2);
      images.renderer().draw(g, { x: 1, y: 3, w: cols - 2, h: 10 }, own, s);
      images.renderer().draw(g, { x: 1, y: 13, w: cols - 2, h: 3 }, foreign, s);
      pollRenderer().draw(g, { x: 1, y: 17, w: cols - 2, h: rows - 20 }, poll, s);
      await captureGrid(g, `docs/captures/features-${cols}x${rows}.png`);
      const recovery = new Grid(cols, rows, () => ({
        ch: ' ',
        fg: '#c8d8e0',
        bg: '#05080b',
        w: 1,
      }));
      ui.overlay().draw(recovery, { x: 1, y: 1, w: cols - 2, h: rows - 2 }, recoveryState);
      if (
        !recovery.toText().includes('likely landed in') ||
        !recovery.toText().includes('not found')
      )
        throw new Error('populated recovery capture lost its hints');
      await captureGrid(recovery, `docs/captures/features-recovery-${cols}x${rows}.png`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
