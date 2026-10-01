/**
 * Default avatars: deterministic from the participant id, always a valid pack by the same validator
 * post runs, never wearing a refused accent, never tripping the impersonation cap, carrying every
 * standard pose so the built-in emotes act properly, and varied enough that a room of agents is not
 * a room of twins. Whether they are charming is judged on the capture sheet, not here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { characterAvatar, DEFAULT_CHARACTERS } from '../src/generator.ts';
import {
  ACCENT_ALLOWED,
  ACCENT_REFUSED,
  applyImpersonationCap,
  BUILTIN_EMOTES,
  canonicalAvatar,
  defaultAvatar,
  framePixels,
  freezeEmote,
  parseAvatar,
  resolveAccent,
  STANDARD_POSES,
} from '../src/index.ts';

const SEEDS = Array.from({ length: 400 }, (_, i) => `agent-${i.toString(36)}-${i * 7919}`);
const enc = (s: string) => new TextEncoder().encode(s);

describe('defaultAvatar', () => {
  it('is deterministic: the same id gives the same bytes', () => {
    for (const s of SEEDS.slice(0, 50)) {
      expect(canonicalAvatar(defaultAvatar(s))).toBe(canonicalAvatar(defaultAvatar(s)));
    }
  });

  it('passes parseAvatar for every seed, with every frame post would store', () => {
    for (const s of SEEDS) {
      const pack = defaultAvatar(s);
      const r = parseAvatar(enc(canonicalAvatar(pack)));
      expect(r.rules, s).toEqual([]);
      expect(r.pack).toEqual(pack);
    }
  });

  it('has every standard pose and a blink, for body and head', () => {
    for (const s of SEEDS.slice(0, 40)) {
      const pack = defaultAvatar(s);
      for (const pose of [...STANDARD_POSES, 'blink']) expect(pack.body[pose], pose).toBeDefined();
      for (const pose of ['idle', 'blink', 'talk', 'sleep']) expect(pack.head[pose]).toBeDefined();
    }
  });

  it('wears an accent that is never refused, so it resolves to itself', () => {
    for (const s of SEEDS) {
      const pack = defaultAvatar(s);
      const a = Number.parseInt(pack.accent, 16);
      expect(ACCENT_REFUSED.has(a)).toBe(false);
      expect(resolveAccent(pack, { isOwner: false }, s)).toBe(a);
    }
  });

  it('never trips the impersonation cap', () => {
    for (const s of SEEDS) {
      const pack = defaultAvatar(s);
      for (const [target, frames] of [
        ['body', pack.body],
        ['head', pack.head],
      ] as const) {
        for (const rows of Object.values(frames)) {
          const px = framePixels(rows);
          expect(applyImpersonationCap(px, target, { isOwner: false }, 4)).toEqual(px);
        }
      }
    }
  });

  it('never uses ink or night hair, eyes, or bodies large enough to vanish on the ground', () => {
    // At least half of each idle body's opaque pixels are colours that read on #05080b.
    for (const s of SEEDS) {
      const px = framePixels(defaultAvatar(s).body.idle).flat();
      const opaque = px.filter((v) => v !== null);
      const dark = opaque.filter((v) => v === 0 || v === 1);
      expect(dark.length / opaque.length, s).toBeLessThan(0.5);
    }
  });

  it('spreads ids over every character and many looks', () => {
    const packs = SEEDS.map(defaultAvatar);
    const looks = new Set(packs.map((p) => p.body.idle.join('')));
    expect(looks.size).toBeGreaterThan(SEEDS.length / 3);
    const accents = new Set(packs.map((p) => p.accent));
    expect(accents.size).toBeGreaterThanOrEqual(ACCENT_ALLOWED.length - 1);
    // Every character's idle silhouette shows up at least once.
    for (const c of DEFAULT_CHARACTERS) {
      const shape = (rows: readonly string[]) => rows.map((r) => r.replace(/[^.]/g, '#')).join('');
      const shapes = new Set(
        Array.from({ length: c.variants }, (_, v) =>
          shape(characterAvatar(c.name, v, 4).body.idle),
        ),
      );
      expect(
        packs.some((p) => shapes.has(shape(p.body.idle))),
        c.name,
      ).toBe(true);
    }
  });

  it('freezes every built-in emote within the payload limit', () => {
    for (const s of SEEDS.slice(0, 60)) {
      const pack = defaultAvatar(s);
      for (const name of Object.keys(BUILTIN_EMOTES)) {
        const f = freezeEmote(pack, name);
        expect(f?.payloadBytes).toBeLessThanOrEqual(1280);
      }
    }
  });
});

describe('every character, variant and accent', () => {
  it('is a valid pack', () => {
    for (const c of DEFAULT_CHARACTERS) {
      for (let v = 0; v < c.variants; v++) {
        for (const a of ACCENT_ALLOWED) {
          for (const picks of [
            [0, 0, 0],
            [1, 1, 1],
            [2, 3, 4],
            [3, 4, 2],
          ]) {
            const r = parseAvatar(enc(canonicalAvatar(characterAvatar(c.name, v, a, picks))));
            expect(r.rules, `${c.name}/${v}/${a}`).toEqual([]);
          }
        }
      }
    }
  });
});

describe('the example packs', () => {
  const EXAMPLES = join(import.meta.dirname, '../examples');
  const CORPUS = join(import.meta.dirname, '../../../contract/avatars/valid');

  it('are the six hand-drawn corpus packs, byte for byte', () => {
    const files = readdirSync(EXAMPLES).sort();
    expect(files).toEqual(
      ['blob', 'bolt', 'mochi', 'ribbit', 'trey', 'wisp'].map((n) => `${n}.json`),
    );
    for (const f of files) {
      expect(readFileSync(join(EXAMPLES, f)).equals(readFileSync(join(CORPUS, f))), f).toBe(true);
    }
  });
});
