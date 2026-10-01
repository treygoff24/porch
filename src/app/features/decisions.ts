import { join } from 'node:path';
import {
  type ActionKnowledge,
  badgeFor,
  DecisionAuthority,
  type DrEvent,
  type DrRecord,
  decide,
  hasActorEvent,
  offerLine,
  parseObservedAction,
  project,
  propose,
  type RawRecord,
  replay,
  supersede,
  verify,
} from '@estate/post-kit';
import { wrap } from '../../grid/text.ts';
import type { AppState, MessageRenderer } from '../registry.ts';
import { K } from '../theme.ts';
import { decisionActor } from './lookup.ts';
import { channel, currentRecords, featureCommand, outcome, request, services } from './runtime.ts';
import { afterProposal, messageTime } from './time.ts';

/** Preserve T3's verification memo/budget, checking proposal context on every projection. */
class ScopedAuthority extends DecisionAuthority {
  private proposals = new Map<string, DrEvent>();
  constructor(
    options: ConstructorParameters<typeof DecisionAuthority>[0],
    readonly actors: Map<string, RawRecord>,
  ) {
    super(options);
  }
  bind(events: readonly DrEvent[]): void {
    this.proposals.clear();
    for (const event of events) {
      const dr = event.get('dr');
      if (event.get('type') === 'proposed' && typeof dr === 'string' && !this.proposals.has(dr))
        this.proposals.set(dr, event);
    }
  }
  override peek(id: string): ActionKnowledge {
    const known = super.peek(id);
    if (known.kind !== 'known' || !known.action) return known;
    const actor = this.actors.get(id);
    const sent = actor ? messageTime(actor) : undefined;
    const ids = [known.action.dr, ...(known.action.replacement ? [known.action.replacement] : [])];
    if (
      !actor ||
      sent === undefined ||
      ids.some((id) => {
        const proposal = this.proposals.get(id);
        const created = afterProposal(proposal?.get('created'));
        return (
          !proposal ||
          created === undefined ||
          sent < created ||
          actor.channel !== proposal.get('channel') ||
          actor.storageChannel !== proposal.get('channel')
        );
      })
    )
      return { kind: 'known', action: null };
    return known;
  }
}

export class Decisions {
  private readonly anchorIds = new Set<string>();
  private readonly cache = new WeakMap<AppState['actions'], Map<string, DrRecord>>();
  private readonly running = new WeakMap<AppState['actions'], Promise<Map<string, DrRecord>>>();
  private readonly authorities = new WeakMap<AppState['actions'], ScopedAuthority>();
  private path(s: AppState): string {
    return join(services(s).config.ownerRoomDir, 'decision-records.jsonl');
  }
  /** Reverify exact actor bytes. A display badge or a receipt alone is never authority. */
  private authority(s: AppState): ScopedAuthority {
    let authority = this.authorities.get(s.actions);
    if (!authority) {
      const actors = new Map<string, RawRecord>();
      authority = new ScopedAuthority(
        {
          ownerRoom: s.owner.room,
          marker: s.owner.marker,
          lookup: async (id) => {
            const post = services(s);
            const raw = await decisionActor(post.config.mailRoot, id);
            if (!raw) return { kind: 'unknown' };
            const verdict = await verify(raw, post.client.owner);
            if (verdict.state === 'verified') actors.set(id, raw);
            return verdict.state === 'verified'
              ? {
                  kind: 'verified',
                  body: Buffer.from(raw.body),
                  signatureRefPresent: raw.signature.present,
                  from: raw.from,
                }
              : { kind: verdict.state === 'failed' ? 'failed' : 'unknown' };
          },
        },
        actors,
      );
      this.authorities.set(s.actions, authority);
    }
    return authority;
  }
  refresh(s: AppState): Promise<Map<string, DrRecord>> {
    const running = this.running.get(s.actions);
    if (running) return running;
    const task = (async () => {
      const events = replay(this.path(s));
      const authority = this.authority(s);
      authority.bind(events);
      const records = await project(events, authority);
      this.cache.set(s.actions, records);
      for (const r of records.values())
        if (typeof r.anchorMessageId === 'string') this.anchorIds.add(r.anchorMessageId);
      return records;
    })().finally(() => this.running.delete(s.actions));
    this.running.set(s.actions, task);
    return task;
  }
  /** T6 calls after polling. Only verified owner actions enter the shared log. */
  async observe(s: AppState): Promise<void> {
    const path = this.path(s);
    const events = replay(path);
    for (const r of currentRecords(s)) {
      if (r.kind !== 'message' || r.verdict.state !== 'verified' || hasActorEvent(events, r.raw.id))
        continue;
      const action = parseObservedAction(
        { from: r.raw.from, body: r.raw.body, signatureRefPresent: r.raw.signature.present },
        s.owner.room,
        s.owner.marker,
      );
      if (!action) continue;
      // The projection's independent exact-byte lookup determines authorization.
      const event =
        action.verb === 'superseded' && action.replacement
          ? await supersede(action.dr, action.replacement, r.raw.id, path)
          : await decide(
              action.dr,
              action.verb === 'accepted' ? 'ratified' : 'rejected',
              r.raw.id,
              path,
            );
      events.push(event);
    }
    await this.refresh(s);
    s.actions.requestFrame();
  }
  commands() {
    return [
      featureCommand(
        'decision',
        '/decision <msg-prefix> <project> [title] — propose a decision about a message',
        async (args, ctx) => {
          const [prefix, projectName, ...titleParts] = args.split(/\s+/);
          if (!prefix || !projectName) throw new Error('/decision <msg-prefix> <project> [title]');
          const matches = currentRecords(ctx.state).filter(
            (r) => r.kind === 'message' && r.raw.id.startsWith(prefix),
          );
          const anchor = matches[0];
          if (matches.length !== 1 || !anchor)
            throw new Error('message prefix must match exactly one loaded message');
          const title =
            titleParts.join(' ') || anchor.text.replace(/⚖/g, '').replace(/\s+/g, ' ').slice(0, 60);
          const event = await propose(
            {
              title,
              project: projectName,
              channel: channel(ctx.state),
              anchorMessageId: anchor.raw.id,
            },
            this.path(ctx.state),
          );
          const dr = String(event.get('dr'));
          const result = await ctx.send(
            request(
              ctx.state,
              offerLine({ dr, title, project: projectName }, ctx.state.owner.label),
            ),
          );
          outcome(ctx, result);
          await this.refresh(ctx.state);
          ctx.state.actions.requestFrame();
        },
        { aliases: ['propose'] },
      ),
      ...(['accept', 'reject', 'supersede'] as const).map((verb) =>
        featureCommand(
          verb,
          verb === 'supersede'
            ? '/supersede <old> <new> — replace a ratified decision with another (signed)'
            : verb === 'accept'
              ? '/accept <dr> — ratify a pending decision (signed)'
              : '/reject <dr> — turn down a pending decision (signed)',
          async (args, ctx) => {
            if (ctx.state.mode !== 'signed' || !ctx.state.armed || ctx.state.signingBlocked)
              throw new Error('this action must be sent in SIGNED mode with signing armed');
            const words = args.split(/\s+/);
            if (
              words.length !== (verb === 'supersede' ? 2 : 1) ||
              words.some((w) => !/^dr-\d{1,9}$/.test(w))
            )
              throw new Error(`invalid /${verb} arguments`);
            const old = words[0] ?? '';
            const replacement = words[1];
            const records = await this.refresh(ctx.state);
            if (
              records.get(old)?.channel !== channel(ctx.state) ||
              (replacement && records.get(replacement)?.channel !== channel(ctx.state))
            )
              throw new Error('decision action must be sent in its proposal channel');
            if (verb === 'supersede') {
              if (
                old === replacement ||
                records.get(old)?.state !== 'ratified' ||
                records.get(replacement ?? '')?.state !== 'ratified'
              )
                throw new Error('supersede needs two distinct ratified records');
            } else if (records.get(old)?.state !== 'needs_operator_decision')
              throw new Error('decision is not pending');
            const times = [old, ...(replacement ? [replacement] : [])].map((id) =>
              afterProposal(records.get(id)?.created),
            );
            if (times.some((time) => time === undefined))
              throw new Error('proposal time is invalid');
            const earliest = times.reduce((a, b) => ((a ?? 0n) > (b ?? 0n) ? a : b), 0n) ?? 0n;
            const delay = Math.ceil(Number(earliest - BigInt(Date.now()) * 1000000n) / 1000000);
            if (delay > 1500) throw new Error('proposal time is in the future');
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay + 5));
            const body = `⚖️ DR ${old} ${verb === 'accept' ? 'accepted' : verb === 'reject' ? 'rejected' : `superseded by ${replacement}`}`;
            const result = await ctx.send(request(ctx.state, body));
            outcome(ctx, result);
            if (result.kind === 'confirmed') {
              if (verb === 'supersede')
                await supersede(old, replacement ?? '', result.id, this.path(ctx.state));
              else
                await decide(
                  old,
                  verb === 'accept' ? 'ratified' : 'rejected',
                  result.id,
                  this.path(ctx.state),
                );
              await this.refresh(ctx.state);
              ctx.state.actions.requestFrame();
            }
          },
        ),
      ),
      featureCommand('dr', "/dr — list this project's decision records", async (_, ctx) => {
        const records = await this.refresh(ctx.state);
        ctx.status(
          records.size
            ? [...records.values()].map((r) => `${r.dr} ${r.state}: ${String(r.title)}`).join(' · ')
            : 'no decision records',
        );
      }),
    ];
  }
  renderer(): MessageRenderer {
    return {
      kind: 'message',
      match: (r) => this.anchorIds.has(r.raw.id),
      measure: (r, w) => wrap(r.text, w).length + 1,
      draw: (g, area, r, s) => {
        const records = this.cache.get(s.actions);
        const badge = [...(records?.values() ?? [])].find(
          (dr) => dr.channel === r.raw.channel && dr.anchorMessageId === r.raw.id,
        );
        g.withClip(area, () => {
          let y = area.y;
          for (const line of wrap(r.text, area.w))
            g.text(area.x, y++, line, { fg: K.data }, area.w);
          if (badge)
            g.text(
              area.x,
              y,
              `${badge.dr}${badgeFor(badge.state, s.owner.label)}`,
              { fg: badge.state === 'needs_operator_decision' ? K.magenta : K.green },
              area.w,
            );
        });
      },
    };
  }
  decorate(renderer: MessageRenderer): MessageRenderer {
    return {
      ...renderer,
      measure: (r, w) => renderer.measure(r, w) + (this.anchorIds.has(r.raw.id) ? 1 : 0),
      draw: (g, area, r, s) => {
        const badge = this.badge(s, r.raw.id, r.raw.channel);
        renderer.draw(g, badge ? { ...area, h: Math.max(0, area.h - 1) } : area, r, s);
        if (badge)
          g.withClip(area, () =>
            g.text(area.x, area.y + renderer.measure(r, area.w), badge, { fg: K.gray }, area.w),
          );
      },
    };
  }
  badge(s: AppState, id: string, name = s.current): string {
    const record = [...(this.cache.get(s.actions)?.values() ?? [])].find(
      (r) => r.channel === name && r.anchorMessageId === id,
    );
    return record ? `${record.dr}${badgeFor(record.state, s.owner.label)}` : '';
  }
}
