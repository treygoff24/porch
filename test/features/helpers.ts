import { SPRITE_PALETTE } from '@estate/pixel';
import {
  type DisplayRecord,
  type OwnerPost,
  type RawRecord,
  type SendRecord,
  toDisplay,
} from '@estate/post-kit';
import { vi } from 'vitest';
import { raw } from '../../packages/post-kit/test/helpers.ts';
import type { AppState, CommandContext } from '../../src/app/registry.ts';
import { T } from '../../src/app/stage/theme.ts';
import { K } from '../../src/app/theme.ts';
import type { Grid } from '../../src/grid/grid.ts';

export function record(body = 'hello', extra: Partial<RawRecord> = {}): DisplayRecord {
  return toDisplay(raw(undefined, { body, ...extra }), {
    anchor: {
      ownerRoom: 'mara',
      marker: '🦊',
      label: 'Mara',
      sidecarDir: '/test',
      allowedSigners: '/test/signers',
      namespace: 'mara-porch',
      principal: 'mara@porch',
    },
  });
}
export function state(records: readonly DisplayRecord[] = []): AppState {
  return {
    owner: { room: 'mara', participant: 'p-mara', label: 'Mara', marker: '🦊' },
    channels: [],
    views: new Map([
      [
        'commons',
        {
          name: 'commons',
          records,
          summary: undefined,
          acknowledged: undefined,
          divider: undefined,
          newCount: 0,
          needsYou: false,
          trend: 'flat',
          top: 'beginning',
          detached: false,
          error: undefined,
        },
      ],
    ]),
    current: 'commons',
    panes: [{ channel: 'commons', scroll: 0, pick: undefined }],
    focusedPane: 0,
    split: false,
    layout: 'phone',
    cols: 40,
    rows: 52,
    composer: { text: '', caret: 0, revision: 1, replyTo: undefined },
    mode: 'casual',
    armed: false,
    signingBlocked: undefined,
    sending: false,
    crossed: undefined,
    overlay: undefined,
    notice: undefined,
    avatars: new Map(),
    names: new Map(),
    hints: () => new Map(),
    motion: 'off',
    focused: true,
    now: 0,
    ownMessageIds: new Set(),
    post: undefined,
    actions: {
      openChannel: vi.fn(),
      jumpTo: vi.fn(),
      openOverlay: vi.fn(),
      closeOverlay: vi.fn(),
      setDraft: vi.fn(),
      insert: vi.fn(),
      replyTo: vi.fn(),
      pick: vi.fn(),
      status: vi.fn(),
      animate: vi.fn(),
      requestFrame: vi.fn(),
      appendImagePath: vi.fn(),
      quit: vi.fn(),
    },
  };
}
export function context(s = state()): CommandContext {
  return {
    state: s,
    send: vi.fn(async () => ({ kind: 'confirmed' as const, id: '20260930-230001-000001-abcdef' })),
    status: vi.fn(),
    openOverlay: vi.fn(),
  };
}

/** Only the explicitly stubbed methods may be used; no ambient post/config/key access. */
export function withClient(
  s: AppState,
  client: Partial<OwnerPost>,
  recovery: Partial<SendRecord> = {},
): AppState {
  return {
    ...s,
    post: {
      client: client as OwnerPost,
      recovery: recovery as SendRecord,
      config: {} as NonNullable<AppState['post']>['config'],
      agent: undefined,
    },
  };
}

/** Every colour a theme file names: the main screen's, the stage's and the sprite palette. */
const THEMED = new Set<string>([...Object.values(K), ...Object.values(T), ...SPRITE_PALETTE]);

/**
 * Text cells inked in a colour no theme file names, as `x,y:ch fg`. Half blocks are left out: they
 * are sprite or image pixels, whose colours come from the art, not from a theme.
 */
export function offTheme(g: Grid): string[] {
  const off: string[] = [];
  g.forEachCell((c, x, y) => {
    if (c.ch === ' ' || c.ch === '' || c.ch === '▀' || c.ch === '▄') return;
    if (!THEMED.has(c.fg)) off.push(`${x},${y}:${c.ch} ${c.fg}`);
  });
  return off;
}
