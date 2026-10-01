/**
 * The frozen contract corpus (build plan I0), byte for byte: every avatar file gets exactly its
 * rule-id set, every freeze fixture is reproduced as exact bytes, and every emote record gets its
 * verdict and rule. The expected values come from the filenames and the corpus READMEs, never from
 * this implementation.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalAvatar,
  freezeEmote,
  frozenPayload,
  parseAvatar,
  parseEmoteRecord,
} from '../src/index.ts';

const CONTRACT = join(import.meta.dirname, '../../../contract');
const bytes = (...p: string[]) => new Uint8Array(readFileSync(join(CONTRACT, ...p)));
const list = (...p: string[]) =>
  readdirSync(join(CONTRACT, ...p))
    .filter((f) => !f.startsWith('.'))
    .sort();

/** Canonical sizes from `contract/avatars/README.md`'s valid table. */
const CANONICAL_BYTES: Record<string, number> = {
  'trey.json': 2369,
  'bolt.json': 2729,
  'wisp.json': 2398,
  'mochi.json': 1991,
  'ribbit.json': 1770,
  'blob.json': 453,
  'limit-frames-and-steps.json': 6387,
  'limit-emote-count.json': 1513,
  'limit-freeze-1280.json': 1412,
  'limit-canonical-16384.json': 16384,
  'limit-raw-32768.json': 453,
  'json-escapes.json': 453,
  'number-forms.json': 527,
};

describe('avatar corpus: valid packs', () => {
  const files = list('avatars', 'valid');
  it('lists every valid file the README names, and no other', () => {
    expect(files).toEqual(Object.keys(CANONICAL_BYTES).sort());
  });
  for (const f of files) {
    it(`${f} reports no rules and canonicalizes to the README's size`, () => {
      const r = parseAvatar(bytes('avatars', 'valid', f));
      expect(r.rules).toEqual([]);
      expect(r.pack).not.toBeNull();
      if (r.pack === null) return;
      expect(Buffer.byteLength(canonicalAvatar(r.pack))).toBe(CANONICAL_BYTES[f]);
    });
  }
});

describe('avatar corpus: invalid packs report exactly their one rule', () => {
  const files = list('avatars', 'invalid');
  it('holds 38 files', () => {
    expect(files).toHaveLength(38);
  });
  for (const f of files) {
    const rule = f.replace(/\.json$/, '').split('--')[0];
    it(`${f} -> {${rule}}`, () => {
      const r = parseAvatar(bytes('avatars', 'invalid', f));
      expect(r.rules).toEqual([rule]);
      expect(r.pack).toBeNull();
    });
  }
});

describe('freeze corpus: exact bytes', () => {
  const files = list('emotes', 'freeze');
  it('holds 10 fixtures', () => {
    expect(files).toHaveLength(10);
  });
  const SOURCES: Record<string, 'custom' | 'builtin'> = {
    'blob.celebrate.json': 'builtin',
    'blob.wave.json': 'builtin',
    'bolt.beep-boop.json': 'custom',
    'bolt.hop.json': 'builtin',
    'mochi.knead.json': 'custom',
    'ribbit.hop.json': 'custom',
    'ribbit.ribbit.json': 'custom',
    'trey.thumbs-up.json': 'custom',
    'trey.wave.json': 'builtin',
    'wisp.boo.json': 'custom',
  };
  for (const f of files) {
    const [packName, emoteName] = f.replace(/\.json$/, '').split('.') as [string, string];
    it(`${f} is the frozen payload of ${emoteName} for ${packName}`, () => {
      const expected = readFileSync(join(CONTRACT, 'emotes', 'freeze', f), 'utf8');
      const { pack } = parseAvatar(bytes('avatars', 'valid', `${packName}.json`));
      expect(pack).not.toBeNull();
      if (pack === null) return;
      const frozen = freezeEmote(pack, emoteName);
      expect(frozen).not.toBeNull();
      if (frozen === null) return;
      expect(frozenPayload(frozen.emote)).toBe(expected);
      expect(frozen.payloadBytes).toBe(Buffer.byteLength(expected));
      expect(frozen.emote.source).toBe(SOURCES[f]);
      expect(frozen.emote.library).toBe('builtin-1');
      expect(frozen.emote.name).toBe(emoteName);
    });
  }
});

describe('emote record corpus', () => {
  for (const verdict of ['playable', 'bubble', 'omitted'] as const) {
    const files = list('emotes', 'records', verdict);
    it(`${verdict}/ is not empty`, () => {
      expect(files.length).toBeGreaterThan(0);
    });
    for (const f of files) {
      const rule = verdict === 'playable' ? null : (f.replace(/\.emote$/, '').split('--')[0] ?? '');
      it(`${verdict}/${f} -> ${verdict}${rule === null ? '' : ` (${rule})`}`, () => {
        const r = parseEmoteRecord(bytes('emotes', 'records', verdict, f));
        expect({ verdict: r.verdict, rule: r.rule }).toEqual({ verdict, rule });
        if (verdict === 'playable') expect(r.emote).not.toBeNull();
        else expect(r.emote).toBeNull();
      });
    }
  }
});
