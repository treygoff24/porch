import {
  applyImpersonationCap,
  defaultAvatar,
  framePixels,
  resolveAccent,
  SPRITE_PALETTE,
  toHalfBlocks,
} from '@estate/pixel';
import {
  ballotBody,
  checkVote,
  type DisplayRecord,
  findBallots,
  findPolls,
  type PollMessage,
  tally,
  toDisplay,
} from '@estate/post-kit';
import { wrap } from '../../grid/text.ts';
import { monoSprite } from '../mono-art.ts';
import type { AppState, KeyBinding, MessageRenderer } from '../registry.ts';
import { K } from '../theme.ts';
import {
  currentRecords,
  featureCommand,
  fullHistory,
  outcome,
  request,
  selected,
} from './runtime.ts';
import { sentTime } from './time.ts';

/** Strip the casual owner's marker while preserving post-poll's latest ballot per room. */
function messages(records: readonly DisplayRecord[]): PollMessage[] {
  return records
    .filter((r) => r.kind === 'message' && r.verdict.state !== 'failed')
    .map((r) => ({
      from: r.raw.from,
      sent: r.raw.sent,
      body: r.text.trim(),
    }));
}
export const voteCommand = featureCommand(
  'vote',
  '/vote <poll-id> <choice> — vote on a poll in this channel',
  async (args, ctx) => {
    let [id, choice, extra] = args.split(/\s+/);
    const post = ctx.state.post;
    const msgs = post
      ? messages(
          (await fullHistory(ctx.state)).map((raw) =>
            toDisplay(raw, { anchor: post.client.owner }),
          ),
        )
      : messages(currentRecords(ctx.state));
    if (/^[1-9]$/.test(args)) {
      const poll = [...findPolls(messages([selected(ctx.state)])).values()][0];
      if (!poll) throw new Error('pick a poll to vote');
      id = poll.id;
      choice = [...poll.options.keys()][Number(args) - 1];
    }
    if (!id || !choice || extra) throw new Error('/vote <poll-id> <choice>');
    const letter = checkVote(findPolls(msgs), id, choice, ctx.state.current ?? '');
    outcome(ctx, await ctx.send(request(ctx.state, ballotBody(id, letter))));
  },
);
type PollCache = {
  records: readonly DisplayRecord[] | undefined;
  latest: readonly DisplayRecord[];
  error: string | undefined;
  inFlight: Promise<void> | undefined;
  window: readonly DisplayRecord[] | undefined;
};
export class Polls {
  private readonly caches = new WeakMap<AppState['actions'], Map<string, PollCache>>();
  private entry(s: AppState, name: string): PollCache {
    let channels = this.caches.get(s.actions);
    if (!channels) {
      channels = new Map();
      this.caches.set(s.actions, channels);
    }
    let entry = channels.get(name);
    if (!entry) {
      entry = {
        records: undefined,
        latest: [],
        error: undefined,
        inFlight: undefined,
        window: undefined,
      };
      channels.set(name, entry);
    }
    return entry;
  }
  private arrivals(entry: PollCache, loaded: readonly DisplayRecord[]): void {
    if (entry.window === loaded) return;
    entry.window = loaded;
    entry.latest = this.merge(entry.latest, loaded);
    if (entry.records) entry.records = this.merge(entry.records, loaded);
  }
  private merge(
    records: readonly DisplayRecord[],
    updates: readonly DisplayRecord[],
  ): DisplayRecord[] {
    const byId = new Map(records.map((r) => [r.raw.id, r]));
    for (const r of updates) byId.set(r.raw.id, r);
    return [...byId.values()].sort((a, b) => {
      const at = sentTime(a.raw.sent) ?? 0n;
      const bt = sentTime(b.raw.sent) ?? 0n;
      return at < bt ? -1 : at > bt ? 1 : a.raw.id.localeCompare(b.raw.id);
    });
  }
  /** T6 calls on channel open; Ctrl+O also refreshes. Arrivals only merge their records. */
  open(s: AppState, name: string): Promise<void> {
    const entry = this.entry(s, name);
    this.arrivals(entry, s.views.get(name)?.records ?? []);
    if (!s.post || entry.inFlight) return entry.inFlight ?? Promise.resolve();
    const post = s.post;
    entry.error = undefined;
    entry.inFlight = fullHistory(s, name)
      .then(
        (records) => {
          entry.records = this.merge(
            records.map((raw) => toDisplay(raw, { anchor: post.client.owner })),
            this.merge(entry.records ?? [], entry.latest),
          );
        },
        (err) => {
          entry.error = (err as Error).message;
        },
      )
      .finally(() => {
        entry.inFlight = undefined;
        s.actions.requestFrame();
      });
    return entry.inFlight;
  }
  key(): KeyBinding {
    return {
      id: 'features-polls',
      layer: 'chord',
      key: (key, s) => {
        if (key.ctrl && key.name === 'o' && s.current) void this.open(s, s.current);
        return 'pass';
      },
    };
  }
  renderer(): MessageRenderer {
    return {
      kind: 'message',
      match: (r) => findPolls(messages([r])).size > 0,
      measure(r, width) {
        const poll = [...findPolls(messages([r])).values()][0];
        return poll
          ? wrap(`${poll.id}: ${poll.question}`, width).length +
              [...poll.options].reduce(
                (n, [l, t]) => n + wrap(`${l}) ${t}`, Math.max(1, width - 12)).length + 4,
                0,
              ) +
              1
          : 1;
      },
      draw: (g, area, r, s: AppState) => {
        const name = r.raw.channel;
        const entry = this.entry(s, name);
        const loaded = s.views.get(name)?.records ?? [];
        this.arrivals(entry, loaded);
        if (!s.post) entry.records = entry.latest;
        else if (entry.records === undefined && !entry.inFlight && entry.error === undefined)
          void this.open(s, name);
        const view = {
          records: entry.records ?? loaded,
          loading: entry.records === undefined && !entry.error,
          error: entry.error,
        };
        const msgs = messages(view.records);
        const poll = [...findPolls(messages([r])).values()][0];
        if (!poll) return;
        const result = tally(poll, findBallots(msgs, poll.id));
        let y = area.y;
        g.withClip(area, () => {
          for (const line of wrap(`${poll.id}: ${poll.question}`, area.w))
            g.text(
              area.x,
              y++,
              line,
              { fg: r.sender.isOwner ? K.cyan : K.data, bold: true },
              area.w,
            );
          for (const row of result.rows) {
            for (const line of wrap(
              `${row.letter}) ${row.text}  (${view.loading || view.error ? '?' : row.count})`,
              area.w,
            ))
              g.text(area.x, y++, line, { fg: K.data }, area.w);
            let x = area.x;
            for (const voter of (view.loading || view.error ? [] : row.voters).slice(
              0,
              Math.floor(area.w / 9),
            )) {
              const ballot = view.records.findLast(
                (r) =>
                  r.raw.from === voter &&
                  r.verdict.state !== 'failed' &&
                  r.text.trim().startsWith(`🗳️ ${poll.id}:`),
              );
              const participant = ballot?.raw.fromParticipant ?? voter;
              const isOwner = ballot?.sender.isOwner === true;
              const pack = s.avatars.get(participant) ?? defaultAvatar(participant);
              const head = applyImpersonationCap(
                framePixels(pack.head.idle),
                'head',
                { isOwner: isOwner },
                resolveAccent(pack, { isOwner: isOwner }, participant),
              );
              g.blit(
                x,
                y,
                toHalfBlocks(s.noColor === true ? monoSprite(head) : head, SPRITE_PALETTE),
              );
              x += 9;
            }
            y += 4;
          }
          g.text(
            area.x,
            y,
            view.error
              ? 'tally unavailable · retry on new traffic'
              : view.loading
                ? 'tally loading…'
                : `${result.votes} votes · pick + 1–9 to vote`,
            { fg: K.gray },
            area.w,
          );
        });
      },
    };
  }
}
export function pollRenderer(): MessageRenderer {
  return new Polls().renderer();
}
