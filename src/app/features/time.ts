/** Preserve post's fractional seconds when comparing signed timestamps. Invalid times fail closed. */
export function sentTime(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return;
  // Installed post writes a local-offset envelope timestamp; DR logs use UTC ISO.
  const text = value.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?) ([+-]\d{2})(\d{2})$/,
    '$1T$2$3:$4',
  );
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    text,
  );
  if (!match) return;
  const ms = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isSafeInteger(ms)) return;
  return BigInt(ms) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

/** Canonical post IDs preserve signed microseconds lost by its human-readable sent field. */
export function messageTime(record: { sent: string; id: string }): bigint | undefined {
  const time = sentTime(record.sent);
  const id = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{6})-/.exec(record.id);
  if (!id || time === undefined) return time;
  const precise = sentTime(`${id[1]}-${id[2]}-${id[3]}T${id[4]}:${id[5]}:${id[6]}.${id[7]}Z`);
  return precise !== undefined && precise / 1000000000n === time / 1000000000n ? precise : time;
}

/** A seconds-only proposal may have been created anywhere in that second: fail closed. */
export function afterProposal(value: unknown): bigint | undefined {
  const time = sentTime(value);
  if (time === undefined || typeof value !== 'string') return;
  return time + (/:\d{2}\.\d+/.test(value) ? 1n : 1000000000n);
}
