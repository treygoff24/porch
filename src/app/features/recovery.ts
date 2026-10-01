/**
 * `/restore`: words from a send that may not have landed. The overlay wears the same arcade card as
 * the other overlays and never shows a raw record id: each entry says when the words were written,
 * where they were going, and whether history suggests they landed anyway (and where, and when).
 */
import type { RawRecord, RecoveryRecord } from '@estate/post-kit';
import { wrap } from '../../grid/text.ts';
import { sentWhen } from '../derive.ts';
import { card, footer } from '../overlays/kit.ts';
import type { AppState, Overlay } from '../registry.ts';
import { T } from '../stage/theme.ts';
import { featureCommand, fullHistory, services } from './runtime.ts';
import { sentTime } from './time.ts';

/** When a recovery record's words were written (`MM-DD HH:MM`, local), from its id's stamp. */
export function writtenAt(record: Pick<RecoveryRecord, 'id'>): string | undefined {
  const stamp = /^(\d{20})/.exec(record.id)?.[1];
  if (!stamp) return undefined;
  const d = new Date(Number(BigInt(stamp) / 1000000n));
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Whether history suggests the words landed anyway, in words: where and when, never an id. */
export function recoveryHint(
  record: RecoveryRecord,
  history: readonly RawRecord[],
  s: Pick<AppState, 'owner'>,
): string {
  const stamp = /^(\d{20})/.exec(record.id)?.[1];
  if (!stamp) return 'not found';
  const earliest = BigInt(stamp) - 5000000000n;
  const candidates = history.filter(
    (r) =>
      r.file === 'msg' &&
      r.from === s.owner.room &&
      r.channel === record.channel &&
      r.storageChannel === record.channel &&
      r.bodyComplete &&
      (sentTime(r.sent) ?? -1n) >= earliest &&
      (r.re ?? null) === record.reply_to &&
      (r.body === record.text ||
        r.body === `${s.owner.marker} ${record.text}` ||
        r.body === `${s.owner.marker} ${record.text}\n` ||
        r.body === `${record.text}\n`),
  );
  const landed = candidates[0];
  return candidates.length === 1 && landed
    ? `likely landed in #${landed.channel} at ${sentWhen(landed.sent)}`
    : candidates.length > 1
      ? `ambiguous (${candidates.length} matches)`
      : 'not found';
}
export class Recovery {
  private readonly sessions = new WeakMap<
    AppState['actions'],
    {
      records: RecoveryRecord[];
      hints: Map<string, string>;
      pick: number;
      busy: boolean;
      generation: number;
    }
  >();
  private session(s: AppState) {
    let value = this.sessions.get(s.actions);
    if (!value) {
      value = { records: [], hints: new Map(), pick: 0, busy: false, generation: 0 };
      this.sessions.set(s.actions, value);
    }
    return value;
  }
  command() {
    return featureCommand(
      'restore',
      '/restore — recover words from a send that may not have landed',
      async (_, ctx) => {
        const session = this.session(ctx.state);
        session.records = await services(ctx.state).recovery.list();
        session.pick = 0;
        session.hints.clear();
        ctx.openOverlay('recovery');
        const history = new Map<string, RawRecord[]>();
        for (const r of session.records) {
          try {
            let records = history.get(r.channel);
            if (!records) {
              records = await fullHistory(ctx.state, r.channel);
              history.set(r.channel, records);
            }
            session.hints.set(r.id, recoveryHint(r, records, ctx.state));
          } catch {
            session.hints.set(r.id, 'history unavailable · check before retrying');
          }
        }
        ctx.state.actions.requestFrame();
      },
      { needsChannel: false },
    );
  }
  overlay(): Overlay {
    return {
      id: 'recovery',
      draw: (g, area, s) => {
        const session = this.session(s);
        const inner = card(g, area, 'RECOVER', T.pink, { maxW: 96, mono: s.noColor === true });
        const width = Math.max(1, inner.w);
        let y = inner.y;
        const bottom = inner.y + inner.h;
        const line = (text: string, style: Parameters<typeof g.text>[3], x = inner.x) => {
          if (y < bottom) g.text(x, y, text, style, inner.x + width - x);
          y++;
        };
        for (const text of wrap(
          'Words from sends that may not have landed. Nothing here is sent.',
          width,
        ))
          line(text, { fg: T.data });
        y++;
        if (!session.records.length) line('nothing to recover', { fg: T.gray });
        const visible = session.records.slice(Math.max(0, session.pick - 2), session.pick + 4);
        for (const r of visible) {
          if (y >= bottom) break;
          const chosen = r === session.records[session.pick];
          if (chosen) g.fill({ x: inner.x, y, w: width, h: 1 }, { bg: T.deep });
          const head = `#${r.channel} · written ${writtenAt(r) ?? 'at an unknown time'}`;
          g.text(inner.x, y, chosen ? '▶ ' : '  ', { fg: T.cyan, bold: true });
          line(
            head,
            chosen ? { fg: T.white, bg: T.deep, bold: true } : { fg: T.data },
            inner.x + 2,
          );
          for (const text of wrap(session.hints.get(r.id) ?? 'checking history…', width - 2))
            line(text, { fg: T.gray, italic: true }, inner.x + 2);
          for (const text of wrap(r.text.slice(0, 200), width - 4).slice(0, 3))
            line(text, { fg: T.data }, inner.x + 4);
          y++;
        }
        footer(
          g,
          inner,
          inner.w >= 64
            ? 'Enter restores to the composer · Delete discards · Esc closes'
            : 'Enter restore · Del discard · Esc',
        );
      },
      key: (k, s) => {
        const session = this.session(s);
        if (k.name === 'escape') {
          session.generation++;
          s.actions.closeOverlay();
          return 'handled';
        }
        if (k.name === 'up' || k.name === 'down') {
          session.pick = Math.max(
            0,
            Math.min(session.records.length - 1, session.pick + (k.name === 'up' ? -1 : 1)),
          );
          s.actions.requestFrame();
        }
        const record = session.records[session.pick];
        if (
          record &&
          !session.busy &&
          (k.name === 'return' || k.name === 'enter' || k.name === 'delete')
        ) {
          if (k.name !== 'delete' && record.channel !== s.current) {
            s.actions.status(`open #${record.channel} before restoring; record kept`);
            return 'handled';
          }
          if (k.name !== 'delete' && s.composer.text.trim()) {
            s.actions.status('draft kept; clear it before restoring');
            return 'handled';
          }
          session.busy = true;
          const generation = ++session.generation;
          void (async () => {
            if (k.name === 'delete') {
              await services(s).recovery.remove(record.id);
              session.records = session.records.filter((r) => r.id !== record.id);
              session.pick = Math.max(0, Math.min(session.pick, session.records.length - 1));
              s.actions.status('recovery record discarded');
            } else {
              const restored = await services(s).recovery.restore(record.id);
              if (generation !== session.generation) return;
              s.actions.openChannel(restored.channel);
              s.actions.setDraft(restored.text);
              s.actions.replyTo(restored.reply_to ?? undefined);
              s.actions.closeOverlay();
              s.actions.status(
                `restored words · ${session.hints.get(record.id) ?? 'check history'} · record kept`,
              );
            }
          })()
            .catch((err) => s.actions.status(`restore: ${(err as Error).message}`))
            .finally(() => {
              session.busy = false;
              s.actions.requestFrame();
            });
        }
        return 'handled';
      },
    };
  }
}
