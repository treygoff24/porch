/** Owner-bound CLI client, ported from Loom; reads never move cursors and word sends use SendTransaction. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  type ClientConfig,
  crossCheck,
  type OwnerIdentity,
  ownerEnv,
  porchConfigPath,
  readConfig,
  withoutCredentials,
} from './owner.ts';
import { isRecord, parseMessages, parseRaw, type RawRecord } from './records.ts';
import { SendRecord } from './recovery.ts';
import {
  decodeJson,
  type Failure,
  fail,
  interpret,
  type Outcome,
  ok,
  type Result,
  runProcess,
} from './run.ts';
import {
  classifySend,
  type Recovery,
  type SendOutcome,
  type SendRequest,
  SendTransaction,
} from './send.ts';
import type { PrivateAgent, Runner } from './signing.ts';
import type { DraftSpace } from './stores/drafts.ts';
import {
  type ChannelSummary,
  type MailBody,
  type Profile,
  parseChannels,
  parseChatSkipped,
  parseMailBody,
  parseProfiles,
  parseRoster,
  parseSkippedList,
  parseWaiting,
  parseWho,
  type RosterEntry,
  type Skipped,
  type SkippedItem,
  type Waiting,
  type WhoRow,
} from './wire.ts';
export type Presence = { who: WhoRow[]; profiles: Map<string, Profile>; skipped: SkippedItem[] };
export type PostClientOptions = {
  /** `post` binary. Tests pass a stub; the default is `post` on PATH. */
  executable?: string;
  config?: ClientConfig;
  loadConfig?: (path: string, home?: string) => ClientConfig | Promise<ClientConfig>;
  recovery?: Recovery;
  /**
   * The drafts space the app's drafts store uses. Send recovery records go through the same space,
   * so a send queues behind a drafts save in this process instead of contending for the lock with a
   * second space of its own (which fails after the 3 s lock timeout). The app always passes it;
   * without it the client builds a space of its own from the config.
   */
  space?: DraftSpace;
  agent?: PrivateAgent;
  /** The environment calls inherit (minus any agent identity). Default: this process's. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Porch's config file. Default: `$PORCH_CONFIG`, else `~/.config/porch/config.toml`. */
  configPath?: string;
  /** For tests: replaces spawning (`post`, `ssh-add`, `ssh-keygen`). */
  run?: Runner;
  home?: string;
  /**
   * Aborting stops every read this client has running (its `post` process is signalled through
   * the runner). Writes (`bind`, mark read, join, send) are never aborted: stopping one halfway
   * would leave a send's outcome unknown, and each is short and bounded by its own timeout.
   */
  signal?: AbortSignal;
};

/** A call that only reads: it may be stopped by the client's signal and by its own. */
export type ReadOptions = { signal?: AbortSignal };

const TIMEOUT_MS = 10_000;

/**
 * What one look at what is waiting asks post for at most (`watch --snapshot --limit`). Post says
 * nothing about events it left out, so a look that came back with this many may have missed more.
 */
export const WAITING_LIMIT = 50;

/** One path-safe component that cannot be read as a flag (a channel name, a message id). */
function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\]/.test(name) &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
    !/[\u0000-\u001f\u007f-\u009f]/.test(name)
  );
}

/** A chat read: the messages, and what post says it left out. */
export type Page = { messages: RawRecord[]; skipped: Skipped | undefined };

/** The channel list, and what post says it left out. */
export type Listing = { channels: ChannelSummary[]; skipped: SkippedItem[] };

export class OwnerPost {
  private constructor(
    readonly owner: OwnerIdentity,
    private readonly cfg: ClientConfig,
    private readonly opts: PostClientOptions,
  ) {
    this.transaction = new SendTransaction({
      owner,
      recovery: opts.recovery ?? new SendRecord(opts.space ?? cfg),
      post: (args, input) => this.post(args, input === undefined ? {} : { input }),
      ...(opts.agent === undefined ? {} : { agent: opts.agent }),
    });
  }
  readonly transaction: SendTransaction;

  private get exe(): string {
    return this.opts.executable ?? 'post';
  }

  /** What every child starts from (signing's ssh-add and ssh-keygen as well as post). */
  private get base(): NodeJS.ProcessEnv {
    return withoutCredentials(this.opts.env ?? process.env);
  }

  private async post(
    args: string[],
    extra: {
      input?: string;
      participant?: string | null;
      signal?: AbortSignal | undefined;
      retried?: boolean;
      /** A read: stopped when the cockpit leaves (see `RunSpec.stopOnExit`); a write is not. */
      stopOnExit?: boolean;
    } = {},
  ): Promise<Outcome> {
    const participant =
      extra.participant === null ? undefined : (extra.participant ?? this.owner.participant);
    const run = this.opts.run ?? runProcess;
    const out = await run(this.exe, {
      args,
      cwd: this.cfg.ownerRoomDir,
      env: ownerEnv(this.base, this.cfg, participant),
      ...(extra.input === undefined ? {} : { input: extra.input }),
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
      ...(extra.stopOnExit === true ? { stopOnExit: true } : {}),
      timeoutMs: this.opts.timeoutMs ?? TIMEOUT_MS,
    });
    // post no longer knows the id he acts as (its record was collected, or the store was
    // reset): bind him again, which restores it under the same id, and ask once more. A call
    // that failed this way did nothing, a send included, so asking again cannot double it.
    if (extra.retried !== true && participant !== undefined && lostParticipant(out)) {
      if (await this.rebind()) return this.post(args, { ...extra, retried: true });
    }
    return out;
  }

  private rebinding: Promise<boolean> | undefined;

  /**
   * Bind Trey's participant again, the way `connect` did: the key is fixed, so post gives back the
   * same `porch-<hex>` (restoring a record it collected). True only when it is the id this client
   * acts as; one bind at a time, however many calls found the id missing together.
   */
  private rebind(): Promise<boolean> {
    this.rebinding ??= (async () => {
      const run = this.opts.run ?? runProcess;
      const out = await run(this.exe, {
        args: bindArgs(this.cfg.ownerRoom),
        cwd: this.cfg.ownerRoomDir,
        env: ownerEnv(this.base, this.cfg, undefined),
        timeoutMs: this.opts.timeoutMs ?? TIMEOUT_MS,
      });
      const bound = interpret(out, 'participant bind');
      return bound.ok && readBinding(bound.value, this.cfg.ownerRoom) === this.owner.participant;
    })().finally(() => {
      this.rebinding = undefined;
    });
    return this.rebinding;
  }

  /** A read: stopped by the client's signal, and by the caller's when it gives one. */
  private read(args: string[], opts: ReadOptions | undefined): Promise<Outcome> {
    const signals = [this.opts.signal, opts?.signal].filter(
      (x): x is AbortSignal => x !== undefined,
    );
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);
    return this.post(args, { signal, stopOnExit: true });
  }

  /**
   * Identify Trey to post the way porch does at start: check the acting room, cross-check the
   * owner, bind his participant. Any failure is an answer the pane can show.
   */
  static async connect(opts: PostClientOptions = {}): Promise<Result<OwnerPost>> {
    const env = opts.env ?? process.env;
    const home = opts.home ?? homedir();
    let cfg: ClientConfig;
    try {
      cfg =
        opts.config ??
        (await (opts.loadConfig ?? readConfig)(
          opts.configPath ?? porchConfigPath(env, home),
          home,
        ));
    } catch (e) {
      return fail({ code: 'no_owner_config', message: (e as Error).message, retryable: false });
    }
    // An environment that names a different post store than porch's config means someone pointed
    // this process elsewhere on purpose (a test, a probe). The pane would act as Trey in porch's
    // store while everything around it looks at the other one, so refuse instead of touching
    // either. `cfg.mailRoot` is porch's own answer (its config, else `~/.claude-mail`), never
    // copied from this environment, so the comparison can always fail.
    const pinned = env.POST_MAIL_ROOT;
    if (pinned !== undefined && pinned.length > 0 && resolve(pinned) !== resolve(cfg.mailRoot)) {
      return fail({
        code: 'mail_root_mismatch',
        message: `This process is pointed at another post store (${pinned}) than porch's (${cfg.mailRoot}); the post pane will not act as Trey in either.`,
        retryable: false,
      });
    }
    const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    const run = opts.run ?? runProcess;
    // Only the reads may be stopped by the caller's signal; the bind is a write.
    const call = async (args: string[], participant?: string, abortable = true) =>
      run(opts.executable ?? 'post', {
        args,
        cwd: cfg.ownerRoomDir,
        env: ownerEnv(env, cfg, participant),
        timeoutMs,
        ...(abortable && opts.signal !== undefined ? { signal: opts.signal } : {}),
      });

    // The owner post knows, against porch's own file.
    const shown = interpret(await call(['owner', 'show', '--json']), 'owner show');
    if (!shown.ok) return shown;
    const blocked = crossCheck(cfg, shown.value);
    if (blocked.kind === 'stop') {
      return fail({ code: 'owner_mismatch', message: blocked.reason, retryable: false });
    }

    // Trey's participant: a fixed key, so it is the same one on every launch.
    const bound = interpret(
      await call(bindArgs(cfg.ownerRoom), undefined, false),
      'participant bind',
    );
    if (!bound.ok) return bound;
    const participant = readBinding(bound.value, cfg.ownerRoom);
    if (participant === undefined) {
      return fail({
        code: 'bad_binding',
        message: 'post bound a participant for Trey that does not look like porch’s; not using it.',
        retryable: false,
      });
    }

    // The invariant porch holds before it reads or sends: the acting room is the owner's room.
    const acting = interpret(
      await call(['profile', 'show', '--json'], participant),
      'profile show',
    );
    if (!acting.ok) return acting;
    if (acting.value.room !== cfg.ownerRoom) {
      return fail({
        code: 'acting_room_mismatch',
        message: `post would act as room ${String(acting.value.room)}, not ${cfg.ownerRoom}; not reading or sending.`,
        retryable: false,
      });
    }

    const owner: OwnerIdentity = {
      ...cfg,
      participant,
      signingBlocked: blocked.kind === 'unsigned' ? blocked.reason : undefined,
    };
    return ok(new OwnerPost(owner, cfg, opts));
  }

  /**
   * Whether a send now would be signed: a signing agent is armed and post agrees with porch's
   * config. Only a hint for the input's placeholder; `send` looks again at the moment it sends.
   */
  async signing(): Promise<'signed' | 'unsigned'> {
    return this.owner.signingBlocked === undefined && this.opts.agent?.armed
      ? 'signed'
      : 'unsigned';
  }

  /** Every channel, live and archived (`archived` marks which), with Trey's unread counts. */
  async channels(opts?: ReadOptions): Promise<Result<ChannelSummary[]>> {
    const r = await this.listChannels(opts);
    return r.ok ? ok(r.value.channels) : r;
  }

  /** The same, and the files post left out of the listing (post 7286de3 and later). */
  async listChannels(opts?: ReadOptions): Promise<Result<Listing>> {
    const r = interpret(await this.read(['channels', '--all', '--json'], opts), 'channels');
    if (!r.ok) return r;
    const lost = unbound(r.value);
    if (lost !== undefined) return lost;
    const parsed = parseChannels(r.value);
    return parsed === undefined
      ? badShape('channels')
      : ok({ channels: parsed, skipped: parseSkippedList(r.value.skipped) });
  }

  /**
   * What is waiting for Trey and unread: mail addressed to him and channel messages that mention
   * him, from `post watch --snapshot`, which lists once and consumes nothing. `--own` says his
   * own messages are not news to him. An empty scan prints nothing, which is an empty list; an
   * answer as nobody (`unbound`) is not that, it is a failure to say so.
   */
  async waiting(opts?: ReadOptions): Promise<Result<Waiting[]>> {
    const out = await this.read(
      [
        'watch',
        '--snapshot',
        '--json',
        '--reason',
        'mail',
        '--reason',
        'mention',
        '--own',
        this.owner.ownerRoom,
        '--limit',
        String(WAITING_LIMIT),
      ],
      opts,
    );
    if (out.failed === undefined && out.code === 0) {
      const seen = parseWaiting(out.stdout);
      return seen.unbound
        ? fail({
            code: 'unbound',
            message: 'post says no participant is bound here, so nothing can be read as Trey.',
            retryable: true,
          })
        : ok(seen.waiting);
    }
    const r = interpret(out, 'watch --snapshot');
    return r.ok ? ok([]) : r;
  }

  /**
   * One mail addressed to Trey, read whole and not consumed (`--peek`): it stays unread in post
   * until he reads it there. The id comes from `waiting()`.
   */
  async peekMail(id: string, opts?: ReadOptions): Promise<Result<MailBody>> {
    if (!safeName(id)) return badName(id);
    const r = interpret(await this.read(['read', id, '--peek', '--json'], opts), 'read');
    if (!r.ok) return r;
    const lost = unbound(r.value);
    if (lost !== undefined) return lost;
    const parsed = parseMailBody(r.value);
    return parsed === undefined ? badShape('read') : ok(parsed);
  }

  /** Who is in post, with names, for `active now` and the members line. */
  async presence(opts?: ReadOptions): Promise<Result<Presence>> {
    const [who, profiles] = await Promise.all([
      this.read(['who', '--json'], opts),
      this.read(['profile', 'list', '--json'], opts),
    ]);
    const w = interpret(who, 'who');
    if (!w.ok) return w;
    const rows = parseWho(w.value);
    if (rows === undefined) return badShape('who');
    // Names are a nicety: a failed profile list still gives the members, by room.
    const p = interpret(profiles, 'profile list');
    const names = p.ok
      ? (parseProfiles(p.value) ?? new Map<string, Profile>())
      : new Map<string, Profile>();
    return ok({ who: rows, profiles: names, skipped: parseSkippedList(w.value.skipped) });
  }

  /** Where each participant works and what identity it took, from post's participant records. */
  async roster(opts?: ReadOptions): Promise<Result<Map<string, RosterEntry>>> {
    const r = interpret(await this.read(['participant', 'list', '--json'], opts), 'roster');
    if (!r.ok) return r;
    const parsed = parseRoster(r.value);
    return parsed === undefined ? badShape('roster') : ok(parsed);
  }

  /** The last `limit` messages, oldest first, whatever their read state. Moves no cursor. */
  async history(channel: string, limit: number, opts?: ReadOptions): Promise<Result<RawRecord[]>> {
    const r = await this.historyPage(channel, limit, opts);
    return r.ok ? ok(r.value.messages) : r;
  }

  /** The same, and the message files post could not read and left out of it. */
  async historyPage(channel: string, limit: number, opts?: ReadOptions): Promise<Result<Page>> {
    if (!safeName(channel)) return badName(channel);
    return this.page(
      await this.read(['chat', channel, '--history', String(limit), '--json'], opts),
      `history of #${channel}`,
      channel,
    );
  }

  /** Messages after `id`, oldest first. Moves no cursor. */
  async since(channel: string, id: string, opts?: ReadOptions): Promise<Result<RawRecord[]>> {
    const r = await this.sincePage(channel, id, opts);
    return r.ok ? ok(r.value.messages) : r;
  }

  /** The same, and the message files post could not read and left out of it. */
  async sincePage(channel: string, id: string, opts?: ReadOptions): Promise<Result<Page>> {
    if (!safeName(channel)) return badName(channel);
    if (!safeName(id)) return badName(id);
    return this.page(
      await this.read(['chat', channel, '--since', id, '--json'], opts),
      `new messages in #${channel}`,
      channel,
    );
  }

  private page(out: Outcome, what: string, channel: string): Result<Page> {
    const r = interpret(out, what);
    if (!r.ok) return r;
    const lost = unbound(r.value);
    if (lost !== undefined) return lost;
    const messages = parseMessages(r.value, channel);
    return messages === undefined
      ? badShape(what)
      : ok({ messages, skipped: parseChatSkipped(r.value) });
  }

  /**
   * Mark everything at or before `through` read, for Trey. Idempotent; `advanced` says whether
   * his cursor moved. Runs as the owner and only as the owner.
   */
  async markRead(channel: string, through: string): Promise<Result<{ advanced: boolean }>> {
    if (!safeName(channel)) return badName(channel);
    if (!safeName(through)) return badName(through);
    const r = interpret(
      await this.post(['chat', channel, '--discard-through', through, '--json']),
      `mark #${channel} read`,
    );
    if (!r.ok) return r;
    return ok({ advanced: r.value.advanced === true });
  }

  /** Join `channel` as Trey. History before the join stays history; unread starts now. */
  async join(channel: string): Promise<Result<void>> {
    if (!safeName(channel)) return badName(channel);
    const r = interpret(await this.post(['chat', channel, '--join', '--json']), `join #${channel}`);
    return r.ok ? ok(undefined) : r;
  }

  /** All word-sending features must use this transaction; casual is always the default. */
  send(
    channel: string,
    text: string,
    opts: {
      replyTo?: string;
      mode?: 'casual' | 'signed';
      draftRevision?: number;
      expect?: 'signed' | 'unsigned';
    } = {},
  ): Promise<SendOutcome> {
    const request: SendRequest = {
      channel,
      body: text,
      mode: opts.mode ?? (opts.expect === 'signed' ? 'signed' : 'casual'),
      draftRevision: opts.draftRevision ?? 0,
      ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
    };
    return this.transaction.send(request);
  }
  async message(channel: string, id: string, opts?: ReadOptions): Promise<Result<RawRecord>> {
    if (!safeName(channel) || !safeName(id)) return badName(channel);
    const args = ['chat', channel, '--message', id, '--max-bytes', '1048576', '--json'];
    const first = interpret(await this.read(args, opts), 'message');
    if (!first.ok) return first;
    const records = parseMessages(first.value, channel);
    const raw = records?.[0];
    if (raw === undefined || records?.length !== 1) return badShape('message');
    if (raw.bodyComplete || raw.file === 'emote') return ok(raw);
    // --max-bytes budgets JSON too. At the signed-body cap, collect subsequent UTF-8 slices.
    const total = first.value.total_body_bytes;
    if (
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total > 1048576 ||
      total < 0 ||
      !isRecord(first.value.range) ||
      first.value.range.start !== 0
    )
      return ok(raw);
    let body = raw.body;
    let offset = Buffer.byteLength(body);
    if (offset !== first.value.range.end_exclusive || offset === 0) return ok(raw);
    while (offset < total) {
      const next = interpret(
        await this.read([...args, '--offset', String(offset)], opts),
        'message continuation',
      );
      if (!next.ok) return next;
      if (
        !isRecord(next.value.message) ||
        JSON.stringify(next.value.message) !== JSON.stringify(first.value.message) ||
        next.value.total_body_bytes !== total ||
        !isRecord(next.value.range) ||
        next.value.range.start !== offset ||
        typeof next.value.body_slice !== 'string'
      )
        return badShape('message continuation');
      const bytes = Buffer.byteLength(next.value.body_slice);
      if (
        bytes === 0 ||
        next.value.range.end_exclusive !== offset + bytes ||
        offset + bytes > total
      )
        return badShape('message continuation');
      body += next.value.body_slice;
      offset += bytes;
    }
    const complete = parseRaw(raw.envelope, channel, { body, bodyComplete: true });
    return complete === undefined ? badShape('complete message') : ok(complete);
  }
  async seenBy(channel: string, id: string, opts?: ReadOptions): Promise<Result<string[]>> {
    if (!safeName(channel) || !safeName(id)) return badName(channel);
    const r = interpret(
      await this.read(['chat', channel, '--seen-by', id, '--json'], opts),
      'seen-by',
    );
    if (!r.ok) return r;
    return Array.isArray(r.value.seen_by) && r.value.seen_by.every((x) => typeof x === 'string')
      ? ok(r.value.seen_by as string[])
      : badShape('seen-by');
  }
  /**
   * Post's own search of one channel (`post search`): a literal, case-insensitive substring of a
   * message's body, sender room or id, newest first, at most `limit` hits (post's hard cap is
   * 1000). `truncated` says post found more than it returned. Hits carry a one-line preview, not
   * the body; nothing here verifies who sent them. A read: moves no cursor, and stops when asked.
   */
  async search(
    channel: string,
    pattern: string,
    opts: ReadOptions & { limit?: number } = {},
  ): Promise<Result<SearchPage>> {
    if (!safeName(channel)) return badName(channel);
    const limit = opts.limit ?? SEARCH_LIMIT;
    if (
      pattern.length === 0 ||
      pattern.length > 1024 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
      /[\u0000-\u001f\u007f-\u009f]/.test(pattern) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > SEARCH_LIMIT
    )
      return badName(pattern);
    const r = interpret(
      await this.read(
        // `--` so a pattern that starts with a dash is the pattern, not a flag.
        ['search', '--channel', channel, '--limit', String(limit), '--json', '--', pattern],
        opts,
      ),
      `search #${channel}`,
    );
    if (!r.ok) return r;
    const page = parseSearch(r.value, channel, limit);
    return page === undefined ? badShape('search') : ok(page);
  }
  async avatars(opts?: ReadOptions): Promise<Result<Map<string, unknown>>> {
    const r = interpret(
      await this.read(['profile', 'list', '--avatars', '--json'], opts),
      'avatars',
    );
    if (!r.ok) return r;
    if (!Array.isArray(r.value.profiles)) return badShape('avatars');
    return ok(
      new Map(
        r.value.profiles
          .filter(isRecord)
          .filter((p) => typeof p.participant === 'string')
          .map((p) => [p.participant as string, p.avatar ?? null]),
      ),
    );
  }
  async setAvatar(avatar: unknown): Promise<Result<void>> {
    const r = interpret(
      await this.post(['profile', 'avatar', 'set', '--file', '-', '--json'], {
        input: JSON.stringify(avatar),
      }),
      'set avatar',
    );
    return r.ok ? ok(undefined) : r;
  }
  async emote(channel: string, name: string, at?: string): Promise<SendOutcome> {
    if (!safeName(channel) || !safeName(name) || (at !== undefined && !safeName(at)))
      return { kind: 'refused', code: 'invalid_argument', message: 'invalid emote argument' };
    const args = ['chat', channel, '--emote', name, '--json'];
    if (at !== undefined) args.push('--at', at);
    return classifySend(await this.post(args), channel, this.owner.ownerRoom, '', true);
  }
  async archive(channel: string): Promise<Result<void>> {
    return this.archiveAction(channel, '--archive');
  }
  async unarchive(channel: string): Promise<Result<void>> {
    return this.archiveAction(channel, '--unarchive');
  }
  private async archiveAction(channel: string, action: string): Promise<Result<void>> {
    if (!safeName(channel)) return badName(channel);
    const r = interpret(await this.post(['chat', channel, action, '--json']), 'archive');
    return r.ok ? ok(undefined) : r;
  }
}

export type AvatarFileOptions = {
  /** The `post` to run. Default: `post` on the path. */
  executable?: string;
  /** The environment the call inherits (minus credentials); post's identity comes from it. */
  env?: NodeJS.ProcessEnv;
  /** For tests: replaces spawning. */
  run?: Runner;
  timeoutMs?: number;
};

/** An avatar written to a file takes a little longer than a pane call; the CLI always allowed this. */
const AVATAR_FILE_TIMEOUT_MS = 30_000;

/**
 * `post profile avatar set --file <path> --json` for `porch-next avatar set`, which acts as
 * whichever participant its environment names (no owner room, no bind). Like every write it is a
 * `post` call run here, not from the app; the raw outcome is returned for the caller to word.
 */
export function setAvatarFile(file: string, opts: AvatarFileOptions = {}): Promise<Outcome> {
  const run = opts.run ?? runProcess;
  return run(opts.executable ?? 'post', {
    args: ['profile', 'avatar', 'set', '--file', file, '--json'],
    env: withoutCredentials(opts.env ?? process.env),
    timeoutMs: opts.timeoutMs ?? AVATAR_FILE_TIMEOUT_MS,
  });
}

/** Post's hard cap on one search's hits. */
export const SEARCH_LIMIT = 1000;
/** One `post search` hit. `preview` is post's one-line preview of the body, not the body. */
export type SearchHit = {
  channel: string;
  id: string;
  from: string;
  fromParticipant: string | undefined;
  displayName: string | undefined;
  sent: string;
  preview: string;
  /** Which fields matched: `body`, `from`, `id`. */
  matched: string[];
};
export type SearchPage = { hits: SearchHit[]; truncated: boolean; limit: number };

/**
 * Post's answer, held to what was asked: more hits than the limit, or a hit from any channel but
 * the one searched, is a malformed answer rather than something to show.
 */
function parseSearch(
  data: Record<string, unknown>,
  channel: string,
  limit: number,
): SearchPage | undefined {
  if (!Array.isArray(data.results) || typeof data.truncated !== 'boolean') return undefined;
  if (data.results.length > limit) return undefined;
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const hits: SearchHit[] = [];
  for (const item of data.results) {
    if (!isRecord(item)) return undefined;
    const id = text(item.id);
    const from = text(item.from);
    const sent = text(item.sent);
    const preview = text(item.preview);
    if (id === undefined || !safeName(id) || item.channel !== channel || from === undefined)
      return undefined;
    if (sent === undefined || preview === undefined) return undefined;
    hits.push({
      channel,
      id,
      from,
      fromParticipant: text(item.from_participant),
      displayName: text(item.display_name),
      sent,
      preview,
      matched: Array.isArray(item.matched) ? item.matched.filter((m) => typeof m === 'string') : [],
    });
  }
  return { hits, truncated: data.truncated, limit };
}

function badShape(what: string): Failure {
  return fail({
    code: 'bad_output',
    message: `post answered in an invalid shape (${what})`,
    retryable: false,
  });
}
function badName(name: string): Failure {
  return fail({
    code: 'invalid_argument',
    message: `invalid post argument: ${name.slice(0, 40)}`,
    retryable: false,
  });
}

/** The call that binds (or restores) Trey's participant: a fixed key, so it is the same id every time. */
function bindArgs(room: string): string[] {
  return [
    'participant',
    'bind',
    '--harness',
    'porch',
    '--key',
    room,
    '--workspace',
    room,
    '--json',
  ];
}

/** A reader's `ok` answer that says nobody is bound is not an answer about him: a failure. */
function unbound(data: Record<string, unknown>): Failure | undefined {
  if (data.ok !== true || data.bound !== false) return undefined;
  return fail({
    code: 'unbound',
    message: 'post says no participant is bound here, so nothing can be read as Trey.',
    retryable: true,
  });
}

/**
 * Whether post said it does not know the id he acts as: `participant_missing` (post 7286de3), the
 * older `no_participant` for a record that is gone, or, from a reader, an `ok` answer that says it
 * is `bound: false` (an answer about nobody, not about him).
 */
function lostParticipant(out: Outcome): boolean {
  if (out.failed !== undefined) return false;
  const data = decodeJson(out.stdout, out.stderr);
  if (data === undefined) return false;
  // `watch --snapshot` says it as an event, with no `ok`.
  if (data.event === 'unbound') return data.bound === false;
  if (data.ok === true) return data.bound === false;
  const error = data.error;
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as Record<string, unknown>).code;
  return code === 'participant_missing' || code === 'no_participant';
}

/** porch's participant for the owner: `porch-<hex>`, in the owner's room. */
function readBinding(data: Record<string, unknown>, room: string): string | undefined {
  const p = data.participant;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return undefined;
  const rec = p as Record<string, unknown>;
  const id = rec.id;
  if (
    data.ok !== true ||
    data.status !== 'bound' ||
    typeof id !== 'string' ||
    !/^porch-[a-f0-9]+$/.test(id) ||
    data.id !== id ||
    rec.workspace !== room ||
    rec.harness !== 'porch'
  ) {
    return undefined;
  }
  return id;
}
