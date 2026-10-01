import { isAttentionEligible, type RawRecord, type SelfIds } from './records.ts';

export type Divider = {
  before: string;
  covered: boolean;
  unread: number;
  openedAt: string | undefined;
};
/** Post's count is authoritative. Only eligible records can anchor a divider. */
export function dividerFor(
  records: readonly RawRecord[],
  unread: number | undefined,
  self: SelfIds,
): Divider | undefined {
  if (unread === undefined || unread <= 0) return undefined;
  const eligible = records.filter((r) => isAttentionEligible(r, self));
  if (eligible.length === 0) return undefined;
  return {
    before: (eligible.at(-unread) ?? (eligible[0] as RawRecord)).id,
    covered: eligible.length >= unread,
    unread,
    openedAt: records.at(-1)?.id,
  };
}
export function dividerCount(d: Divider, records: readonly RawRecord[], self: SelfIds): number {
  return (
    d.unread +
    records.filter(
      (r) => isAttentionEligible(r, self) && d.openedAt !== undefined && r.id > d.openedAt,
    ).length
  );
}
export function badgeOf(unread: number | undefined): string | undefined {
  return unread !== undefined && unread > 0 ? `●${unread > 99 ? '99+' : unread}` : undefined;
}
export function mergeRecords(
  current: readonly RawRecord[],
  arrivals: readonly RawRecord[],
  limit = 200,
): RawRecord[] {
  const records = new Map(current.map((r) => [r.id, r]));
  for (const r of arrivals) {
    const old = records.get(r.id);
    if (old?.bodyComplete && !r.bodyComplete) continue;
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(r)) continue;
    // In a duplicate across suffixes, .msg wins, as in Post's retrieval contract.
    if (old?.file === 'msg' && r.file === 'emote') continue;
    records.set(r.id, r);
  }
  return [...records.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-limit);
}
