/**
 * Who stands on a channel's stage, and what each one's name tag and task line say. Everything here
 * is read from the snapshot: post's member list, the loaded window, the avatars and profile names
 * the core loaded. Nothing is inferred (plan T7): an agent with no message in the loaded window has
 * the task line `—`.
 *
 * Order is stable so sprites never jump around: Trey first (his avatar stands on the stage too, so
 * his own emotes play there), then post's local participants in the order post lists them, then any
 * remote sender (a bridged agent post does not list as a local participant) in order of first
 * appearance in the window.
 *
 * Attribution follows the verification law (see `attributable`): nothing unverified speaks for Trey.
 */
import {
  type AvatarPack,
  defaultAvatar,
  type PaletteIndex,
  resolveAccent,
  SPRITE_PALETTE,
} from '@estate/pixel';
import type { DisplayRecord } from '@estate/post-kit';
import { isPollTraffic } from '../derive.ts';
import type { AppState } from '../state.ts';
import { T } from './theme.ts';

export type CrewMember = {
  /** Post participant id: the key for avatars, names and seen sets. */
  readonly id: string;
  readonly name: string;
  /**
   * Gray text after the name when another member of the channel has the same one (directory, then
   * the id's tail); empty otherwise. Another agent's words: gray and nothing more.
   */
  readonly hint: string;
  readonly isOwner: boolean;
  readonly pack: AvatarPack;
  readonly accent: PaletteIndex;
  /** The accent as a colour. */
  readonly accentHex: string;
  /** The first line of this member's latest message in the loaded window, or `—`. */
  readonly task: string;
};

/** Shown in place of a task line when the window holds no message from that member. */
export const NO_TASK = '—';

const defaults = new Map<string, AvatarPack>();

/** The member's own valid pack, else the deterministic generated one (I3 `defaultAvatar`). */
export function packFor(id: string, s: AppState): AvatarPack {
  const own = s.avatars.get(id);
  if (own !== undefined) return own;
  let pack = defaults.get(id);
  if (pack === undefined) {
    pack = defaultAvatar(id);
    defaults.set(id, pack);
  }
  return pack;
}

/**
 * Whether a record may be attributed to the participant it names. Anything that would act as Trey
 * needs post-kit's owner attribution (`sender.isOwner`: his room, and verified or a casual send):
 * a failed or unchecked claim from his room is "claims Trey" and drives nobody, and a record from
 * another room that names his participant id is a spoof and drives nobody either.
 */
export function attributable(r: DisplayRecord, s: AppState): boolean {
  const claimsOwner = r.raw.from === s.owner.room || r.raw.fromParticipant === s.owner.participant;
  return !claimsOwner || (r.raw.from === s.owner.room && r.sender.isOwner);
}

/**
 * The task line: literally the first line of the message, or undefined when that line is blank
 * (the caller shows `—`, as for no message). Tabs and a CR show as spaces; nothing is skipped.
 */
export function firstLine(text: string): string | undefined {
  const line = (text.split('\n')[0] ?? '').replace(/[\t\r]/g, ' ');
  return line.trim() === '' ? undefined : line;
}

export function memberIds(channel: string, s: AppState): string[] {
  const ids: string[] = [];
  const add = (id: string | undefined) => {
    if (id !== undefined && id !== '' && !ids.includes(id)) ids.push(id);
  };
  add(s.owner.participant);
  const summary = s.channels.find((c) => c.name === channel) ?? s.views.get(channel)?.summary;
  for (const id of summary?.participants ?? []) add(id);
  for (const r of s.views.get(channel)?.records ?? []) {
    if (r.kind === 'event' || !attributable(r, s)) continue;
    add(r.raw.fromParticipant);
  }
  return ids;
}

export function crewFor(channel: string, s: AppState): CrewMember[] {
  const records = s.views.get(channel)?.records ?? [];
  const latest = new Map<string, DisplayRecord>();
  const label = new Map<string, string>();
  for (const r of records) {
    const id = r.raw.fromParticipant;
    if (id === undefined || !attributable(r, s)) continue;
    label.set(id, r.sender.text);
    // Polls and ballots are machinery, not what anyone is doing: the task line skips them.
    if (r.kind !== 'message' || isPollTraffic(r.text)) continue;
    const prev = latest.get(id);
    if (prev === undefined || r.raw.id > prev.raw.id) latest.set(id, r);
  }
  const hints = s.hints(channel);
  return memberIds(channel, s).map((id) => {
    const isOwner = id === s.owner.participant;
    const pack = packFor(id, s);
    const accent = resolveAccent(pack, { isOwner }, id);
    const msg = latest.get(id);
    return {
      id,
      name: isOwner ? s.owner.label : (s.names.get(id) ?? label.get(id) ?? id),
      hint: isOwner ? '' : (hints.get(id) ?? ''),
      isOwner,
      pack,
      accent,
      // Trey's tag is cyan whatever his avatar's accent: cyan is Trey, and only Trey.
      accentHex: isOwner ? T.cyan : (SPRITE_PALETTE[accent] ?? '#dfe6ea'),
      task: (msg === undefined ? undefined : firstLine(msg.text)) ?? NO_TASK,
    };
  });
}
