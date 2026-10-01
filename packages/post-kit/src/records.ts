import { type EmoteRecordVerdict, parseEmoteRecord } from '@estate/pixel';
import type { OwnerAnchor } from './owner.ts';
import { component } from './safe-fs.ts';

export type EmoteParse = EmoteRecordVerdict;
export type SignatureLocator = { present: false } | { present: true; raw: unknown };
export type RawRecord = {
  file: 'msg' | 'emote';
  storageChannel: string;
  envelope: Readonly<Record<string, unknown>>;
  id: string;
  from: string;
  channel: string;
  sent: string;
  fromParticipant?: string;
  fromLineage?: string;
  fromHost?: string;
  event?: string;
  re?: string;
  mentions: readonly string[];
  body: string;
  bodyComplete: boolean;
  signature: SignatureLocator;
  emote?: EmoteParse;
};
export type Verdict = { state: 'verified' | 'failed' | 'unknown' | 'unsigned'; reason: string };
export type SenderLabel = {
  text: string;
  room: string;
  participant?: string;
  lineage?: string;
  isOwner: boolean;
};
export type DisplayContext = { anchor: OwnerAnchor; verdict?: Verdict };
export type DisplayRecord = {
  raw: RawRecord;
  kind: 'message' | 'emote' | 'event';
  text: string;
  sender: SenderLabel;
  verdict: Verdict;
  /**
   * Trey's own send that post has not confirmed yet, shown at once. Never a record post holds: it
   * has no real id, and it goes away when the real record lands or the send is refused.
   */
  pending?: true;
};

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Complete-message and slice responses have different fields. A slice is never inferred complete. */
export function parseRaw(
  raw: unknown,
  storageChannel: string,
  opts: { file?: 'msg' | 'emote'; body?: string; bodyComplete?: boolean } = {},
): RawRecord | undefined {
  try {
    return parseRawRecord(raw, storageChannel, opts);
  } catch {
    // Untrusted records cannot turn one corrupt file into a failed history read.
    return undefined;
  }
}
function parseRawRecord(
  raw: unknown,
  storageChannel: string,
  opts: { file?: 'msg' | 'emote'; body?: string; bodyComplete?: boolean },
): RawRecord | undefined {
  if (
    !isRecord(raw) ||
    !['id', 'from', 'channel', 'sent'].every((key) => typeof raw[key] === 'string')
  )
    return undefined;
  const envelope = Object.freeze(structuredClone(raw));
  if (typeof envelope.signature_ref === 'object' && envelope.signature_ref !== null)
    Object.freeze(envelope.signature_ref);
  const file = opts.file ?? (raw.event === 'emote' ? 'emote' : 'msg');
  const body = opts.body ?? str(raw.body) ?? str(raw.body_slice) ?? '';
  const bodyComplete =
    opts.bodyComplete ??
    (typeof raw.body === 'string' && raw.body_complete !== false && raw.truncated !== true);
  const record: RawRecord = {
    file,
    storageChannel,
    envelope,
    id: raw.id as string,
    from: raw.from as string,
    channel: raw.channel as string,
    sent: raw.sent as string,
    ...(str(raw.from_participant) === undefined
      ? {}
      : { fromParticipant: raw.from_participant as string }),
    ...(str(raw.from_lineage) === undefined ? {} : { fromLineage: raw.from_lineage as string }),
    ...(str(raw.from_host) === undefined ? {} : { fromHost: raw.from_host as string }),
    ...(str(raw.event) === undefined ? {} : { event: raw.event as string }),
    ...(str(raw.re) === undefined ? {} : { re: raw.re as string }),
    mentions: Object.freeze(
      Array.isArray(raw.mentions)
        ? raw.mentions.filter((m): m is string => typeof m === 'string')
        : [],
    ),
    body,
    bodyComplete,
    signature: Object.hasOwn(raw, 'signature_ref')
      ? { present: true, raw: envelope.signature_ref }
      : { present: false },
  };
  if (file === 'emote' || raw.event === 'emote') {
    record.emote = parseEmoteRecord(Buffer.from(`${JSON.stringify(raw)}\n---\n${body}`));
    if (record.emote.verdict === 'omitted') return undefined;
  }
  return Object.freeze(record);
}

export function parseMessages(data: unknown, storageChannel: string): RawRecord[] | undefined {
  if (!isRecord(data) || data.ok !== true) return undefined;
  if (Array.isArray(data.messages))
    return data.messages
      .flatMap((m) => {
        const r = parseRaw(m, storageChannel);
        return r === undefined ? [] : [r];
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (isRecord(data.message)) {
    const body = str(data.body) ?? str(data.body_slice) ?? str(data.message.body);
    const r = parseRaw(data.message, storageChannel, {
      ...(body === undefined ? {} : { body }),
      bodyComplete:
        typeof data.body === 'string' ||
        (data.body_complete === true &&
          isRecord(data.range) &&
          data.range.start === 0 &&
          data.range.end_exclusive === data.total_body_bytes),
    });
    return r === undefined ? [] : [r];
  }
  return undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: untrusted display text
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const displayText = (text: string): string => text.replace(CONTROLS, '');
const label = (text: string) => displayText(text).replace(/\s+/g, ' ').trim();

export function hasSignatureClaim(raw: RawRecord, anchor: OwnerAnchor): boolean {
  return (
    raw.signature.present ||
    (raw.from === anchor.ownerRoom &&
      (raw.body.includes('[signed:') || raw.body.startsWith(`${anchor.marker}🔏`)))
  );
}

export function toDisplay(raw: RawRecord, ctx: DisplayContext): DisplayRecord {
  const verdict =
    ctx.verdict ??
    (hasSignatureClaim(raw, ctx.anchor)
      ? { state: 'unknown', reason: 'verification not run' }
      : { state: 'unsigned', reason: 'no signature claimed' });
  const owner = raw.from === ctx.anchor.ownerRoom;
  const isOwner = owner && (verdict.state === 'verified' || verdict.state === 'unsigned');
  const participant = raw.fromParticipant === undefined ? undefined : label(raw.fromParticipant);
  const lineage = raw.fromLineage === undefined ? undefined : label(raw.fromLineage);
  const name = label(str(raw.envelope.display_name) ?? raw.from);
  const sender: SenderLabel = {
    text: owner
      ? isOwner
        ? label(ctx.anchor.label)
        : `claims ${label(ctx.anchor.label)}`
      : lineage
        ? `${lineage} [${participant ?? name}]`
        : name,
    room: label(raw.from),
    isOwner,
    ...(participant === undefined ? {} : { participant }),
    ...(lineage === undefined ? {} : { lineage }),
  };
  const kind =
    raw.file === 'emote' || raw.event === 'emote'
      ? 'emote'
      : raw.event === undefined
        ? 'message'
        : 'event';
  let text = raw.body;
  if (owner) {
    const prefix = `${ctx.anchor.marker}🔏 `;
    if (text.startsWith(prefix) || (!raw.signature.present && text.includes('[signed:'))) {
      if (text.startsWith(prefix)) text = text.slice(prefix.length);
      text = `${text.replace(/\s*\[signed:[^\]\r\n]*\]/g, '')} [${verdict.state}]`;
    } else if (!raw.signature.present && text.startsWith(`${ctx.anchor.marker} `))
      text = text.slice(ctx.anchor.marker.length + 1);
  }
  if (kind === 'emote') {
    const payload = raw.emote?.emote ?? raw.envelope.emote;
    const name =
      isRecord(payload) &&
      typeof payload.name === 'string' &&
      /^[a-z][a-z0-9_-]{0,23}$/.test(payload.name)
        ? payload.name
        : 'emoted';
    text = `✦ ${sender.text} ${name}`;
  }
  return { raw, kind, text: displayText(text), sender, verdict };
}

export type SelfIds = { room: string; participant?: string; receiptIds?: ReadonlySet<string> };
export function isAttentionEligible(r: RawRecord, self: SelfIds): boolean {
  return (
    r.file === 'msg' &&
    (r.event === undefined || r.event === 'join' || r.event === 'profile') &&
    !(
      r.fromHost === undefined &&
      self.participant !== undefined &&
      r.fromParticipant === self.participant
    ) &&
    !self.receiptIds?.has(r.id)
  );
}
export function newestEligible(
  records: readonly RawRecord[],
  self: SelfIds,
): RawRecord | undefined {
  return records
    .filter((r) => isAttentionEligible(r, self))
    .reduce<RawRecord | undefined>((a, b) => (a === undefined || b.id > a.id ? b : a), undefined);
}
export function newRecords(
  records: readonly RawRecord[],
  acknowledged: string | undefined,
  self: SelfIds,
): RawRecord[] {
  return records.filter(
    (r) => isAttentionEligible(r, self) && (acknowledged === undefined || r.id > acknowledged),
  );
}
export function safeArgument(value: string): string {
  component(value);
  if (value.startsWith('-')) throw new Error('argument must not be a flag');
  return value;
}
