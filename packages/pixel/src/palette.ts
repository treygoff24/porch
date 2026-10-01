/**
 * The format-1 sprite palette and accent rules (build plan I3). Index meanings are frozen: the
 * corpus avatars are drawn in them. Power gold is not here, so no sprite can be gold.
 *
 * Accents name an agent's tag and pane frame, so they carry meaning a sprite pixel does not:
 * cyan reads as Trey, lemon reads as gold (signed), and red reads as a warning; ink and night
 * vanish on the glass ground. Those are refused and replaced by a colour chosen from the
 * participant id. Only the app can say an avatar is the owner's, which unlocks cyan and nothing else.
 */
import type { AvatarPack, PaletteIndex, Pixel } from './types.ts';

export const SPRITE_PALETTE: readonly string[] = [
  '#0b0e14', // 0 ink: outlines, eyes
  '#1f2d52', // 1 night: deep shade
  '#6e7a88', // 2 steel
  '#d8dfe5', // 3 pale: highlights (not pure white)
  '#3c5cf0', // 4 blue: arcade blue
  '#3fd9f2', // 5 cyan: Trey
  '#3ee56d', // 6 green
  '#1d7a45', // 7 moss
  '#f2d85a', // 8 lemon: reads near gold
  '#ff8a2a', // 9 orange
  '#ff3d32', // a red: warning
  '#ff5bdc', // b magenta
  '#8f5cf0', // c violet
  '#ff9ec8', // d pink
  '#e8b089', // e tan: skin
  '#7c4a2d', // f brown: hair, wood
];

export const PALETTE_NAMES: readonly string[] = [
  'ink',
  'night',
  'steel',
  'pale',
  'blue',
  'cyan',
  'green',
  'moss',
  'lemon',
  'orange',
  'red',
  'magenta',
  'violet',
  'pink',
  'tan',
  'brown',
];

export const CYAN = 5;
export const LEMON = 8;
export const RED = 10;

/** Accents never used as given: ink and night (illegible), cyan, lemon and red (meaning). */
export const ACCENT_REFUSED: ReadonlySet<number> = new Set([0, 1, CYAN, LEMON, RED]);

/** The accents a replacement is drawn from, in index order. */
export const ACCENT_ALLOWED: readonly PaletteIndex[] = SPRITE_PALETTE.map((_, i) => i).filter(
  (i) => !ACCENT_REFUSED.has(i),
);

/** A stable 32-bit hash of a string's UTF-8 bytes (FNV-1a). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The accent to draw this avatar's tag in. A refused accent becomes one of the allowed accents,
 * chosen by the participant id (`seed`), so the same agent always gets the same colour. Cyan
 * stands only when the app says this is the post owner; gold and red are refused for everyone.
 */
export function resolveAccent(
  pack: AvatarPack,
  who: { isOwner: boolean },
  seed: string,
): PaletteIndex {
  const given = /^[0-9a-f]$/.test(pack.accent) ? Number.parseInt(pack.accent, 16) : -1;
  if (given === CYAN && who.isOwner) return CYAN;
  if (given >= 0 && !ACCENT_REFUSED.has(given)) return given;
  return ACCENT_ALLOWED[hash32(seed) % ACCENT_ALLOWED.length] ?? 4;
}

/** Pixels of cyan, lemon and red a non-owner frame may hold before the cap redraws them. */
export const IMPERSONATION_LIMIT = { body: 24, head: 6 } as const;

/**
 * The impersonation cap, a rendering rule: in a non-owner avatar, a body frame holding more than
 * 24 pixels of cyan, lemon or red (a head frame, more than 6) has all of those pixels drawn in the
 * resolved accent instead, so a sprite can use them as details but cannot dress as Trey, as a
 * signed send, or as a warning. The owner's frames are left alone. Returns a new frame.
 */
export function applyImpersonationCap(
  px: readonly (readonly Pixel[])[],
  target: 'body' | 'head',
  who: { isOwner: boolean },
  accent: PaletteIndex,
): Pixel[][] {
  const copy = px.map((row) => [...row]);
  if (who.isOwner) return copy;
  let n = 0;
  for (const row of px) for (const p of row) if (p === CYAN || p === LEMON || p === RED) n += 1;
  if (n <= IMPERSONATION_LIMIT[target]) return copy;
  return copy.map((row) => row.map((p) => (p === CYAN || p === LEMON || p === RED ? accent : p)));
}

/** Authored rows (`.` or a hex digit per pixel) as palette indices. */
export function framePixels(rows: readonly string[]): Pixel[][] {
  return rows.map((row) => [...row].map((c) => (c === '.' ? null : Number.parseInt(c, 16))));
}

/** A frozen frame string (rows joined with `/`) as palette indices. */
export function frozenPixels(frame: string): Pixel[][] {
  return framePixels(frame.split('/'));
}
