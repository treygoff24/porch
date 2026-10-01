/**
 * Polls: the conventions and tally rules of porch-tui's standalone `post-poll` script, reading the
 * channel store under the configured mail root (`POST_MAIL_ROOT`) instead of post-poll's hard-coded
 * `~/.claude-mail`.
 *
 * - A poll is one message whose stripped body starts `📊 POLL <pid>: <question>`, followed by option
 *   lines `a) text` … Only polls with at least one option count; a later poll with the same id
 *   replaces the earlier one.
 * - A ballot is a message whose stripped body starts `🗳️ <pid>:`; the choice is the first character
 *   of the lowercased, stripped remainder. Each sender's latest ballot wins (files are read in
 *   sorted name order, which for post's ids is time order). A casual owner line
 *   (`<marker> 🗳️ …`) is not a ballot, exactly as in post-poll.
 * - Reading never touches read cursors: this is a direct store read.
 *
 * Where post-poll would crash on hostile input (a header that is JSON but not an object, a
 * non-string `from` or `sent`, a directory or special file named `*.msg`), this port skips the
 * message instead.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync } from 'node:fs';
import { pyJoin } from '../config/pypath.ts';
import { readBounded, validateChannelName } from './drafts.ts';
import { pyJsonLoads, pySplitlines, pyStrip, pyUniversalNewlines } from './py.ts';

export const POLL_MARK = '📊 POLL ';
export const BALLOT_MARK = '🗳️ ';
export const MAX_POLL_OPTIONS = 8;
/** Larger files are skipped; post's own message cap is far below this. */
export const MAX_MESSAGE_FILE_BYTES = 4 * 1024 * 1024;

export type PollMessage = { readonly from: string; readonly sent: string; readonly body: string };

export type Poll = {
  readonly id: string;
  readonly question: string;
  /** Letter to option text, in first-appearance order. */
  readonly options: ReadonlyMap<string, string>;
  readonly from: string;
  readonly sent: string;
};

/** Python's code-point string order (JS `<` compares UTF-16 units). */
export function pyCompare(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** Parse one `.msg` file's text the way post-poll does; null when post-poll would skip it. */
export function parseMessageText(text: string): PollMessage | null {
  const raw = pyUniversalNewlines(text);
  const sep = raw.indexOf('\n---\n');
  const head = sep === -1 ? raw : raw.slice(0, sep);
  const body = sep === -1 ? '' : raw.slice(sep + 5);
  let meta: unknown;
  try {
    meta = pyJsonLoads(head);
  } catch {
    return null;
  }
  if (!(meta instanceof Map)) return null;
  const from = meta.has('from') ? meta.get('from') : '?';
  const sent = meta.has('sent') ? meta.get('sent') : '';
  if (typeof from !== 'string' || typeof sent !== 'string') return null;
  return { from, sent, body: pyStrip(body) };
}

/** Every message in `<mailRoot>/channels/<channel>/messages/*.msg`, in sorted name order. */
export function loadChannelMessages(mailRoot: string, channel: string): PollMessage[] {
  const dir = pyJoin(mailRoot, 'channels', validateChannelName(channel), 'messages');
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.msg'))
    .sort(pyCompare);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const out: PollMessage[] = [];
  for (const name of names) {
    let fd: number;
    try {
      fd = openSync(
        `${dir}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      continue;
    }
    try {
      if (!fstatSync(fd).isFile()) continue;
      const data = readBounded(fd, MAX_MESSAGE_FILE_BYTES);
      if (data.length > MAX_MESSAGE_FILE_BYTES) continue;
      const msg = parseMessageText(decoder.decode(data));
      if (msg !== null) out.push(msg);
    } catch {
      // An unreadable file is skipped, like a file whose header does not parse.
    } finally {
      closeSync(fd);
    }
  }
  return out;
}

const firstCodePoint = (s: string): string => {
  const it = s[Symbol.iterator]().next();
  return it.done ? '' : it.value;
};

/** post-poll's `find_polls`: poll id to poll, in first-appearance order. */
export function findPolls(msgs: readonly PollMessage[]): Map<string, Poll> {
  const polls = new Map<string, Poll>();
  for (const m of msgs) {
    if (!m.body.startsWith(POLL_MARK)) continue;
    const lines = pySplitlines(m.body);
    const head = (lines[0] as string).slice(POLL_MARK.length);
    const colon = head.indexOf(':');
    if (colon === -1) continue;
    const options = new Map<string, string>();
    for (const rawLine of lines.slice(1)) {
      const line = pyStrip(rawLine);
      const c0 = line.charCodeAt(0);
      if (line.length > 2 && line[1] === ')' && c0 >= 0x61 && c0 <= 0x7a) {
        options.set(line[0] as string, pyStrip(line.slice(2)));
      }
    }
    if (options.size > 0) {
      const id = pyStrip(head.slice(0, colon));
      polls.set(id, {
        id,
        question: pyStrip(head.slice(colon + 1)),
        options,
        from: m.from,
        sent: m.sent,
      });
    }
  }
  return polls;
}

/** post-poll's `find_ballots`: sender to choice letter, the latest ballot winning. */
export function findBallots(msgs: readonly PollMessage[], pollId: string): Map<string, string> {
  const ballots = new Map<string, string>();
  const prefix = `${BALLOT_MARK}${pollId}:`;
  for (const m of msgs) {
    if (!m.body.startsWith(prefix)) continue;
    const choice = firstCodePoint(pyStrip(m.body.slice(prefix.length)).toLowerCase());
    if (choice !== '') ballots.set(m.from, choice);
  }
  return ballots;
}

export type TallyRow = {
  readonly letter: string;
  readonly text: string;
  readonly count: number;
  /** Senders who chose this letter, in Python's sorted order. */
  readonly voters: readonly string[];
  /** True for every option tied for the most votes, when any vote exists. */
  readonly leading: boolean;
};
export type Tally = {
  readonly poll: Poll;
  /** All ballots, including ones for letters the poll does not offer. */
  readonly votes: number;
  readonly rows: readonly TallyRow[];
};

export function tally(poll: Poll, ballots: ReadonlyMap<string, string>): Tally {
  const counts = new Map<string, number>();
  for (const letter of poll.options.keys()) counts.set(letter, 0);
  for (const choice of ballots.values()) {
    const n = counts.get(choice);
    if (n !== undefined) counts.set(choice, n + 1);
  }
  const width = ballots.size > 0 ? Math.max(...counts.values()) : 0;
  const rows = [...poll.options].map(([letter, text]) => {
    const count = counts.get(letter) ?? 0;
    const voters = [...ballots]
      .filter(([, c]) => c === letter)
      .map(([sender]) => sender)
      .sort(pyCompare);
    return {
      letter,
      text,
      count,
      voters,
      leading: ballots.size > 0 && count === width && count > 0,
    };
  });
  return { poll, votes: ballots.size, rows };
}

/** The text `post-poll tally <pid>` prints, line by line. */
export function formatTally(t: Tally): string[] {
  const lines = [`${t.poll.id}: ${t.poll.question}  (${t.votes} votes)`];
  for (const row of t.rows) {
    const bar = '█'.repeat(row.count) + (row.count === 0 ? '▏' : '');
    const who = row.voters.length > 0 ? `  [${row.voters.join(', ')}]` : '';
    lines.push(`  ${row.letter}) ${row.text}: ${row.count} ${bar}${row.leading ? ' ◀' : ''}${who}`);
  }
  return lines;
}

/** The text `post-poll list` prints, line by line. */
export function formatPollList(msgs: readonly PollMessage[], channel: string): string[] {
  const polls = findPolls(msgs);
  if (polls.size === 0) return [`no polls in #${channel}`];
  return [...polls.values()].map((poll) => {
    const n = findBallots(msgs, poll.id).size;
    const sent = [...poll.sent].slice(0, 16).join('');
    return `${poll.id}  ${poll.question}  (${n} votes, by ${poll.from}, ${sent})`;
  });
}

/** A poll id as post-poll mints it: `p%m%d-%H%M%S` in UTC. */
export function newPollId(now: Date = new Date()): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `p${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

export class PollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PollError';
  }
}

/** The body post-poll sends for `new`. */
export function pollBody(pollId: string, question: string, options: readonly string[]): string {
  if (options.length < 2) throw new PollError('a poll needs a question and at least two options');
  if (options.length > MAX_POLL_OPTIONS) throw new PollError(`max ${MAX_POLL_OPTIONS} options`);
  const lines = [`${POLL_MARK}${pollId}: ${question}`];
  options.forEach((text, k) => {
    lines.push(`${'abcdefgh'[k]}) ${text}`);
  });
  lines.push(`vote: post-poll vote ${pollId} <letter>`);
  return lines.join('\n');
}

/**
 * The ballot body post-poll sends, and the only vote form it tallies. porch-next sends it raw (no
 * casual marker prefix), so the owner's votes count.
 */
export function ballotBody(pollId: string, choice: string): string {
  return `${BALLOT_MARK}${pollId}: ${firstCodePoint(choice.toLowerCase())}`;
}

/** post-poll's `vote` checks: the poll exists in this channel and offers the letter. */
export function checkVote(
  polls: ReadonlyMap<string, Poll>,
  pollId: string,
  choice: string,
  channel: string,
): string {
  const letter = firstCodePoint(choice.toLowerCase());
  const poll = polls.get(pollId);
  if (poll === undefined) {
    throw new PollError(`no poll '${pollId}' in #${channel} (post-poll list to see open polls)`);
  }
  if (!poll.options.has(letter)) {
    throw new PollError(
      `'${letter}' is not an option; choices: ${[...poll.options.keys()].join(', ')}`,
    );
  }
  return letter;
}
