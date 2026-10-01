/**
 * A strict, duplicate-aware JSON reader (RFC 8259) for the avatar format (build plan I1,
 * "Parsing"). `JSON.parse` cannot be used: it keeps the last of two repeated member names, accepts
 * a leading byte-order mark only by accident of the decoder, and loses whether `1.0` was written
 * with a fraction. This reader keeps every object's members in order, reports the first repeated
 * name (compared after escapes are decoded), and keeps each number's source text so that integers
 * are judged by value: `1`, `1.0` and `1e0` are all the integer 1, and `250.5` is not an integer.
 *
 * Nesting is limited to `MAX_NESTING` (127) containers, counting the outermost one: a header
 * object holding 127 nested arrays is accepted, and one more is a syntax error (coordinator
 * ruling, T4 review round 1). Deeper input is `json-syntax` for an avatar and `envelope-json` for
 * an emote record. Scalars do not count toward the depth.
 */

export type JsonValue =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'num'; v: number; int: boolean; raw: string }
  | { t: 'str'; v: string }
  | { t: 'arr'; v: JsonValue[] }
  | { t: 'obj'; v: Map<string, JsonValue> };

export type JsonResult =
  | { ok: true; value: JsonValue }
  | { ok: false; error: 'syntax' | 'duplicate' | 'utf8' };

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Parse `bytes` as exactly one JSON text. A byte-order mark is kept by the decoder and so is a
 * syntax error, as are comments, trailing commas and trailing content. A syntax error anywhere
 * outranks a repeated name, because the input is then not a JSON text at all.
 */
export function parseJsonBytes(bytes: Uint8Array): JsonResult {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false, error: 'utf8' };
  }
  return parseJsonText(text);
}

class SyntaxFail extends Error {}

/**
 * The deepest nesting of objects and arrays accepted: 127, serde_json's default recursion limit
 * (measured on serde_json 1.0.151: 127 nested containers accepted, the 128th refused), so post's
 * Rust reader and this one agree without either carrying its own limit (coordinator ruling).
 */
export const MAX_NESTING = 127;

const NUMBER = /-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

export function parseJsonText(s: string): JsonResult {
  let i = 0;
  let duplicate = false;
  const fail = (): never => {
    throw new SyntaxFail();
  };
  const ws = () => {
    for (;;) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1;
      else return;
    }
  };
  const expect = (lit: string) => {
    if (s.startsWith(lit, i)) i += lit.length;
    else fail();
  };
  const hex4 = (): number => {
    const h = s.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
    i += 4;
    return Number.parseInt(h, 16);
  };
  const str = (): string => {
    if (s[i] !== '"') fail();
    i += 1;
    let out = '';
    for (;;) {
      if (i >= s.length) fail();
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        i += 1;
        return out;
      }
      if (c < 0x20) fail();
      if (c === 0x5c) {
        const e = s[i + 1];
        i += 2;
        switch (e) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u':
            out += String.fromCharCode(hex4());
            break;
          default:
            fail();
        }
        continue;
      }
      out += s[i];
      i += 1;
    }
  };
  const num = (): JsonValue => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (m === null) return fail();
    const raw = m[0];
    i += raw.length;
    return { t: 'num', v: Number(raw), int: isIntegerText(raw), raw };
  };
  /** `depth` is the number of containers enclosing this value. */
  const value = (depth: number): JsonValue => {
    ws();
    const c = s[i];
    if ((c === '{' || c === '[') && depth + 1 > MAX_NESTING) fail();
    if (c === '{') {
      i += 1;
      const members = new Map<string, JsonValue>();
      ws();
      if (s[i] === '}') {
        i += 1;
        return { t: 'obj', v: members };
      }
      for (;;) {
        ws();
        const k = str();
        ws();
        expect(':');
        const v = value(depth + 1);
        if (members.has(k)) duplicate = true;
        else members.set(k, v);
        ws();
        if (s[i] === ',') {
          i += 1;
          continue;
        }
        if (s[i] === '}') {
          i += 1;
          return { t: 'obj', v: members };
        }
        fail();
      }
    }
    if (c === '[') {
      i += 1;
      const items: JsonValue[] = [];
      ws();
      if (s[i] === ']') {
        i += 1;
        return { t: 'arr', v: items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (s[i] === ',') {
          i += 1;
          continue;
        }
        if (s[i] === ']') {
          i += 1;
          return { t: 'arr', v: items };
        }
        fail();
      }
    }
    if (c === '"') return { t: 'str', v: str() };
    if (c === 't') {
      expect('true');
      return { t: 'bool', v: true };
    }
    if (c === 'f') {
      expect('false');
      return { t: 'bool', v: false };
    }
    if (c === 'n') {
      expect('null');
      return { t: 'null' };
    }
    return num();
  };
  try {
    const v = value(0);
    ws();
    if (i !== s.length) fail();
    return duplicate ? { ok: false, error: 'duplicate' } : { ok: true, value: v };
  } catch (e) {
    if (e instanceof SyntaxFail) return { ok: false, error: 'syntax' };
    throw e;
  }
}

/**
 * Whether a JSON number's text denotes an integer, decided exactly from its digits rather than
 * through a float: `2.5e2` is 250, `1.0` is 1, `1e400` is an integer too large for a double, and
 * `250.5` is not an integer.
 */
function isIntegerText(raw: string): boolean {
  const m = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw);
  if (m === null) return false;
  // The value is digits × 10^scale; strip trailing zeros from the digits into the scale.
  const frac = m[2] ?? '';
  const all = `${m[1] ?? ''}${frac}`;
  const digits = all.replace(/0+$/, '');
  if (/^0*$/.test(digits)) return true;
  const scale = Number(m[3] ?? '0') - frac.length + (all.length - digits.length);
  return scale >= 0;
}
