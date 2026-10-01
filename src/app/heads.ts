/**
 * The crew's faces: 8×8 heads in the stream's gutter and 16×16 resting bodies on the core's default
 * stage, drawn from each participant's avatar (or the generated default) through pixel's rasteriser.
 *
 * Trust rules: cyan as an accent stands only for Trey's own record (verified or casual), and the
 * impersonation cap applies to everyone else. A record that claims to be Trey and failed or is not
 * yet known never gets Trey's face; it gets the impostor mark instead.
 */
import {
  type AvatarPack,
  applyImpersonationCap,
  defaultAvatar,
  framePixels,
  resolveAccent,
  SPRITE_PALETTE,
  toHalfBlocks,
} from '@estate/pixel';
import type { DisplayRecord } from '@estate/post-kit';
import type { HalfBlockCell } from '../grid/grid.ts';
import { monoSprite } from './mono-art.ts';
import type { AppState } from './state.ts';
import { K } from './theme.ts';

export type Who = { id: string; isOwner: boolean };

/** Who a record shows as: its participant (or room), and whether it is Trey's own. */
export function whoOf(r: DisplayRecord, s: AppState): Who {
  if (r.sender.isOwner) return { id: s.owner.participant, isOwner: true };
  return { id: r.raw.fromParticipant ?? r.raw.from, isOwner: false };
}

/**
 * The gray text after a sender's name when another participant of the channel has the same name
 * (their directory, then the tail of their id); undefined for a unique name, Trey, and anyone
 * claiming to be Trey. The text is another agent's: draw it gray and nothing more.
 */
export function hintOf(r: DisplayRecord, s: AppState): string | undefined {
  const id = r.raw.fromParticipant;
  if (id === undefined || r.sender.isOwner || r.raw.from === s.owner.room) return undefined;
  const hint = s.hints(r.raw.storageChannel).get(id);
  return hint === undefined || hint === '' ? undefined : hint;
}

export function packOf(who: Who, s: AppState): AvatarPack {
  return s.avatars.get(who.id) ?? defaultAvatar(who.id);
}

/** The colour of someone's name tag. */
export function accentOf(who: Who, s: AppState): string {
  if (who.isOwner) return K.cyan;
  return SPRITE_PALETTE[resolveAccent(packOf(who, s), who, who.id)] ?? K.violet;
}

const cache = new Map<string, HalfBlockCell[][]>();

function cells(who: Who, s: AppState, part: 'head' | 'body', frame: string): HalfBlockCell[][] {
  const pack = packOf(who, s);
  const mono = s.noColor === true;
  const key = `${part}:${frame}:${mono ? 'mono' : 'colour'}:${who.isOwner ? 1 : 0}:${who.id}:${s.avatars.has(who.id) ? JSON.stringify(pack[part][frame] ?? pack[part].idle) : ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const accent = resolveAccent(pack, who, who.id);
  const rows = pack[part][frame] ?? pack[part].idle;
  const px = applyImpersonationCap(framePixels(rows), part, who, accent);
  const out = toHalfBlocks(mono ? monoSprite(px) : px, SPRITE_PALETTE);
  if (cache.size > 512) cache.clear();
  cache.set(key, out);
  return out;
}

/** An 8×8 head: 8 columns by 4 rows. */
export function headCells(who: Who, s: AppState, frame = 'idle'): HalfBlockCell[][] {
  return cells(who, s, 'head', frame);
}

/** A 16×16 body: 16 columns by 8 rows. */
export function bodyCells(who: Who, s: AppState, frame = 'idle'): HalfBlockCell[][] {
  return cells(who, s, 'body', frame);
}

/** A record that claims to be Trey and is not shown as him: a red question mark, never his face. */
export const IMPOSTOR_HEAD: readonly string[] = [
  '..aaaa..',
  '.aa..aa.',
  '.....aa.',
  '....aa..',
  '...aa...',
  '...aa...',
  '........',
  '...aa...',
];

export function impostorCells(mono = false): HalfBlockCell[][] {
  const px = framePixels(IMPOSTOR_HEAD);
  return toHalfBlocks(mono ? monoSprite(px) : px, SPRITE_PALETTE);
}
