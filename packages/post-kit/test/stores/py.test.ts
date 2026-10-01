/**
 * The Python-compatible helpers every store relies on, checked against CPython itself.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  PY_WHITESPACE,
  PyJsonEncodeError,
  PyJsonError,
  PyNumberLiteral,
  pyInt,
  pyIsSpace,
  pyJsonDumps,
  pyJsonLoads,
  pyJsonLoadsBytes,
  pyLen,
  pySplitlines,
  pyStrip,
  pyUniversalNewlines,
} from '../../src/stores/py.ts';
import { cleanTemps, pyJson, python3 } from './pyharness.ts';

afterAll(cleanTemps);

describe.skipIf(!python3)('against CPython', () => {
  it('json.loads accepts and refuses the same texts', () => {
    const texts = [
      '{}',
      ' {"a": 1} ',
      '{"a": 1, "a": 2, "b": 3}',
      '[1, -0, 1.5e3, -2E-2, 1e400]',
      'NaN',
      '-Infinity',
      '[Infinity, -NaN]',
      '"\\ud800"',
      '"\\uDC00\\ud83e\\udd8a"',
      '"raw\ttab"',
      '"raw\u007fdel"',
      '"\\u00e9\\n\\/"',
      '"\\x41"',
      '01',
      '1.',
      '.5',
      '+1',
      '[1,]',
      '{"a" 1}',
      '{1: 2}',
      'true false',
      '﻿{}',
      ' {}',
      '\t\n\r {}',
      '"a b"',
      '',
      '[[[[[]]]]]',
      'nul',
      '"unterminated',
    ];
    // The reader keeps no int/float distinction (the stores read strings, ids and booleans), so
    // Python's side folds integral floats to ints before printing.
    const py = pyJson<(string | null)[]>(
      `import math
def fold(v):
    if isinstance(v, float) and math.isfinite(v) and v.is_integer() and abs(v) < 1e16:
        return int(v)
    if isinstance(v, list):
        return [fold(x) for x in v]
    if isinstance(v, dict):
        return {k: fold(x) for k, x in v.items()}
    return v
out = []
for t in INPUT:
    try:
        v = json.loads(t)
        out.append(json.dumps(fold(v), ensure_ascii=True, allow_nan=True))
    except ValueError:
        out.append(None)
print(json.dumps(out))`,
      texts,
    );
    const ts = texts.map((t) => {
      try {
        return canonical(pyJsonLoads(t));
      } catch (err) {
        if (err instanceof PyJsonError) return null;
        throw err;
      }
    });
    expect(ts).toEqual(py);
    expect(ts.filter((v) => v !== null).length).toBeGreaterThan(10);
    expect(ts.filter((v) => v === null).length).toBeGreaterThan(10);
  });

  it('json.dumps writes the same bytes with and without ensure_ascii', () => {
    const values: unknown[] = [
      'plain',
      'quote " backslash \\ slash /',
      '\u0000\u0001\b\f\n\r\t\u001f\u007f\u0080ÿ',
      'é 🦊 👩‍👩‍👧 漢字    ﻿',
      ['nested', { k: 'v', '1': 'x' }],
      null,
      true,
      false,
      0,
      -42,
      9007199254740991,
    ];
    const py = pyJson<[string, string][]>(
      'print(json.dumps([[json.dumps(v, ensure_ascii=True), json.dumps(v, ensure_ascii=False)] for v in INPUT]))',
      values,
    );
    // Python sees JSON objects with the keys in source order; build the same Maps here.
    const ts = values.map((v) => {
      const m = toMaps(v);
      return [pyJsonDumps(m as never, true), pyJsonDumps(m as never, false)];
    });
    expect(ts).toEqual(py);
  });

  it('agrees on whitespace, strip, splitlines and universal newlines', () => {
    const py = pyJson<{ ws: number[]; strip: string; split: string[]; nl: string }>(
      `import io
s = INPUT
print(json.dumps({
  'ws': [c for c in range(0x110000) if chr(c).isspace()],
  'strip': s.strip(),
  'split': s.splitlines(),
  'nl': io.TextIOWrapper(io.BytesIO(s.encode('utf-8', 'surrogatepass')), encoding='utf-8', errors='surrogatepass').read(),
}))`,
      ' \u0085a\rb\r\nc\nd\u000be\u000cf\u001cg\u001dh\u001ei j k l　 ',
    );
    const ws: number[] = [];
    for (let c = 0; c < 0x110000; c++) if (pyIsSpace(String.fromCodePoint(c))) ws.push(c);
    expect(ws).toEqual(py.ws);
    expect([...PY_WHITESPACE].map((c) => c.codePointAt(0))).toEqual(py.ws);
    const s = ' \u0085a\rb\r\nc\nd\u000be\u000cf\u001cg\u001dh\u001ei j k l　 ';
    expect(pyStrip(s)).toBe(py.strip);
    expect(pySplitlines(s)).toEqual(py.split);
    expect(pyUniversalNewlines(s)).toBe(py.nl);
  });

  it('agrees on int() and len()', () => {
    const inputs = ['7', ' 42\n', '٣', '१२', '0x1', '1_000', '1__0', '_1', '-3', '', '1.0', '𝟙𝟘'];
    const py = pyJson<{ i: (number | null)[]; l: number[] }>(
      `def i(s):
    try:
        return int(s)
    except ValueError:
        return None
print(json.dumps({'i': [i(s) for s in INPUT], 'l': [len(s) for s in INPUT]}))`,
      inputs,
    );
    expect(inputs.map((s) => pyLen(s))).toEqual(py.l);
    expect(inputs.map((s) => pyInt(s))).toEqual(py.i);
    // Past 2**53 the value is approximate (ids never get there: they are at most nine digits).
    expect(pyInt('१'.repeat(20))).toBeGreaterThan(2 ** 53);
  });
});

describe('numbers the writer cannot reproduce', () => {
  it('decodes floats and integers past 2^53 as literals, and the writer refuses them unchanged', () => {
    const refused = ['2.0', '1e3', '-0.0', '1.5', '9007199254740993', '-9007199254740992', 'NaN'];
    for (const text of refused) {
      const value = pyJsonLoads(`{"extra": ${text}}`) as Map<string, unknown>;
      expect(value.get('extra')).toBeInstanceOf(PyNumberLiteral);
      expect(() => pyJsonDumps(value as never, false)).toThrow(PyJsonEncodeError);
      expect(() => pyJsonDumps(value as never, false)).toThrow(
        `refusing to write the number ${text}:`,
      );
    }
    // Integers a double holds exactly still round-trip, as Python writes them.
    for (const text of ['0', '-0', '7', '9007199254740991', '-9007199254740991']) {
      const value = pyJsonLoads(`{"extra": ${text}}`) as Map<string, unknown>;
      expect(pyJsonDumps(value as never, false)).toBe(`{"extra": ${text === '-0' ? '0' : text}}`);
    }
    expect(() => pyJsonDumps(1.5, false)).toThrow(PyJsonEncodeError);
  });
});

describe('byte decoding', () => {
  it('skips a UTF-8 BOM and refuses invalid UTF-8', () => {
    expect(pyJsonLoadsBytes(Buffer.from('﻿{"a": "b"}', 'utf8'))).toEqual(new Map([['a', 'b']]));
    expect(() => pyJsonLoadsBytes(Buffer.from([0x22, 0xff, 0x22]))).toThrow();
  });

  it('refuses nesting deeper than Python can parse', () => {
    expect(() => pyJsonLoads(`${'['.repeat(5000)}${']'.repeat(5000)}`)).toThrow(PyJsonError);
  });
});

/** Python `json.dumps(v, ensure_ascii=True, allow_nan=True)` of a parsed value, for comparison. */
function canonical(v: unknown): string {
  if (v instanceof PyNumberLiteral) return canonical(v.value);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    if (Object.is(v, -0)) return '0';
    return Number.isInteger(v) && Math.abs(v) < 1e16 ? String(v) : pyFloat(v);
  }
  if (v instanceof Map) {
    return `{${[...v].map(([k, x]) => `${pyJsonDumps(k, true)}: ${canonical(x)}`).join(', ')}}`;
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(', ')}]`;
  return pyJsonDumps(v as never, true);
}
/** Python's float repr for the few non-integers in the corpus. */
function pyFloat(v: number): string {
  const s = String(v);
  return s.includes('e') ? s.replace(/e([+-])(\d)$/, 'e$10$2') : s;
}
function toMaps(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toMaps);
  if (v !== null && typeof v === 'object') {
    return new Map(Object.entries(v).map(([k, x]) => [k, toMaps(x)]));
  }
  return v;
}
