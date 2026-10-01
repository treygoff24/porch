/**
 * A strict reader for the one TOML shape porch's config uses: a flat document of `key = value`
 * lines whose values are strings or booleans.
 *
 * It follows Python's `tomllib` (TOML 1.0) for every construct it accepts: bare and quoted keys,
 * basic, literal and multi-line strings with their escapes and trimming rules, `true`/`false`,
 * comments, CRLF line ends, and the control-character bans. Anything else (tables, dotted keys,
 * numbers, dates, arrays, inline tables) is refused with {@link TomlSubsetError}. porch-tui refuses
 * every such document too, because each of its fields must be a string or a boolean and its root
 * allows no other keys, so this reader accepts the same config files porch-tui does.
 * `test/config/toml.test.ts` checks that claim against `tomllib` on a corpus.
 */

export type TomlValue = string | boolean;

export class TomlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TomlError';
  }
}

/** Valid TOML that porch's flat config never contains. */
export class TomlSubsetError extends TomlError {
  constructor(message: string) {
    super(message);
    this.name = 'TomlSubsetError';
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

function isAsciiCtrl(c: number): boolean {
  return c <= 0x1f || c === 0x7f;
}

export function parseFlatToml(input: string): Map<string, TomlValue> {
  const src = input.replaceAll('\r\n', '\n');
  const out = new Map<string, TomlValue>();
  let i = 0;
  const n = src.length;
  const line = () => src.slice(0, i).split('\n').length;
  const err = (msg: string): never => {
    throw new TomlError(`${msg} (at line ${line()})`);
  };
  const subset = (msg: string): never => {
    throw new TomlSubsetError(`${msg} (at line ${line()})`);
  };
  const skipWs = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };
  const skipComment = () => {
    if (src[i] !== '#') return;
    i++;
    while (i < n && src[i] !== '\n') {
      const c = src.charCodeAt(i);
      if (isAsciiCtrl(c) && c !== 0x09) err('illegal character in comment');
      i++;
    }
  };
  const hexEscape = (len: number): string => {
    const hex = src.slice(i, i + len);
    if (hex.length !== len || !/^[0-9A-Fa-f]+$/.test(hex)) err('invalid unicode escape');
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) err('escaped character is not a scalar');
    i += len;
    return String.fromCodePoint(cp);
  };
  const readEscape = (multiline: boolean): string => {
    // src[i] is the backslash.
    const e = src[i + 1];
    if (multiline && (e === ' ' || e === '\t' || e === '\n')) {
      // A line-ending backslash: only whitespace may follow it on its line, then every
      // whitespace character and newline up to the next other character is dropped.
      let k = i + 1;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (src[k] !== '\n') err('unescaped backslash in multi-line string');
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
      i = k;
      return '';
    }
    i += 2;
    switch (e) {
      case 'b':
        return '\b';
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'f':
        return '\f';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'u':
        return hexEscape(4);
      case 'U':
        return hexEscape(8);
      default:
        return err('unescaped backslash or invalid escape');
    }
  };
  const basic = (): string => {
    i++; // opening quote
    let out = '';
    for (;;) {
      if (i >= n) err('unterminated string');
      const ch = src[i] as string;
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch === '\\') {
        out += readEscape(false);
        continue;
      }
      const c = src.charCodeAt(i);
      if (isAsciiCtrl(c) && c !== 0x09) err('illegal character in string');
      out += ch;
      i++;
    }
  };
  const literal = (): string => {
    i++;
    const start = i;
    for (;;) {
      if (i >= n) err('unterminated string');
      if (src[i] === "'") {
        i++;
        return src.slice(start, i - 1);
      }
      const c = src.charCodeAt(i);
      if (isAsciiCtrl(c) && c !== 0x09) err('illegal character in string');
      i++;
    }
  };
  const multiline = (quote: '"' | "'"): string => {
    i += 3;
    if (src[i] === '\n') i++;
    let out = '';
    for (;;) {
      if (i >= n) err('unterminated multi-line string');
      const ch = src[i] as string;
      if (src.startsWith(quote.repeat(3), i)) {
        // Up to two extra quotes before the closing three belong to the content.
        let run = 3;
        while (src[i + run] === quote) run++;
        if (run > 5) err('too many quotes at the end of a multi-line string');
        out += quote.repeat(run - 3);
        i += run;
        return out;
      }
      if (quote === '"' && ch === '\\') {
        out += readEscape(true);
        continue;
      }
      const c = src.charCodeAt(i);
      if (isAsciiCtrl(c) && c !== 0x09 && c !== 0x0a) err('illegal character in string');
      out += ch;
      i++;
    }
  };
  const key = (): string => {
    let k: string;
    if (src[i] === '"') {
      if (src.startsWith('"""', i)) err('a key cannot be a multi-line string');
      k = basic();
    } else if (src[i] === "'") {
      if (src.startsWith("'''", i)) err('a key cannot be a multi-line string');
      k = literal();
    } else {
      const start = i;
      while (i < n && BARE_KEY.test(src[i] as string)) i++;
      if (i === start) err('invalid statement');
      k = src.slice(start, i);
    }
    skipWs();
    if (src[i] === '.') subset('dotted keys define tables, which porch config does not use');
    return k;
  };
  const value = (): TomlValue => {
    if (src.startsWith('"""', i)) return multiline('"');
    if (src.startsWith("'''", i)) return multiline("'");
    if (src[i] === '"') return basic();
    if (src[i] === "'") return literal();
    if (src.startsWith('true', i) && !/[A-Za-z0-9_-]/.test(src[i + 4] ?? '')) {
      i += 4;
      return true;
    }
    if (src.startsWith('false', i) && !/[A-Za-z0-9_-]/.test(src[i + 5] ?? '')) {
      i += 5;
      return false;
    }
    if (src[i] === '[' || src[i] === '{') subset('arrays and inline tables are not porch config');
    if (i < n && /[0-9+\-in]/.test(src[i] as string)) {
      subset('numbers and dates are not porch config values');
    }
    return err('invalid value');
  };

  while (i < n) {
    skipWs();
    if (src[i] === '\n') {
      i++;
      continue;
    }
    if (src[i] === '#') {
      skipComment();
      continue;
    }
    if (i >= n) break;
    if (src[i] === '[') subset('tables are not porch config');
    const k = key();
    if (src[i] !== '=') err("expected '=' after a key");
    i++;
    skipWs();
    const v = value();
    if (out.has(k)) err(`cannot overwrite a value (${k})`);
    out.set(k, v);
    skipWs();
    skipComment();
    if (i < n && src[i] !== '\n') err('expected a newline or end of document after a statement');
  }
  return out;
}
