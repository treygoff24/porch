/**
 * Python-compatible text and JSON helpers. porch-tui (Python) and porch-next share files on disk,
 * so every place where Python's standard library decides a byte or a boundary is reproduced here
 * exactly: `json.dumps` separators and escaping, `json.loads` acceptance, `str.strip()`,
 * `str.splitlines()`, universal-newline reads, and Unicode `\d`. `test/stores/py.test.ts` checks each
 * helper against the real Python interpreter.
 */

/** A decoded JSON value. Objects are `Map`s so member order survives (a JS object reorders
 * integer-like keys such as a channel named `"123"`) and `__proto__` is an ordinary key. */
export type PyJson = null | boolean | number | PyNumberLiteral | string | PyJson[] | PyJsonObject;
export type PyJsonObject = Map<string, PyJson>;

/**
 * A JSON number the writer cannot put back byte for byte: any float (`2.0`, `1e3`, `NaN`,
 * `Infinity`) or an integer outside ±(2^53−1). Python keeps both exactly; a JavaScript number cannot
 * (`2.0` would come back as `2`, and `9007199254740993` as `…992`). Readers get `value`, the nearest
 * double, and `text`, the lexeme as written. The writer refuses it ({@link pyJsonDumps}), so a record
 * holding one in an unknown member is refused on write rather than silently changed.
 */
export class PyNumberLiteral {
  readonly text: string;
  readonly value: number;
  constructor(text: string, value: number) {
    this.text = text;
    this.value = value;
  }
}

/** Raised for any input Python's `json.loads` refuses. `kind: 'depth'` marks the case Python
 * reports as `RecursionError` rather than `ValueError`. */
export class PyJsonError extends Error {
  readonly kind: 'syntax' | 'depth';
  constructor(message: string, kind: 'syntax' | 'depth' = 'syntax') {
    super(message);
    this.name = 'PyJsonError';
    this.kind = kind;
  }
}

// Python's C scanner recurses once per nested container and stops near the default recursion
// limit (1000). Deeper documents are refused either way; the exact depth is not a shared format.
const MAX_DEPTH = 900;
// The C scanner's number grammar: ASCII digits only.
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;

/**
 * `json.loads(text)` for a `str` argument with the default `strict=True`: JSON whitespace only,
 * `NaN`/`Infinity`/`-Infinity` accepted, raw control characters in strings refused, lone surrogate
 * escapes kept as lone surrogates, duplicate object members resolved as last value in first
 * position.
 */
export function pyJsonLoads(text: string): PyJson {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const fail = (what: string): never => {
    throw new PyJsonError(`${what} at char ${i}`);
  };
  const value = (depth: number): PyJson => {
    if (depth > MAX_DEPTH) throw new PyJsonError('maximum nesting depth exceeded', 'depth');
    if (i >= n) return fail('Expecting value');
    const c = text[i];
    if (c === '{') return object(depth + 1);
    if (c === '[') return array(depth + 1);
    if (c === '"') return string();
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('NaN', i)) {
      i += 3;
      return new PyNumberLiteral('NaN', Number.NaN);
    }
    if (text.startsWith('Infinity', i)) {
      i += 8;
      return new PyNumberLiteral('Infinity', Number.POSITIVE_INFINITY);
    }
    if (text.startsWith('-Infinity', i)) {
      i += 9;
      return new PyNumberLiteral('-Infinity', Number.NEGATIVE_INFINITY);
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m === null) return fail('Expecting value');
    i += m[0].length;
    const lexeme = m[0];
    const num = Number(lexeme);
    // Only an integer lexeme that a double holds exactly becomes a plain number.
    return /[.eE]/.test(lexeme) || !Number.isSafeInteger(num)
      ? new PyNumberLiteral(lexeme, num)
      : num;
  };
  const string = (): string => {
    i++; // opening quote
    let out = '';
    let chunk = i;
    for (;;) {
      if (i >= n) return fail('Unterminated string starting');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(chunk, i);
        i++;
        return out;
      }
      if (c < 0x20) return fail('Invalid control character');
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(chunk, i);
      const e = text[i + 1];
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
        case 'u': {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail('Invalid \\uXXXX escape');
          i += 4;
          out += String.fromCharCode(Number.parseInt(hex, 16));
          break;
        }
        default:
          return fail('Invalid \\escape');
      }
      chunk = i;
    }
  };
  const object = (depth: number): PyJsonObject => {
    i++;
    const out: PyJsonObject = new Map();
    ws();
    if (text[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      if (text[i] !== '"') return fail('Expecting property name enclosed in double quotes');
      const key = string();
      ws();
      if (text[i] !== ':') return fail("Expecting ':' delimiter");
      i++;
      ws();
      out.set(key, value(depth));
      ws();
      if (text[i] === '}') {
        i++;
        return out;
      }
      if (text[i] !== ',') return fail("Expecting ',' delimiter");
      i++;
      ws();
    }
  };
  const array = (depth: number): PyJson[] => {
    i++;
    const out: PyJson[] = [];
    ws();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      ws();
      out.push(value(depth));
      ws();
      if (text[i] === ']') {
        i++;
        return out;
      }
      if (text[i] !== ',') return fail("Expecting ',' delimiter");
      i++;
    }
  };
  ws();
  const result = value(0);
  ws();
  if (i !== n) fail('Extra data');
  return result;
}

/**
 * `json.loads(raw)` for a `bytes` argument as porch-tui calls it: the bytes are decoded first. A
 * UTF-8 byte-order mark is skipped, as Python's encoding detection does. Invalid UTF-8 is refused.
 * (Python would also accept UTF-16 and UTF-32 JSON; neither app writes those, and refusing them is
 * the safe direction: the file is reported invalid and never overwritten.)
 */
export function pyJsonLoadsBytes(raw: Uint8Array): PyJson {
  let bytes = raw;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PyJsonError('not valid UTF-8');
  }
  return pyJsonLoads(text);
}

function unwritableNumber(text: string): PyJsonEncodeError {
  return new PyJsonEncodeError(
    `refusing to write the number ${text}: porch-next writes only integers within ±(2^53−1), so writing a float or a larger integer back would change it`,
  );
}

/** Refused before a write: a value Python's `json.dumps` could not produce identically. */
export class PyJsonEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PyJsonEncodeError';
  }
}

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function hex4(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/** Python's `json.dumps(s)` string literal, with `ensure_ascii` as given. */
export function pyJsonString(s: string, ensureAscii: boolean): string {
  let out = '"';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k] as string;
    const code = s.charCodeAt(k);
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) out += short;
    else if (code < 0x20) out += hex4(code);
    // ensure_ascii escapes everything outside ' '..'~' (DEL included), one UTF-16 unit at a time,
    // which is exactly Python's surrogate-pair output for characters beyond the BMP.
    else if (ensureAscii && code > 0x7e) out += hex4(code);
    else out += ch;
  }
  return `${out}"`;
}

type Dumpable =
  | null
  | boolean
  | number
  | PyNumberLiteral
  | string
  | readonly Dumpable[]
  | ReadonlyMap<string, Dumpable>
  | { readonly [key: string]: Dumpable };

/**
 * `json.dumps(value, ensure_ascii=…)` with Python's default separators (`", "` and `": "`).
 * Objects keep their iteration order.
 *
 * The compatibility contract is narrowed for numbers: only integers within ±(2^53−1) are written.
 * A float or a larger integer (a JavaScript number or a decoded {@link PyNumberLiteral}, say in an
 * unknown member carried through from a file) raises {@link PyJsonEncodeError} with nothing
 * written. Every value porch-tui and porch-next themselves write is a string, a boolean, null or a
 * small integer, so this refuses only foreign data, and never rewrites it to a different number.
 */
export function pyJsonDumps(value: Dumpable, ensureAscii: boolean): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value instanceof PyNumberLiteral) throw unwritableNumber(value.text);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw unwritableNumber(String(value));
    return String(value);
  }
  if (typeof value === 'string') return pyJsonString(value, ensureAscii);
  if (Array.isArray(value)) {
    return `[${(value as readonly Dumpable[]).map((v) => pyJsonDumps(v, ensureAscii)).join(', ')}]`;
  }
  const entries =
    value instanceof Map
      ? [...(value as ReadonlyMap<string, Dumpable>).entries()]
      : Object.entries(value as { readonly [key: string]: Dumpable });
  return `{${entries
    .map(([k, v]) => `${pyJsonString(k, ensureAscii)}: ${pyJsonDumps(v, ensureAscii)}`)
    .join(', ')}}`;
}

/** Characters for which Python's `str.isspace()` is true. */
export const PY_WHITESPACE = '\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0                　';
const WS_SET = new Set(PY_WHITESPACE);

/** A regular-expression character class matching Python's `\s` on `str` patterns. */
export const PY_S = `[${[...PY_WHITESPACE].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}]`;

export function pyIsSpace(ch: string): boolean {
  return WS_SET.has(ch);
}

/** `str.strip()` with no argument. */
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && WS_SET.has(s[a] as string)) a++;
  while (b > a && WS_SET.has(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

/** `str.rstrip()` with no argument. */
export function pyRstrip(s: string): string {
  let b = s.length;
  while (b > 0 && WS_SET.has(s[b - 1] as string)) b--;
  return s.slice(0, b);
}

const LINE_BREAKS = new Set(['\n', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x85', ' ', ' ']);

/** `str.splitlines()` with no argument: no trailing empty line, `\r\n` is one break. */
export function pySplitlines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let k = 0;
  while (k < s.length) {
    const ch = s[k] as string;
    if (LINE_BREAKS.has(ch)) {
      out.push(s.slice(start, k));
      k += ch === '\r' && s[k + 1] === '\n' ? 2 : 1;
      start = k;
    } else {
      k++;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Text-mode reading with universal newlines (`open(…)`/`read_text()` default): `\r\n` and a lone
 * `\r` both become `\n`. */
export function pyUniversalNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/** Python's `str.isdigit()`-free decimal test used by `\d` on `str` patterns: Unicode category Nd. */
export const PY_D = '\\p{Nd}';

const ND = /^\p{Nd}$/u;

/** The decimal value of one Nd character. Unicode keeps every Nd run as whole blocks of ten that
 * start at a zero, so the value is the offset from the start of the run, modulo ten. */
export function pyDigitValue(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined || !ND.test(ch)) throw new RangeError(`not a decimal digit: ${ch}`);
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/**
 * `int(s)` for a string: surrounding Python whitespace is ignored, a sign is allowed, digits may be
 * any Unicode Nd digit, and single underscores may separate digits. Returns `null` where Python
 * raises `ValueError`.
 */
export function pyInt(s: string): number | null {
  const t = pyStrip(s);
  const m = /^([+-]?)((?:\p{Nd})(?:_?\p{Nd})*)$/u.exec(t);
  if (m === null) return null;
  let v = 0;
  for (const ch of (m[2] as string).replaceAll('_', '')) v = v * 10 + pyDigitValue(ch);
  return m[1] === '-' ? -v : v;
}

/** The number of Unicode code points, as Python's `len()` counts a `str`. */
export function pyLen(s: string): number {
  let count = 0;
  for (const _ of s) count++;
  return count;
}

/** Python refuses to UTF-8-encode a string holding a lone surrogate; so does every writer here. */
export function pyEncodable(s: string): boolean {
  return s.isWellFormed();
}

/** `len(s.encode("utf-8"))`, or `null` where Python's encode would raise. */
export function pyUtf8Length(s: string): number | null {
  return s.isWellFormed() ? Buffer.byteLength(s, 'utf8') : null;
}
