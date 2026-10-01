import { parseRaw, type RawRecord } from './records.ts';

/**
 * What `post` prints, read into the shapes the post pane draws. Every reader is tolerant of what
 * post 0.9.0 was seen to write (fixtures in `test/fixtures/post/`, captured 2026-09-28 from the
 * real binary against a scratch store) and returns undefined for a field it cannot read; an
 * unread count that is not a number is "not measured", never zero.
 */

/** One channel as `post channels --json` lists it, from the acting participant's side. */
export type ChannelSummary = {
  name: string;
  /**
   * Messages the acting participant has not read, from others, counted from its own join instant.
   * Joins and profile changes count. `undefined` when post reports null: not a member.
   */
  unread: number | undefined;
  /** Every message in the channel, joins included. */
  messages: number | undefined;
  /** Rooms (workspace addresses) with a member in the channel. */
  members: string[];
  /** Host-local participant ids that joined. Two sessions in one project are two of these. */
  participants: string[];
  description: string | undefined;
  archived: boolean;
};

/** A participant as `post who --json` lists it. */
export type WhoRow = {
  id: string;
  room: string | undefined;
  harness: string | undefined;
  /** A `post watch` is running for it right now. */
  liveWatch: boolean;
  /** Its lease, not whether anything is running: a session that ended an hour ago is `active`. */
  leaseActive: boolean;
  lastSeen: number | undefined;
};

/** A participant's presentation profile from `post profile list --json`. */
export type Profile = { name: string | undefined; pfp: string | undefined };

/** What `post participant list --json` records about a participant, beyond what `who` shows. */
export type RosterEntry = {
  /** The directory the participant works in (`workspace_path`). Absent for most ephemeral ones. */
  workspacePath: string | undefined;
  /** The identity name the participant took (`fable`), the fallback when it has no profile name. */
  lineage: string | undefined;
  /** The model the participant reports running (`runtime.model`), as display text. */
  model: string | undefined;
  /** The reasoning effort it reports (`runtime.effort`), as display text. */
  effort: string | undefined;
  /**
   * The directory to show for it: `runtime.cwd` when the participant described itself, else
   * `workspace_path`.
   */
  cwd: string | undefined;
};

export type PostMessage = import('./records.ts').RawRecord;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * What draws nothing and acts on the terminal instead: C0 controls but for newline and tab, DEL,
 * and C1. OpenTUI keeps an escape it is given in the cell it writes, so a name or a body from
 * another participant that carries one reaches the terminal as a sequence.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to take them out
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** Text another participant wrote, for drawing: its lines and tabs kept, its controls not. */
function plainText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(CONTROLS, '');
  return t.length > 0 ? t : undefined;
}

/** A name, subject or note another participant wrote: one line, without controls. */
export function plainLine(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : undefined;
}

/** Terminal sequences another participant could write: CSI and OSC, which `CONTROLS` alone leaves as text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to take them out
const SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;

/**
 * A runtime value (model, effort, directory) another agent described itself with: one line, no
 * control characters or terminal sequences, at most `max` characters. Anything else is absent.
 */
export function runtimeText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Bound the work before scrubbing: a record can be arbitrarily large.
  const t = plainLine(v.slice(0, max * 4).replace(SEQUENCES, ''));
  if (t === undefined) return undefined;
  return t.length > max ? `${[...t].slice(0, max - 1).join('')}…` : t;
}

/** The longest model or effort text kept: post's own limit. */
export const RUNTIME_WORD_MAX = 64;
/** The longest directory kept: post's own limit. */
export const RUNTIME_CWD_MAX = 4096;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * post's local timestamps (`2026-09-28 19:13:13 -0500`, the sender's offset) to ms. The ids carry
 * a UTC stamp too, but this is the one a byline shows.
 */
export function parseSent(sent: unknown): number | undefined {
  if (typeof sent !== 'string') return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2}):?(\d{2})$/.exec(sent.trim());
  if (m === null) {
    const t = Date.parse(sent);
    return Number.isFinite(t) ? t : undefined;
  }
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Whether the acting participant is a member of `channel`: post reports an unread count for a
 * member and null for anyone else (see `ChannelSummary.unread`). The `participants` list is not
 * used: it names who joined, and the acting participant's own id is already known by the caller.
 */
export function isMember(channel: ChannelSummary): boolean {
  return channel.unread !== undefined;
}

export function parseChannels(data: unknown): ChannelSummary[] | undefined {
  if (!isRecord(data) || data.ok !== true || !Array.isArray(data.channels)) return undefined;
  const out: ChannelSummary[] = [];
  for (const c of data.channels) {
    if (!isRecord(c)) continue;
    const name = str(c.name);
    if (name === undefined) continue;
    const unread = c.unread;
    const messages = c.messages;
    out.push({
      name,
      unread:
        typeof unread === 'number' && Number.isInteger(unread) && unread >= 0 ? unread : undefined,
      messages:
        typeof messages === 'number' && Number.isInteger(messages) && messages >= 0
          ? messages
          : undefined,
      members: strings(c.members),
      participants: strings(c.participants),
      description: plainLine(c.description),
      archived: c.archived === true,
    });
  }
  return out;
}

export function parseWho(data: unknown): WhoRow[] | undefined {
  if (!isRecord(data) || data.ok !== true || !Array.isArray(data.participants)) return undefined;
  const out: WhoRow[] = [];
  for (const p of data.participants) {
    if (!isRecord(p)) continue;
    const id = str(p.id);
    if (id === undefined) continue;
    const seen = typeof p.last_seen === 'string' ? Date.parse(p.last_seen) : Number.NaN;
    out.push({
      id,
      room: str(p.workspace),
      harness: str(p.harness),
      liveWatch: p.live_watch === true,
      leaseActive: p.state === 'active',
      lastSeen: Number.isFinite(seen) ? seen : undefined,
    });
  }
  return out;
}

export function parseRoster(data: unknown): Map<string, RosterEntry> | undefined {
  if (!isRecord(data) || data.ok !== true || !Array.isArray(data.participants)) return undefined;
  const out = new Map<string, RosterEntry>();
  for (const p of data.participants) {
    if (!isRecord(p)) continue;
    const id = str(p.id);
    if (id === undefined) continue;
    // `runtime` is what the participant said about itself (`post participant describe`); older
    // post records have none, and a malformed one is no runtime.
    const runtime = isRecord(p.runtime) ? p.runtime : {};
    const workspacePath = plainLine(p.workspace_path);
    out.set(id, {
      workspacePath,
      lineage: plainLine(p.lineage),
      model: runtimeText(runtime.model, RUNTIME_WORD_MAX),
      effort: runtimeText(runtime.effort, RUNTIME_WORD_MAX),
      cwd: runtimeText(runtime.cwd, RUNTIME_CWD_MAX) ?? workspacePath,
    });
  }
  return out;
}

export function parseProfiles(data: unknown): Map<string, Profile> | undefined {
  if (!isRecord(data) || data.ok !== true || !Array.isArray(data.profiles)) return undefined;
  const out = new Map<string, Profile>();
  for (const p of data.profiles) {
    if (!isRecord(p)) continue;
    const id = str(p.participant);
    if (id === undefined) continue;
    out.set(id, { name: plainLine(p.name), pfp: plainLine(p.pfp) });
  }
  return out;
}

/** The receipt carries the crossed messages; sending never clears their unread state. */
export type Crossed = {
  unseen: number;
  addressedToYou: number;
  messages: readonly RawRecord[];
};

export function parseCrossed(v: unknown, channel?: string): Crossed | undefined {
  if (!isRecord(v)) return undefined;
  const unseen = v.unseen;
  const addressed = v.addressed_to_you;
  if (typeof unseen !== 'number' || !Number.isInteger(unseen) || unseen <= 0) return undefined;
  return {
    unseen,
    messages: Array.isArray(v.messages)
      ? v.messages.slice(0, 10).flatMap((message) => {
          if (!isRecord(message)) return [];
          const storageChannel = channel ?? str(message.channel);
          if (storageChannel === undefined) return [];
          const record = parseRaw(
            { ...message, channel: message.channel ?? storageChannel },
            storageChannel,
            {
              bodyComplete: message.addressed_to_you === true,
            },
          );
          return record === undefined ? [] : [record];
        })
      : [],
    addressedToYou:
      typeof addressed === 'number' && Number.isInteger(addressed) && addressed >= 0
        ? Math.min(addressed, unseen)
        : 0,
  };
}

/**
 * A file post could not read and left out of an answer (post 7286de3 and later): its id, why, and
 * the channel when it is a message file (a membership file or a participant record has none).
 */
export type SkippedItem = { id: string; reason: string; channel: string | undefined };

/** The `[{id, reason, channel?}]` list of a listing's `skipped`; anything else is no list. */
export function parseSkippedList(v: unknown): SkippedItem[] {
  if (!Array.isArray(v)) return [];
  const out: SkippedItem[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const id = str(item.id);
    if (id === undefined) continue;
    out.push({ id, reason: str(item.reason) ?? '', channel: str(item.channel) });
  }
  return out;
}

/**
 * How much of a chat read post left out: message files it could not read. `count` is all of them
 * (post carries only the first few, with `skipped_files_total`, when a read is byte-bounded),
 * `ids` the ones it named, `hint` the command it says lists every one.
 */
export type Skipped = { count: number; ids: string[]; hint: string | undefined };

export function parseChatSkipped(data: unknown): Skipped | undefined {
  if (!isRecord(data)) return undefined;
  const items = parseSkippedList(data.skipped_files);
  const total = data.skipped_files_total;
  const count =
    typeof total === 'number' && Number.isInteger(total) && total >= items.length
      ? total
      : items.length;
  if (count === 0) return undefined;
  return { count, ids: items.map((i) => i.id), hint: str(data.skipped_files_hint) };
}

/** Two answers about one channel put together: every id named by either, and the larger count. */
export function mergeSkipped(a: Skipped | undefined, b: Skipped | undefined): Skipped | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ids = [...new Set([...a.ids, ...b.ids])];
  return { count: Math.max(a.count, b.count, ids.length), ids, hint: b.hint ?? a.hint };
}

/**
 * Something waiting for Trey that he has not read: mail addressed to him, which the pane has no
 * view of, or a channel message that mentions him. `from` is the sender's name where post says one
 * (`display_name`), else the room it came from; empty for an unreadable file that names none.
 */
export type Waiting =
  | {
      kind: 'mail';
      id: string;
      from: string;
      subject: string;
      /** The first of the body, as the event carries it (post cuts it). */
      preview: string;
      /** When it was sent, as post wrote it. */
      sent: string;
    }
  | { kind: 'mention'; id: string; from: string; channel: string };

/** What `post watch --snapshot` (NDJSON, one event a line) said is waiting, and whether it answered as nobody. */
export function parseWaiting(stdout: string): { waiting: Waiting[]; unbound: boolean } {
  const waiting: Waiting[] = [];
  const seen = new Set<string>();
  let unbound = false;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(e)) continue;
    if (e.event === 'unbound') {
      unbound = true;
      continue;
    }
    const id = str(e.id);
    if (id === undefined || seen.has(id)) continue;
    const from = plainLine(e.display_name) ?? plainLine(e.from) ?? '';
    if (e.event === 'mail' || (e.event === 'unreadable' && e.reason === 'mail')) {
      seen.add(id);
      waiting.push({
        kind: 'mail',
        id,
        from,
        subject: plainLine(e.subject) ?? '',
        preview: plainLine(e.preview) ?? '',
        sent: str(e.sent) ?? '',
      });
    } else if (e.event === 'channel_message' && e.reason === 'mention') {
      const channel = str(e.channel);
      if (channel === undefined) continue;
      seen.add(id);
      waiting.push({ kind: 'mention', id, from, channel });
    }
  }
  return { waiting, unbound };
}

/** Strings a receipt's `warnings` carries: the send landed, and something deserves a second look. */
export function parseWarnings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
}

/**
 * The `post: warning: ...` lines post prints on stderr. A channel send says a body that is pasted
 * `post watch` output there and not in the receipt (installed post, 024ee10), so both are read.
 */
export function stderrWarnings(stderr: string): string[] {
  const prefix = 'post: warning: ';
  return stderr
    .split('\n')
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length).trim())
    .filter((l) => l.length > 0);
}

/**
 * What a channel send's `cross_host` is worth saying under his message: queued for the bridge (it
 * will reach other hosts), or not confirmed (post says do not send it again). `local_only` is
 * what a host with no bridge always says, so it is not news.
 */
export function relayNote(v: unknown): string | undefined {
  if (!isRecord(v)) return undefined;
  const reason = str(v.reason);
  if (v.status === 'queued') return 'Queued for the bridge, to reach other hosts.';
  if (v.status === 'unconfirmed') {
    return `Sent, but the relay to other hosts is not confirmed${reason === undefined ? '' : ` (${reason})`}. Do not send it again.`;
  }
  return undefined;
}

/** One mail read whole, without being consumed (`post read <id> --peek --json`). */
export type MailBody = { id: string; from: string; subject: string; sent: string; body: string };

export function parseMailBody(data: unknown): MailBody | undefined {
  if (!isRecord(data) || data.ok !== true || !isRecord(data.envelope)) return undefined;
  const e = data.envelope;
  const id = str(e.id);
  if (id === undefined || typeof data.body !== 'string') return undefined;
  return {
    id,
    from: plainLine(e.display_name) ?? plainLine(e.from) ?? '',
    subject: plainLine(e.subject) ?? '',
    sent: str(e.sent) ?? '',
    body: plainText(data.body) ?? '',
  };
}
