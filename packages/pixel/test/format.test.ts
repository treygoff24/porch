/**
 * The avatar format beyond the corpus files: the built-in table against its corpus file, freeze
 * behaviour the plan states in prose, evaluation-order rules, number judging, and the record
 * reader's id match and bubble name. The corpus pins verdicts; these pin the reasons behind them.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AvatarPack,
  BUILTIN_EMOTES,
  BUILTIN_LIBRARY,
  canonicalAvatar,
  freezeEmote,
  MOTIONS,
  PARTICLES,
  parseAvatar,
  parseEmoteRecord,
  STANDARD_POSES,
} from '../src/index.ts';

const CONTRACT = join(import.meta.dirname, '../../../contract');
const enc = (s: string) => new TextEncoder().encode(s);
const validPack = (name: string): AvatarPack => {
  const r = parseAvatar(new Uint8Array(readFileSync(join(CONTRACT, 'avatars/valid', name))));
  if (r.pack === null) throw new Error(`${name}: ${r.rules.join(',')}`);
  return r.pack;
};

const BLOB = readFileSync(join(CONTRACT, 'avatars/valid/blob.json'), 'utf8');
/** blob.json with its top-level members replaced or added. */
const blobWith = (extra: Record<string, unknown>) =>
  enc(JSON.stringify({ ...JSON.parse(BLOB), ...extra }));

describe('the built-in table', () => {
  const file = JSON.parse(readFileSync(join(CONTRACT, 'emotes/builtin-1.json'), 'utf8')) as {
    library: string;
    poses: string[];
    motions: string[];
    particles: string[];
    emotes: unknown;
  };

  it('equals contract/emotes/builtin-1.json member for member', () => {
    expect(BUILTIN_LIBRARY).toBe(file.library);
    expect(BUILTIN_EMOTES).toEqual(file.emotes);
    expect(STANDARD_POSES).toEqual(file.poses);
    expect(MOTIONS).toEqual(file.motions);
    expect(PARTICLES).toEqual(file.particles);
  });

  it('fits every built-in for every corpus pack, the largest being 783 bytes', () => {
    let largest = 0;
    const packs = readdirSync(join(CONTRACT, 'avatars/valid')).filter((f) =>
      ['trey', 'bolt', 'wisp', 'mochi', 'ribbit', 'blob'].includes(f.replace('.json', '')),
    );
    for (const f of packs) {
      const pack = validPack(f);
      for (const name of Object.keys(BUILTIN_EMOTES)) {
        const shadowed = Object.hasOwn(pack.emotes ?? {}, name);
        const frozen = freezeEmote(shadowed ? { ...pack, emotes: {} } : pack, name);
        expect(frozen?.payloadBytes).toBeLessThanOrEqual(1280);
        largest = Math.max(largest, frozen?.payloadBytes ?? 0);
      }
    }
    expect(largest).toBe(783);
  });
});

describe('freezeEmote', () => {
  it('lets a custom emote shadow the built-in for its own sender only', () => {
    const ribbit = validPack('ribbit.json');
    const bolt = validPack('bolt.json');
    expect(freezeEmote(ribbit, 'hop')?.emote.source).toBe('custom');
    expect(freezeEmote(bolt, 'hop')?.emote.source).toBe('builtin');
    expect(freezeEmote(bolt, 'hop')?.emote.steps).toEqual(BUILTIN_EMOTES.hop?.steps);
  });

  it('refuses an unknown name, including inherited object names', () => {
    const bolt = validPack('bolt.json');
    expect(freezeEmote(bolt, 'moonwalk')).toBeNull();
    expect(freezeEmote(bolt, 'constructor')).toBeNull();
    expect(freezeEmote(bolt, 'toString')).toBeNull();
  });
});

describe('parseAvatar evaluation order', () => {
  it('reports every broken rule when several break', () => {
    const r = parseAvatar(blobWith({ accent: 'Z', format: 2, color: 1 }));
    expect(r.rules).toEqual(['accent-grammar', 'format-unsupported', 'unknown-field']);
  });

  it('skips the emote total when a step ms is bad', () => {
    const steps = (last: unknown) =>
      blobWith({
        emotes: {
          long: {
            steps: [
              { pose: 'idle', ms: 2000 },
              { pose: 'idle', ms: 2000 },
              { pose: 'idle', ms: last },
            ],
          },
        },
      });
    // Summed as written, each of these would total over 4000 ms.
    expect(parseAvatar(steps('x')).rules).toEqual(['type-mismatch']);
    expect(parseAvatar(steps(2001)).rules).toEqual(['step-ms-range']);
    expect(parseAvatar(steps(100.5)).rules).toEqual(['not-integer']);
    // A good third step is summed, and the total is judged.
    expect(parseAvatar(steps(60)).rules).toEqual(['emote-duration']);
  });

  it('does not judge freeze or canonical size when another rule broke', () => {
    // The two corpus packs that break only a size rule, given a bad accent as well: the size rule
    // must then go unjudged.
    for (const [file, sizeRule] of [
      ['canonical-too-large.json', 'canonical-too-large'],
      ['emote-freeze-too-large.json', 'emote-freeze-too-large'],
    ] as const) {
      const raw = readFileSync(join(CONTRACT, 'avatars/invalid', file), 'utf8');
      expect(parseAvatar(enc(raw)).rules).toEqual([sizeRule]);
      const pack = JSON.parse(raw) as { accent: string };
      pack.accent = 'Z';
      expect(parseAvatar(enc(JSON.stringify(pack))).rules, file).toEqual(['accent-grammar']);
    }
  });

  it('checks row grammar before width, and always judges the row count', () => {
    const withRows = (rows: (string | number)[]) => {
      const pack = JSON.parse(BLOB) as { body: { idle: (string | number)[] } };
      pack.body.idle = rows;
      return enc(JSON.stringify(pack));
    };
    const good = (JSON.parse(BLOB) as { body: { idle: string[] } }).body.idle;
    // A one-character row of a bad pixel breaks the grammar only; its width is not judged.
    expect(parseAvatar(withRows(['Z', ...good.slice(1)])).rules).toEqual(['pixel-char']);
    // A valid-grammar row of the wrong width is a size error.
    expect(parseAvatar(withRows(['.', ...good.slice(1)])).rules).toEqual(['body-frame-size']);
    // The row count stands on its own, whatever is wrong inside a row.
    expect(parseAvatar(withRows(['Z', ...good.slice(2)])).rules).toEqual([
      'body-frame-size',
      'pixel-char',
    ]);
    expect(parseAvatar(withRows([7, ...good.slice(2)])).rules).toEqual([
      'body-frame-size',
      'type-mismatch',
    ]);
    expect(parseAvatar(withRows([7, ...good.slice(1)])).rules).toEqual(['type-mismatch']);
  });

  it('accepts nesting 127 deep and refuses 128 as a syntax error', () => {
    // An unknown member holding n - 1 nested arrays, inside the top-level object: n containers.
    const nested = (n: number) =>
      enc(
        BLOB.replace('"format": 1,', `"format": 1, "x": ${'['.repeat(n - 1)}${']'.repeat(n - 1)},`),
      );
    expect(parseAvatar(nested(127)).rules).toEqual(['unknown-field']);
    expect(parseAvatar(nested(128)).rules).toEqual(['json-syntax']);
  });

  it('reports a nested null as null-value, not a type mismatch', () => {
    const r = parseAvatar(blobWith({ emotes: { hop: { steps: [{ pose: 'idle', ms: null }] } } }));
    expect(r.rules).toEqual(['null-value']);
  });

  it('judges numbers by value: 1e0, 100e-2 and 2.5e2 are integers, 1.5e0 is not', () => {
    expect(parseAvatar(blobWith({ format: 1 })).rules).toEqual([]);
    const withFormat = (text: string) => enc(BLOB.replace('"format": 1', `"format": ${text}`));
    expect(BLOB).toContain('"format": 1');
    expect(parseAvatar(withFormat('1e0')).rules).toEqual([]);
    expect(parseAvatar(withFormat('100e-2')).rules).toEqual([]);
    expect(parseAvatar(withFormat('0.01e2')).rules).toEqual([]);
    expect(parseAvatar(withFormat('1.5e0')).rules).toEqual(['not-integer']);
    expect(parseAvatar(withFormat('2.5e2')).rules).toEqual(['format-unsupported']);
    expect(parseAvatar(withFormat('01')).rules).toEqual(['json-syntax']);
  });

  it('rejects a duplicate name in a nested object', () => {
    const text = BLOB.replace('"head": {', '"head": {"idle": [], ');
    expect(parseAvatar(enc(text)).rules).toEqual(['duplicate-key']);
  });

  it('prefers json-syntax over duplicate-key when both occur', () => {
    const text = `${BLOB.replace('"format": 1,', '"format": 1, "format": 1,')},`;
    expect(parseAvatar(enc(text)).rules).toEqual(['json-syntax']);
  });

  it('counts pixels by code point: sixteen é make the right width but bad pixels', () => {
    const pack = JSON.parse(BLOB) as { body: { idle: string[] } };
    pack.body.idle[0] = 'é'.repeat(16);
    expect(parseAvatar(enc(JSON.stringify(pack))).rules).toEqual(['pixel-char']);
  });
});

describe('canonicalAvatar', () => {
  it('re-parses to the same pack and is stable', () => {
    for (const f of ['trey.json', 'bolt.json', 'number-forms.json', 'json-escapes.json']) {
      const pack = validPack(f);
      const c = canonicalAvatar(pack);
      const again = parseAvatar(enc(c));
      expect(again.rules).toEqual([]);
      expect(again.pack === null ? null : canonicalAvatar(again.pack)).toBe(c);
      expect(c).not.toMatch(/\s/);
    }
  });

  it('writes number-forms integers in plain decimal', () => {
    const c = canonicalAvatar(validPack('number-forms.json'));
    expect(c).toContain('"format":1,');
    expect(c).toContain('"ms":250');
    expect(c).not.toMatch(/1\.0|e2/);
  });
});

describe('parseEmoteRecord beyond the corpus', () => {
  const PLAYABLE = readFileSync(join(CONTRACT, 'emotes/records/playable/bolt-hop-builtin.emote'));
  const id = /"id": "([^"]+)"/.exec(PLAYABLE.toString('utf8'))?.[1] ?? '';

  it('checks the id against the filename only when told the filename', () => {
    expect(id).not.toBe('');
    expect(parseEmoteRecord(PLAYABLE, { fileId: id }).verdict).toBe('playable');
    expect(parseEmoteRecord(PLAYABLE, { fileId: `${id}x` })).toMatchObject({
      verdict: 'omitted',
      rule: 'envelope-id-mismatch',
    });
  });

  it('returns the payload and the envelope a renderer needs', () => {
    const r = parseEmoteRecord(PLAYABLE);
    expect(r.emote).toMatchObject({ name: 'hop', source: 'builtin', library: 'builtin-1' });
    expect(r.envelope?.from).toBe('bolt');
    expect(r.name).toBe('hop');
  });

  it('keeps the name for a bubble only when it passes the grammar', () => {
    const dir = join(CONTRACT, 'emotes/records/bubble');
    const bad = parseEmoteRecord(readFileSync(join(dir, 'payload-name-grammar.emote')));
    expect(bad).toMatchObject({ verdict: 'bubble', name: null });
    const ok = parseEmoteRecord(readFileSync(join(dir, 'step-ms-range.emote')));
    expect(ok.verdict).toBe('bubble');
    expect(ok.name).not.toBeNull();
  });

  it('still plays an unknown library version without re-resolving it', () => {
    const text = PLAYABLE.toString('utf8').replace(
      '"library": "builtin-1"',
      '"library": "builtin-9"',
    );
    expect(text).toContain('builtin-9');
    const r = parseEmoteRecord(enc(text));
    expect(r.verdict).toBe('playable');
    expect(r.emote?.library).toBe('builtin-9');
  });

  it('plays a real record nesting 127 deep in an ignored field, and omits one at 128', () => {
    // The header object plus n - 1 nested arrays in a member readers ignore: n containers.
    const record = (n: number) =>
      enc(
        PLAYABLE.toString('utf8').replace(
          '"channel": ',
          `"extra": ${'['.repeat(n - 1)}${']'.repeat(n - 1)},\n  "channel": `,
        ),
      );
    expect(PLAYABLE.toString('utf8')).toContain('"channel": ');
    const ok = parseEmoteRecord(record(127));
    expect(ok).toMatchObject({ verdict: 'playable', rule: null });
    expect(ok.emote?.name).toBe('hop');
    expect(parseEmoteRecord(record(128))).toMatchObject({
      verdict: 'omitted',
      rule: 'envelope-json',
    });
  });

  it('decides the cases the plan leaves open as record.ts documents', () => {
    const text = PLAYABLE.toString('utf8');
    const header = JSON.parse(text.slice(0, text.indexOf('\n---\n'))) as Record<string, unknown>;
    const emote = header.emote as Record<string, unknown>;
    const steps = emote.steps as Record<string, unknown>[];
    const verdict = (h: Record<string, unknown>) => {
      const r = parseEmoteRecord(enc(`${JSON.stringify(h, null, 2)}\n---\n`));
      return `${r.verdict}${r.rule === null ? '' : ` ${r.rule}`}`;
    };
    const withEmote = (e: Record<string, unknown>) => verdict({ ...header, emote: e });
    const withStep = (st: Record<string, unknown> | null) =>
      withEmote({ ...emote, steps: [st, ...steps.slice(1)] });
    expect(verdict(header)).toBe('playable');
    // Envelope.
    expect(verdict({ ...header, sender_provenance: null })).toBe('playable');
    expect(verdict({ ...header, sent: null })).toBe('omitted envelope-fields');
    expect(verdict({ ...header, from: 7 })).toBe('omitted envelope-fields');
    expect(verdict({ ...header, event: null })).toBe('omitted envelope-event');
    const dup = text.replace('"source": "builtin",', '"source": "builtin", "source": "builtin",');
    expect(dup).not.toBe(text);
    expect(parseEmoteRecord(enc(dup)).rule).toBe('envelope-json');
    // Payload.
    expect(verdict({ ...header, emote: null })).toBe('bubble payload-missing');
    expect(verdict({ ...header, emote: [] })).toBe('bubble type-mismatch');
    for (const k of ['name', 'source', 'library', 'at', 'steps', 'frames']) {
      expect(withEmote({ ...emote, [k]: null }), k).toBe('bubble type-mismatch');
    }
    expect(withStep(null)).toBe('bubble type-mismatch');
    for (const k of ['pose', 'ms', 'motion', 'particle']) {
      expect(withStep({ ...steps[0], [k]: null }), k).toBe('bubble type-mismatch');
    }
    expect(withStep({ ms: 500 })).toBe('bubble missing-field');
    expect(withStep({ ...steps[0], ms: 500.5 })).toBe('bubble type-mismatch');
    for (const lib of ['builtin-0', 'builtin-01', 'builtin-one']) {
      expect(withEmote({ ...emote, library: lib }), lib).toBe('bubble payload-library-grammar');
    }
    const frames = emote.frames as { body: Record<string, unknown> };
    expect(withEmote({ ...emote, frames: { ...frames, body: { idle: null } } })).toBe(
      'bubble type-mismatch',
    );
    // ms by value: 250.0 and 2.5e2 are the integer 250.
    for (const form of ['500.0', '5e2']) {
      const t = text.replace('"ms": 500', `"ms": ${form}`);
      expect(t).not.toBe(text);
      expect(parseEmoteRecord(enc(t)).verdict, form).toBe('playable');
    }
  });

  it('checks the header size before parsing it', () => {
    const header = `{"x": "${'a'.repeat(4100)}",}`;
    expect(parseEmoteRecord(enc(`${header}\n---\n`)).rule).toBe('envelope-header-too-large');
    expect(parseEmoteRecord(enc('{"x": 1,}\n---\n')).rule).toBe('envelope-json');
  });
});
