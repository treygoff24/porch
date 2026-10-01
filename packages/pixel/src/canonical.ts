/**
 * Canonical JSON (I1, "Canonical form"): compact, object members sorted by name, integers in plain
 * decimal, strings as decoded. Every name and string the formats allow is ASCII with nothing to
 * escape, so `JSON.stringify` of a string is already canonical, and a UTF-16 sort is a byte sort.
 */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error(`canonical JSON holds integers only, got ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON cannot hold ${String(v)}`);
}

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}
