/**
 * Decision records: the port of porch-tui's `src/porch3/drstore.py`, over the same
 * `<owner_room_dir>/decision-records.jsonl` with the same append protocol, so porch-tui, its `dr`
 * CLI and porch-next can all write the log at once.
 *
 * - Storage: append-only JSONL, one `json.dumps(event, ensure_ascii=False) + "\n"` per line, written
 *   under an exclusive `flock` on the log file itself. `propose` holds the lock across read,
 *   allocate and append.
 * - Writes, stricter than porch-tui: an event replay would drop is refused before the log is opened
 *   (so a proposal can never vanish and free its id); the log is opened no-follow and non-blocking
 *   through its held directory and must be a regular file this user owns with one link; a partial
 *   last line left by an interrupted writer is repaired under the lock before appending; a failed
 *   write is cut back to the previous length; and the log is fsynced before a write is reported.
 *   Without `/proc/self/fd` (macOS for now) the log is read-only.
 * - Replay: the log is untrusted shared input. Lines that are empty, over 65536 characters, not
 *   JSON, or structurally invalid are dropped, never fatal.
 * - Authority: a `ratified`, `rejected` or `superseded` event counts only when its
 *   `actor_message_id` names an owner message whose verified signed body authorizes exactly that
 *   `(dr, verb)`. Verification is injected ({@link ActionLookup}); this module never trusts the log.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { assertOwnedRegularFile, DirHandle, isCode, WRITES_UNAVAILABLE } from './dirfd.ts';
import { writeAll } from './drafts.ts';
import { type FlockAvailability, loadFlock, lockExclusive } from './flock.ts';
import {
  PY_D,
  PY_S,
  type PyJson,
  type PyJsonObject,
  pyInt,
  pyJsonDumps,
  pyJsonLoads,
  pyLen,
  pySplitlines,
  pyStrip,
  pyUniversalNewlines,
} from './py.ts';

export const EVENT_TYPES = ['proposed', 'ratified', 'rejected', 'superseded'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
/** One log line as decoded: members in file order, unknown members kept. */
export type DrEvent = PyJsonObject;

export const MAX_VERIFY_CALLS = 8;
export const MAX_LINE_CHARS = 65536;
export const BACKOFF_BASE_MS = 120_000;
export const BACKOFF_CAP_MS = 3_600_000;
export const APPEND_LOCK_TIMEOUT_MS = 10_000;

export class DecisionLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionLogError';
  }
}

// Python's `re.match` with `$`: a trailing newline may follow; `\d` is any Unicode decimal digit.
const DR_ID = new RegExp(`^dr-${PY_D}{1,9}\\n?$`, 'u');
const MSG_ID = /^[A-Za-z0-9._-]{1,128}\n?$/;
const CANON_MSG_ID = /^[0-9]{8}-[0-9]{6}-[0-9]{6}-[0-9a-fA-F]{6}\n?$/;

const get = (ev: DrEvent, key: string): PyJson | undefined => ev.get(key);
const str = (v: PyJson | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** porch-tui's `_valid_event`: may this untrusted line take part in replay at all? */
export function validEvent(ev: PyJson): ev is DrEvent {
  if (!(ev instanceof Map)) return false;
  const type = get(ev, 'type');
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) return false;
  const dr = get(ev, 'dr');
  if (typeof dr !== 'string' || !DR_ID.test(dr)) return false;
  const sup = get(ev, 'supersedes');
  if (type === 'superseded' && (typeof sup !== 'string' || !DR_ID.test(sup))) return false;
  for (const key of ['title', 'project', 'channel', 'anchor_message_id', 'actor_message_id']) {
    const v = get(ev, key);
    if (v !== undefined && v !== null && typeof v !== 'string') return false;
  }
  const actor = get(ev, 'actor_message_id');
  return actor === undefined || actor === null || MSG_ID.test(actor as string);
}

/** Replay a log's text: split and strip as Python does, keep only valid events. */
export function parseEvents(text: string): DrEvent[] {
  const events: DrEvent[] = [];
  for (const raw of pySplitlines(text)) {
    const line = pyStrip(raw);
    if (line === '' || pyLen(line) > MAX_LINE_CHARS) continue;
    let ev: PyJson;
    try {
      ev = pyJsonLoads(line);
    } catch {
      continue;
    }
    if (validEvent(ev)) events.push(ev);
  }
  return events;
}

function decodeLog(raw: Uint8Array): string {
  try {
    return pyUniversalNewlines(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw),
    );
  } catch {
    throw new DecisionLogError('the decision log is not valid UTF-8');
  }
}

function readFd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const position = { at: 0 };
  for (;;) {
    const chunk = Buffer.alloc(65536);
    const got = readSync(fd, chunk, 0, chunk.length, position.at);
    if (got === 0) break;
    chunks.push(chunk.subarray(0, got));
    position.at += got;
  }
  return Buffer.concat(chunks);
}

/**
 * Parse the log at `path`. A missing or unreadable file replays as no events, as in porch-tui; a
 * file that is not UTF-8 raises {@link DecisionLogError} (porch-tui raises there too) rather than
 * pretending the log is empty.
 */
export function replay(path: string): DrEvent[] {
  let fd: number;
  try {
    // Non-blocking, so a FIFO planted at the path cannot hang the reader.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return [];
  }
  let raw: Buffer;
  try {
    if (!fstatSync(fd).isFile()) return [];
    raw = readFd(fd);
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
  return parseEvents(decodeLog(raw));
}

/** The smallest unused positive id, never highest+1 (one huge id must not poison allocation). */
export function nextDrId(events: readonly DrEvent[]): string {
  const used = new Set<number>();
  for (const ev of events) {
    const dr = str(get(ev, 'dr')) ?? '';
    if (dr.startsWith('dr-')) {
      const n = pyInt(dr.slice(3));
      if (n !== null) used.add(n);
    }
  }
  let n = 1;
  while (used.has(n)) n++;
  return `dr-${n}`;
}

const pad = (v: number, w = 2) => String(v).padStart(w, '0');
function utcParts(d: Date) {
  return {
    y: pad(d.getUTCFullYear(), 4),
    mo: pad(d.getUTCMonth() + 1),
    da: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()),
    mi: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()),
  };
}
/** `YYYY-MM-DDTHH:MM:SSZ`. */
export function utcCreated(d: Date = new Date()): string {
  const p = utcParts(d);
  return `${p.y}-${p.mo}-${p.da}T${p.h}:${p.mi}:${p.s}Z`;
}
/** `YYYYMMDDTHHMMSSZ-<6 hex>`. */
export function newEventId(d: Date = new Date()): string {
  const p = utcParts(d);
  return `${p.y}${p.mo}${p.da}T${p.h}${p.mi}${p.s}Z-${randomBytes(3).toString('hex')}`;
}

const REQUIRED: Readonly<Record<EventType, readonly string[]>> = {
  proposed: ['dr', 'title', 'project', 'channel', 'anchor_message_id'],
  ratified: ['dr', 'actor_message_id'],
  rejected: ['dr', 'actor_message_id'],
  superseded: ['dr', 'supersedes', 'actor_message_id'],
};

/** Python truthiness for a decoded JSON value (NaN is truthy in Python, as here). */
function truthy(v: PyJson | undefined): boolean {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return true;
}

/**
 * The encoded line, refused unless replay would keep it as exactly this one event. The check runs
 * the event through the same pipeline replay uses (universal newlines, `splitlines`, strip, the
 * length limit, `json.loads`, the event rules), so a raw line separator inside a string (U+2028,
 * U+2029, U+0085, which `ensure_ascii=False` leaves unescaped) or an over-long line is refused here
 * instead of being written and then silently dropped, which would also free its id for reuse. A lone
 * surrogate is refused too: Python's UTF-8 write raises there, where Node would write U+FFFD.
 */
function encodeLine(ev: DrEvent): Buffer {
  const text = pyJsonDumps(ev, false);
  if (!text.isWellFormed()) {
    throw new DecisionLogError('refusing to write text that is not valid Unicode');
  }
  const lines = pySplitlines(pyUniversalNewlines(text));
  if (lines.length !== 1) {
    throw new DecisionLogError(
      'refusing to write a record replay would split: a text field holds a line separator (such as U+2028, U+2029 or U+0085)',
    );
  }
  if (pyLen(pyStrip(lines[0] as string)) > MAX_LINE_CHARS) {
    throw new DecisionLogError(
      `refusing to write a record replay would drop: it is longer than ${MAX_LINE_CHARS} characters`,
    );
  }
  if (parseEvents(text).length !== 1) {
    throw new DecisionLogError('refusing to write a record replay would drop');
  }
  return Buffer.from(`${text}\n`, 'utf8');
}

/** How a partial last line, left by an interrupted writer, was repaired before an append. */
export type TailRepair = {
  /**
   * `terminated`: the fragment was valid UTF-8, so a newline now ends it and replay reads exactly
   * what it read before (a complete event is kept, a fragment is dropped as it already was).
   * `truncated`: the fragment ended inside a UTF-8 character, which made the whole log unreadable;
   * it can only be part of an interrupted line, so it was cut off.
   */
  readonly kind: 'terminated' | 'truncated';
  /** The fragment's length in bytes. */
  readonly bytes: number;
};

export type AppendOptions = {
  flock?: FlockAvailability;
  lockTimeoutMs?: number;
  /** Told when a partial last line was repaired before this append. */
  onRepair?: (repair: TailRepair) => void;
};

type OpenLog = { fd: number; directory: DirHandle; created: boolean };

/**
 * Open the log for reading and appending, locked: through its held directory, no-follow and
 * non-blocking, creating it (and its directory) if needed, and checking after the lock that it is a
 * regular file this user owns with one link. The caller closes both.
 */
async function openLocked(path: string, options: AppendOptions): Promise<OpenLog> {
  const flock = options.flock ?? loadFlock();
  if (!flock.ok) {
    throw new DecisionLogError(`cannot lock the decision log (${flock.reason}); nothing written`);
  }
  if (WRITES_UNAVAILABLE !== null) {
    throw new DecisionLogError(`the decision log is read-only: ${WRITES_UNAVAILABLE}`);
  }
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const name = basename(absolute);
  const directory = DirHandle.walk(dirname(absolute));
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NONBLOCK;
  let fd = -1;
  let created = false;
  try {
    try {
      fd = directory.open(name, flags | constants.O_CREAT | constants.O_EXCL, 0o666);
      created = true;
    } catch (err) {
      if (!isCode(err, 'EEXIST')) throw err;
      fd = directory.open(name, flags);
    }
    await lockExclusive(flock.flocker, fd, {
      timeoutMs: options.lockTimeoutMs ?? APPEND_LOCK_TIMEOUT_MS,
      message: 'another process is holding the decision log',
    });
    assertOwnedRegularFile(fd, 'the decision log');
    return { fd, directory, created };
  } catch (err) {
    if (fd >= 0) closeSync(fd);
    directory.close();
    if (isCode(err, 'ELOOP')) {
      throw new DecisionLogError('the decision log is a symlink; refusing to write through it');
    }
    throw err;
  }
}

/** The offset just past the last `\n` in the first `size` bytes of `fd` (0 when there is none). */
function lineStart(fd: number, size: number): number {
  const chunk = Buffer.alloc(65536);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const got = readSync(fd, chunk, 0, end - start, start);
    const at = chunk.subarray(0, got).lastIndexOf(0x0a);
    if (at !== -1) return start + at + 1;
    end = start;
  }
  return 0;
}

/**
 * Under the lock, make the log end at a line boundary before appending. Returns the bytes to put
 * before the new line and the length a failed append must be cut back to.
 */
function prepareTail(log: OpenLog, options: AppendOptions): { prefix: Buffer; restoreTo: number } {
  const size = fstatSync(log.fd).size;
  const start = lineStart(log.fd, size);
  if (start === size) return { prefix: Buffer.alloc(0), restoreTo: size };
  const fragment = Buffer.alloc(size - start);
  readSync(log.fd, fragment, 0, fragment.length, start);
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fragment);
    options.onRepair?.({ kind: 'terminated', bytes: fragment.length });
    return { prefix: Buffer.from('\n'), restoreTo: size };
  } catch {}
  try {
    // Valid apart from a character cut off at the very end: an interrupted write.
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fragment, { stream: true });
  } catch {
    throw new DecisionLogError(
      'the decision log ends in a partial line that is not valid UTF-8; nothing written',
    );
  }
  ftruncateSync(log.fd, start);
  fsyncSync(log.fd);
  options.onRepair?.({ kind: 'truncated', bytes: fragment.length });
  return { prefix: Buffer.alloc(0), restoreTo: start };
}

/** Append `line` after repairing the tail. */
function appendLine(log: OpenLog, line: Buffer, options: AppendOptions): void {
  const { prefix, restoreTo } = prepareTail(log, options);
  writeAllRestoring(log, prefix.length === 0 ? line : Buffer.concat([prefix, line]), restoreTo);
}

/** Append `data`, cutting the log back to `restoreTo` on failure; fsync before returning. */
function writeAllRestoring(log: OpenLog, data: Buffer, restoreTo: number): void {
  try {
    writeAll(log.fd, data);
    fsyncSync(log.fd);
  } catch (err) {
    try {
      ftruncateSync(log.fd, restoreTo);
      fsyncSync(log.fd);
    } catch (cut) {
      throw new DecisionLogError(
        `writing the decision log failed (${(err as Error).message}), and cutting it back failed too (${(cut as Error).message}): its last line may be partial`,
      );
    }
    throw new DecisionLogError(
      `writing the decision log failed (${(err as Error).message}); it was cut back to its previous length`,
    );
  }
  if (log.created) log.directory.fsync();
}

function closeLog(log: OpenLog): void {
  try {
    closeSync(log.fd); // releases the lock
  } finally {
    log.directory.close();
  }
}

/**
 * porch-tui's `append_event`: check the type and required members, stamp `event_id` and `created`
 * when absent, and append one line under the lock. Unlike porch-tui, a line replay would drop is
 * refused rather than written.
 */
export async function appendEvent(
  input: DrEvent | Readonly<Record<string, PyJson>>,
  path: string,
  options: AppendOptions = {},
): Promise<DrEvent> {
  const ev: DrEvent = input instanceof Map ? new Map(input) : new Map(Object.entries(input));
  const type = get(ev, 'type');
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    throw new DecisionLogError(`unknown event type: ${JSON.stringify(type ?? null)}`);
  }
  for (const key of REQUIRED[type as EventType]) {
    if (!truthy(get(ev, key))) throw new DecisionLogError(`${type} event missing ${key}`);
  }
  if (!ev.has('event_id')) ev.set('event_id', newEventId());
  if (!ev.has('created')) ev.set('created', utcCreated());
  if (!validEvent(ev)) throw new DecisionLogError(`refusing to write an invalid ${type} event`);
  const line = encodeLine(ev);
  const log = await openLocked(path, options);
  try {
    appendLine(log, line, options);
  } finally {
    closeLog(log);
  }
  return ev;
}

/** porch-tui's `propose`: read, allocate the smallest free id, and append, all under one lock. */
export async function propose(
  fields: {
    title: string;
    project: string;
    channel: string;
    anchorMessageId: string;
    detail?: string;
  },
  path: string,
  options: AppendOptions = {},
): Promise<DrEvent> {
  const build = (dr: string): DrEvent =>
    new Map<string, PyJson>([
      ['type', 'proposed'],
      ['dr', dr],
      ['title', fields.title],
      ['project', fields.project],
      ['channel', fields.channel],
      ['anchor_message_id', fields.anchorMessageId],
      ['detail', fields.detail ?? ''],
      ['event_id', newEventId()],
      ['created', utcCreated()],
    ]);
  // Refuse before opening the log, with the longest id allocation can produce standing in.
  encodeLine(build('dr-999999999'));
  const log = await openLocked(path, options);
  try {
    // An interrupted line is repaired first, so allocation reads what replay will read.
    const { prefix, restoreTo } = prepareTail(log, options);
    const size = fstatSync(log.fd).size;
    const raw = size === 0 ? Buffer.alloc(0) : readFd(log.fd);
    const events = parseEvents(decodeLog(raw));
    const ev = build(nextDrId(events));
    if (!validEvent(ev)) {
      throw new DecisionLogError(`refusing to write invalid proposed event: ${get(ev, 'dr')}`);
    }
    const line = encodeLine(ev);
    writeAllRestoring(log, prefix.length === 0 ? line : Buffer.concat([prefix, line]), restoreTo);
    return ev;
  } finally {
    closeLog(log);
  }
}

export function decide(
  dr: string,
  verdict: 'ratified' | 'rejected',
  actorMessageId: string,
  path: string,
  options?: AppendOptions,
): Promise<DrEvent> {
  if (verdict !== 'ratified' && verdict !== 'rejected') {
    return Promise.reject(new DecisionLogError(`unknown verdict: ${String(verdict)}`));
  }
  return appendEvent({ type: verdict, dr, actor_message_id: actorMessageId }, path, options);
}

export function supersede(
  oldDr: string,
  newDr: string,
  actorMessageId: string,
  path: string,
  options?: AppendOptions,
): Promise<DrEvent> {
  return appendEvent(
    { type: 'superseded', dr: newDr, supersedes: oldDr, actor_message_id: actorMessageId },
    path,
    options,
  );
}

/** A parsed owner action: `accepted`, `rejected`, or `superseded` with the replacement id. */
export type ParsedAction = {
  readonly dr: string;
  readonly verb: 'accepted' | 'rejected' | 'superseded';
  readonly replacement: string | null;
};

const V2_ACTION = new RegExp(
  `^⚖️ DR (dr-${PY_D}{1,9}) (accepted|rejected|superseded by (dr-${PY_D}{1,9}))$`,
  'u',
);

/** One exact, undecorated v2 action body (no trailing newline). */
export function parseV2ActionBody(body: string): ParsedAction | null {
  const m = V2_ACTION.exec(body);
  if (m === null) return null;
  const replacement = m[3];
  if (replacement !== undefined) return { dr: m[1] as string, verb: 'superseded', replacement };
  return { dr: m[1] as string, verb: m[2] as 'accepted' | 'rejected', replacement: null };
}

const regexEscape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

/** A legacy v1 signed action body: `<marker>🔏 ⚖️ DR dr-N <verb> [signed:<tag>]`. */
export function parseActionBody(body: string, marker: string): ParsedAction | null {
  const pattern = new RegExp(
    `^${regexEscape(`${marker}🔏 `)}⚖️ DR (dr-${PY_D}{1,9}) ` +
      `(accepted|rejected|superseded by dr-${PY_D}{1,9})${PY_S}*\\[signed:[^\\]]{1,64}\\]${PY_S}*$`,
    'u',
  );
  const m = pattern.exec(body);
  if (m === null) return null;
  const dr = m[1] as string;
  const tail = m[2] as string;
  if (tail.startsWith('superseded by ')) {
    return { dr, verb: 'superseded', replacement: tail.slice('superseded by '.length) };
  }
  return { dr, verb: tail as 'accepted' | 'rejected', replacement: null };
}

/** Recognize a live owner action in a message (display only; never durable authority). */
export function parseObservedAction(
  msg: { from: string; body: string; signatureRefPresent: boolean },
  ownerRoom: string,
  marker: string,
): ParsedAction | null {
  if (msg.from !== ownerRoom) return null;
  return msg.signatureRefPresent ? parseV2ActionBody(msg.body) : parseActionBody(msg.body, marker);
}

export function hasActorEvent(events: readonly DrEvent[], actorMessageId: string): boolean {
  return events.some((ev) => get(ev, 'actor_message_id') === actorMessageId);
}

/**
 * What verifying one message found. `verified` carries the complete raw body; `failed` is a
 * cryptographic, manifest or binding mismatch (terminal); `unknown` is a missing, duplicated or
 * unreadable message or an environment failure (retried with backoff, never cached as failed).
 */
export type ActionVerdict =
  | {
      readonly kind: 'verified';
      readonly body: Uint8Array;
      readonly signatureRefPresent: boolean;
      readonly from: string | null;
    }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unknown' };
export type ActionLookup = (messageId: string) => Promise<ActionVerdict>;

const VERB_FOR_TYPE: Readonly<Record<string, ParsedAction['verb']>> = {
  ratified: 'accepted',
  rejected: 'rejected',
  superseded: 'superseded',
};

/** What is known about an actor message without looking it up. */
export type ActionKnowledge =
  | { readonly kind: 'known'; readonly action: ParsedAction | null }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'lookup' };

/**
 * The authority check for one trust context (one owner room, marker and verifier). Holds porch-tui's
 * memo of authentic actions and its retry backoff, and when each actor id was last looked up, which
 * {@link project} uses to share its lookup budget fairly.
 */
export class DecisionAuthority {
  private readonly memo = new Map<string, ParsedAction | null>();
  private readonly backoff = new Map<string, { strikes: number; until: number }>();
  private readonly tried = new Map<string, number>();
  private ticks = 0;
  private readonly lookup: ActionLookup;
  private readonly ownerRoom: string;
  private readonly marker: string;
  private readonly now: () => number;

  constructor(options: {
    lookup: ActionLookup;
    ownerRoom: string;
    marker: string;
    now?: () => number;
  }) {
    this.lookup = options.lookup;
    this.ownerRoom = options.ownerRoom;
    this.marker = options.marker;
    this.now = options.now ?? (() => performance.now());
  }

  private openBackoff(mid: string): void {
    const prior = this.backoff.get(mid);
    const strikes = (prior?.strikes ?? 0) + 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(strikes - 1, 30), BACKOFF_CAP_MS);
    this.backoff.set(mid, { strikes, until: this.now() + delay });
  }

  /** The memoized action of `mid`, a backoff wait, or the need for a lookup; never looks up. */
  peek(mid: string): ActionKnowledge {
    if (this.memo.has(mid)) return { kind: 'known', action: this.memo.get(mid) ?? null };
    if (!CANON_MSG_ID.test(mid)) return { kind: 'known', action: null };
    const wait = this.backoff.get(mid);
    if (wait !== undefined && this.now() < wait.until) return { kind: 'waiting' };
    return { kind: 'lookup' };
  }

  /** When `mid` was last looked up, as a sequence number; -1 when never. */
  lastTried(mid: string): number {
    return this.tried.get(mid) ?? -1;
  }

  /**
   * The parsed action of message `mid`, only if its body carries a genuine owner signature. Looks
   * the message up unless the answer is memoized or `mid` is waiting out a backoff.
   */
  async authenticAction(mid: string): Promise<ParsedAction | null> {
    const known = this.peek(mid);
    if (known.kind === 'known') return known.action;
    if (known.kind === 'waiting') return null;
    this.tried.set(mid, this.ticks++);
    let verdict: ActionVerdict;
    try {
      verdict = await this.lookup(mid);
    } catch {
      verdict = { kind: 'unknown' };
    }
    if (verdict.kind === 'unknown') {
      this.openBackoff(mid);
      return null;
    }
    let result: ParsedAction | null = null;
    if (verdict.kind === 'verified') {
      let body: string | null;
      try {
        body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(verdict.body);
      } catch {
        body = null;
      }
      if (body !== null) {
        if (verdict.signatureRefPresent && verdict.from === this.ownerRoom) {
          result = parseV2ActionBody(body);
        } else {
          const one = body.endsWith('\n') ? body.slice(0, -1) : body;
          if (!one.includes('\r') && !one.includes('\n'))
            result = parseActionBody(one, this.marker);
        }
      }
    }
    this.backoff.delete(mid);
    this.memo.set(mid, result);
    return result;
  }

  /** Is `ev` authorized by a signed owner action bound to its exact `(dr, verb)`? */
  async authorize(ev: DrEvent): Promise<boolean> {
    const mid = get(ev, 'actor_message_id');
    if (!truthy(mid) || typeof mid !== 'string') return false;
    return binds(ev, await this.authenticAction(mid));
  }
}

/** Does the authentic action `parsed` authorize exactly this event's `(dr, verb)`? */
function binds(ev: DrEvent, parsed: ParsedAction | null): boolean {
  const type = str(get(ev, 'type')) ?? '';
  const verb = VERB_FOR_TYPE[type];
  if (parsed === null || verb === undefined || parsed.verb !== verb) return false;
  if (type === 'superseded') {
    return parsed.dr === get(ev, 'supersedes') && parsed.replacement === get(ev, 'dr');
  }
  return parsed.dr === get(ev, 'dr');
}

export type DrState = 'needs_operator_decision' | 'ratified' | 'rejected' | 'superseded';

export type DrRecord = {
  dr: string;
  title: PyJson;
  project: PyJson;
  channel: PyJson;
  anchorMessageId: PyJson;
  detail: PyJson;
  state: DrState;
  created: PyJson;
  history: { event: DrEvent; ignored?: string }[];
  actorMessageId?: string;
  supersededBy?: string;
};

const member = (ev: DrEvent, key: string): PyJson => (ev.has(key) ? (ev.get(key) as PyJson) : '');

/**
 * Fold events into records keyed by id, in first-proposal order. Decisions count only when
 * `authority` vouches for them.
 *
 * A projection makes at most {@link MAX_VERIFY_CALLS} lookups, retries included; memo hits and ids
 * waiting out a backoff cost nothing. (porch-tui charges each actor id once per process, so after a
 * backoff expires its retries are free and one projection can make any number of lookups.) Lookups
 * go one at a time to the decision that has waited longest: ids never looked up first, in log
 * order, then the least recently tried, so a long log is worked through across projections instead
 * of retrying its first few ids forever. After each lookup the log is folded again, so only
 * decisions that can still take effect (the cheap state gates run first) ever ask for one.
 */
export async function project(
  events: readonly DrEvent[],
  authority: DecisionAuthority,
): Promise<Map<string, DrRecord>> {
  let budget = MAX_VERIFY_CALLS;
  for (;;) {
    const wanted = new Set<string>(); // insertion order is log order
    const records = fold(events, (ev) => {
      const mid = get(ev, 'actor_message_id');
      if (!truthy(mid) || typeof mid !== 'string') return false;
      const known = authority.peek(mid);
      if (known.kind === 'known') return binds(ev, known.action);
      if (known.kind === 'lookup') wanted.add(mid);
      return false;
    });
    if (budget === 0 || wanted.size === 0) return records;
    let next: string | null = null;
    for (const mid of wanted) {
      if (next === null || authority.lastTried(mid) < authority.lastTried(next)) next = mid;
    }
    if (next === null) return records;
    budget -= 1;
    await authority.authenticAction(next);
  }
}

/** One pass over the log; `ok` says, without any lookup, whether a decision is authorized. */
function fold(events: readonly DrEvent[], ok: (ev: DrEvent) => boolean): Map<string, DrRecord> {
  const records = new Map<string, DrRecord>();
  for (const ev of events) {
    const dr = str(get(ev, 'dr')) ?? '';
    const type = get(ev, 'type') as EventType;
    if (type === 'proposed') {
      if (!records.has(dr)) {
        records.set(dr, {
          dr,
          title: member(ev, 'title'),
          project: member(ev, 'project'),
          channel: member(ev, 'channel'),
          anchorMessageId: member(ev, 'anchor_message_id'),
          detail: member(ev, 'detail'),
          state: 'needs_operator_decision',
          created: member(ev, 'created'),
          history: [],
        });
      }
      continue;
    }
    const record = records.get(dr);
    if (record === undefined) continue;
    if (type === 'ratified' || type === 'rejected') {
      if (record.state !== 'needs_operator_decision') continue;
      if (!ok(ev)) {
        record.history.push({ event: ev, ignored: 'actor message unverified' });
        continue;
      }
      record.state = type;
      record.actorMessageId = get(ev, 'actor_message_id') as string;
    } else {
      const old = records.get(str(get(ev, 'supersedes')) ?? '');
      // Only an in-force decision may be replaced, by an in-force replacement; this is also what
      // rules out cycles. The cheap state gate runs before any verification is spent.
      if (
        old === undefined ||
        old === record ||
        old.state !== 'ratified' ||
        record.state !== 'ratified'
      ) {
        record.history.push({ event: ev, ignored: 'invalid supersede transition' });
        continue;
      }
      if (!ok(ev)) {
        record.history.push({ event: ev, ignored: 'actor message unverified' });
        continue;
      }
      old.state = 'superseded';
      old.supersededBy = dr;
    }
    record.history.push({ event: ev });
  }
  return records;
}

export function badgeFor(state: string, label = 'owner'): string {
  switch (state) {
    case 'needs_operator_decision':
      return ` ⚖️DR·needs ${label}`;
    case 'ratified':
      return ' ⚖️DR·ratified';
    case 'rejected':
      return ' ⚖️DR·rejected';
    case 'superseded':
      return ' ⚖️DR·superseded';
    default:
      return '';
  }
}

/** Python's `str()` for a record's title or project, which replay guarantees is a string or null. */
function pyStr(v: PyJson): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'None';
  return String(v);
}

export function offerLine(
  record: { dr: string; title: PyJson; project: PyJson },
  label = 'owner',
): string {
  return (
    `⚖️ DR ${record.dr} needs ${label} — "${pyStr(record.title)}" ` +
    `(project: ${pyStr(record.project)}) · /accept ${record.dr} · /reject ${record.dr}`
  );
}
