/**
 * What the app derives from post's records, all from real records (plan T6): who a mention names,
 * whether a lane needs Trey, how a lane's activity is trending, and the short labels a record shows.
 *
 * Mentions resolve the way ruling 9 says: an `@word` names someone when it matches a participant
 * id, a lineage or a room (case-insensitive), and post's stamped `mentions` list counts as well.
 */
import {
  BALLOT_MARK,
  type DisplayRecord,
  isAttentionEligible,
  POLL_MARK,
  parseSent,
  type RawRecord,
  type SelfIds,
} from '@estate/post-kit';
import { graphemes } from '../grid/text.ts';
import type { Trend } from './state.ts';

/** The names a mention can resolve to, lower-cased. */
export type Directory = {
  /** Owner's room and participant id: a mention of either calls on Trey. */
  owner: ReadonlySet<string>;
  /** Every participant id, lineage and room seen in the channel. */
  known: ReadonlySet<string>;
};

export function directoryFor(
  owner: { room: string; participant: string },
  records: readonly RawRecord[],
  extra: readonly string[] = [],
): Directory {
  const own = new Set([owner.room.toLowerCase(), owner.participant.toLowerCase()]);
  const known = new Set<string>(own);
  for (const r of records) {
    known.add(r.from.toLowerCase());
    if (r.fromParticipant !== undefined) known.add(r.fromParticipant.toLowerCase());
    if (r.fromLineage !== undefined) known.add(r.fromLineage.toLowerCase());
  }
  for (const name of extra) known.add(name.toLowerCase());
  return { owner: own, known };
}

/** `@word` tokens in a body: where each is and the word, without the `@`. */
export type MentionSpan = { start: number; end: number; name: string };

export function mentionSpans(text: string): MentionSpan[] {
  const out: MentionSpan[] = [];
  for (const m of text.matchAll(/(^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    const word = (m[2] ?? '').replace(/[._-]+$/, '');
    if (word === '') continue;
    const start = (m.index ?? 0) + (m[1] ?? '').length;
    out.push({ start, end: start + 1 + word.length, name: word });
  }
  return out;
}

/**
 * Show a mention of a participant by the participant's name. Post resolves `@loom-52b3dee9` and
 * not `@Fern`, so the body keeps the id and only what is drawn changes. `skip` holds ids that
 * stay as written (Trey's own, which is lit as his). Names are keyed by lower-case id.
 */
export function showMentionNames(
  text: string,
  names: ReadonlyMap<string, string>,
  skip: ReadonlySet<string>,
): string {
  if (!text.includes('@') || names.size === 0) return text;
  let out = text;
  for (const span of mentionSpans(text).reverse()) {
    const id = span.name.toLowerCase();
    const name = names.get(id) ?? names.get(span.name);
    if (name === undefined || skip.has(id)) continue;
    out = `${out.slice(0, span.start)}@${name}${out.slice(span.end)}`;
  }
  return out;
}

/**
 * A record's sender under the name the roster gives its participant (profile name, else lineage).
 * Post-kit labels a sender `Lineage [participant-id]`, which shows the id; once a name is known the
 * name stands alone. Trey's own records and a participant with no name are left as they are.
 */
export function nameSender(
  d: DisplayRecord,
  names: ReadonlyMap<string, string>,
  ownerRoom: string,
): DisplayRecord {
  const id = d.raw.fromParticipant;
  if (id === undefined || d.raw.from === ownerRoom) return d;
  const name = names.get(id);
  if (name === undefined || name === d.sender.text) return d;
  return { ...d, sender: { ...d.sender, text: name } };
}

/** A directory for a narrow list: home shortened to `~`. */
export function tildePath(path: string, home: string | undefined): string {
  if (home === undefined || home === '' || home === '/') return path;
  const h = home.endsWith('/') ? home.slice(0, -1) : home;
  if (path === h) return '~';
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/** Does `r` call on Trey by mention: a stamped mention, or an `@word` naming his room or id. */
export function mentionsOwner(r: RawRecord, dir: Directory): boolean {
  if (r.mentions.some((m) => dir.owner.has(m.toLowerCase()))) return true;
  return mentionSpans(r.body).some((s) => dir.owner.has(s.name.toLowerCase()));
}

/**
 * A lane needs Trey when post says it is unread and an unread attention-eligible record mentions
 * him or replies to one of his messages, or a decision record in it waits on him.
 *
 * Post's unread count is authoritative: the newest `unread` eligible records are the unread ones.
 */
export function needsYou(
  records: readonly RawRecord[],
  unread: number,
  self: SelfIds,
  dir: Directory,
  ownIds: ReadonlySet<string>,
  decisionWaiting = false,
): boolean {
  if (decisionWaiting) return true;
  if (unread <= 0) return false;
  const eligible = records.filter((r) => isAttentionEligible(r, self));
  const owned = new Set(ownIds);
  for (const r of records) if (r.from === self.room) owned.add(r.id);
  return eligible
    .slice(-unread)
    .some((r) => mentionsOwner(r, dir) || (r.re !== undefined && owned.has(r.re)));
}

const TEN_MINUTES = 10 * 60 * 1000;

/** Attention-eligible records in the last ten minutes against the ten before. */
export function trendOf(records: readonly RawRecord[], self: SelfIds, now: number): Trend {
  let recent = 0;
  let before = 0;
  for (const r of records) {
    if (!isAttentionEligible(r, self)) continue;
    const t = parseSent(r.sent);
    if (t === undefined || t > now) continue;
    if (now - t <= TEN_MINUTES) recent += 1;
    else if (now - t <= 2 * TEN_MINUTES) before += 1;
  }
  return recent > before ? 'up' : recent < before ? 'down' : 'flat';
}

/**
 * `2026-09-30 21:40:13 -0500` → its date and clock time on Trey's own clock (this machine's time
 * zone), converted through the offset the sender's host wrote. The stream, its day separators and
 * search all show times through this, so one message has one time everywhere. A `sent` that does
 * not parse as an instant shows the date and time as written, or nothing.
 */
export function sentParts(sent: string): { day: string; time: string } {
  const t = parseSent(sent);
  if (t !== undefined) {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return {
      day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
      time: `${p(d.getHours())}:${p(d.getMinutes())}`,
    };
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(sent);
  return m === null ? { day: '', time: '' } : { day: m[1] ?? '', time: m[2] ?? '' };
}

/** `MM-DD HH:MM` on Trey's clock (search hits, recovery records); `sent` itself if it does not parse. */
export function sentWhen(sent: string): string {
  const { day, time } = sentParts(sent);
  return day === '' ? sent : `${day.slice(5)} ${time}`;
}

/** A message id's short form: the first six characters of its last `-` segment. */
export function shortId(id: string): string {
  const last = id.split('-').at(-1) ?? id;
  return last.slice(0, 6);
}

/**
 * One line of a body, whitespace collapsed, cut to `max` characters (grapheme clusters, so an
 * emoji or an accent is never split) with an ellipsis.
 */
export function preview(body: string, max: number): string {
  const one = body.replace(/\s+/g, ' ').trim();
  const g = graphemes(one);
  return g.length <= max ? one : `${g.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** A ballot as post-poll sends it (`🗳️ <poll>: <letter>`), nothing else on the line. */
export type Ballot = { readonly poll: string; readonly choice: string };

/**
 * The ballot a body is, when it is exactly the ballot form post-poll and `/vote` send. A body that
 * says more than that is not shown as a ballot: an agent's own words stay as typed.
 */
export function ballotOf(text: string): Ballot | undefined {
  const t = text.trim();
  if (!t.startsWith(BALLOT_MARK)) return undefined;
  const m = /^(\S+):\s*(\S)$/u.exec(t.slice(BALLOT_MARK.length));
  if (m === null) return undefined;
  return { poll: m[1] ?? '', choice: (m[2] ?? '').toLowerCase() };
}

/** A poll or a ballot: poll machinery, which never stands as what someone is doing. */
export function isPollTraffic(text: string): boolean {
  const t = text.trim();
  return t.startsWith(POLL_MARK) || t.startsWith(BALLOT_MARK);
}
