/**
 * The sprite palette, accent resolution and the impersonation cap (I3). These are what stop an
 * agent's avatar from reading as Trey, as a signed send, or as a warning.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCENT_ALLOWED,
  ACCENT_REFUSED,
  type AvatarPack,
  applyImpersonationCap,
  type Pixel,
  resolveAccent,
  SPRITE_PALETTE,
} from '../src/index.ts';

const pack = (accent: string): AvatarPack => ({
  format: 1,
  accent,
  body: { idle: Array.from({ length: 16 }, () => '.'.repeat(16)) },
  head: { idle: Array.from({ length: 8 }, () => '.'.repeat(8)) },
});

describe('the palette', () => {
  it('is exactly the frozen I3 table', () => {
    expect(SPRITE_PALETTE).toEqual([
      '#0b0e14',
      '#1f2d52',
      '#6e7a88',
      '#d8dfe5',
      '#3c5cf0',
      '#3fd9f2',
      '#3ee56d',
      '#1d7a45',
      '#f2d85a',
      '#ff8a2a',
      '#ff3d32',
      '#ff5bdc',
      '#8f5cf0',
      '#ff9ec8',
      '#e8b089',
      '#7c4a2d',
    ]);
  });

  it('refuses ink, night, cyan, lemon and red as accents', () => {
    expect([...ACCENT_REFUSED].sort((a, b) => a - b)).toEqual([0, 1, 5, 8, 10]);
    expect(ACCENT_ALLOWED).toEqual([2, 3, 4, 6, 7, 9, 11, 12, 13, 14, 15]);
  });
});

describe('resolveAccent', () => {
  it('keeps an allowed accent, owner or not', () => {
    for (const a of ACCENT_ALLOWED) {
      expect(resolveAccent(pack(a.toString(16)), { isOwner: false }, 'x')).toBe(a);
      expect(resolveAccent(pack(a.toString(16)), { isOwner: true }, 'x')).toBe(a);
    }
  });

  it('allows cyan only for the owner', () => {
    expect(resolveAccent(pack('5'), { isOwner: true }, 'trey')).toBe(5);
    const other = resolveAccent(pack('5'), { isOwner: false }, 'mallory');
    expect(ACCENT_ALLOWED).toContain(other);
  });

  it('refuses gold (lemon), red, ink and night even for the owner', () => {
    for (const a of ['8', 'a', '0', '1']) {
      const r = resolveAccent(pack(a), { isOwner: true }, 'trey');
      expect(ACCENT_ALLOWED).toContain(r);
    }
  });

  it('replaces a refused accent deterministically by participant id', () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `agent-${i}`);
    const first = seeds.map((s) => resolveAccent(pack('a'), { isOwner: false }, s));
    const again = seeds.map((s) => resolveAccent(pack('a'), { isOwner: false }, s));
    expect(again).toEqual(first);
    for (const r of first) expect(ACCENT_ALLOWED).toContain(r);
    // Different ids spread over the allowed set rather than collapsing onto one colour.
    expect(new Set(first).size).toBe(ACCENT_ALLOWED.length);
  });
});

describe('the impersonation cap', () => {
  /** A frame with `n` pixels of `colour` and the rest steel. */
  const frame = (size: number, n: number, colour: number): Pixel[][] =>
    Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) => (y * size + x < n ? colour : 2)),
    );
  const count = (px: Pixel[][], c: number) => px.flat().filter((v) => v === c).length;

  it('leaves a body frame with 24 cyan, lemon or red pixels alone', () => {
    for (const c of [5, 8, 10]) {
      const px = frame(16, 24, c);
      expect(applyImpersonationCap(px, 'body', { isOwner: false }, 4)).toEqual(px);
    }
  });

  it('redraws all of them in the accent at 25', () => {
    for (const c of [5, 8, 10]) {
      const out = applyImpersonationCap(frame(16, 25, c), 'body', { isOwner: false }, 4);
      expect(count(out, c)).toBe(0);
      expect(count(out, 4)).toBe(25);
    }
  });

  it('counts the three colours together', () => {
    const px = frame(16, 0, 2);
    const set = (i: number, c: number) => {
      const row = px[Math.floor(i / 16)];
      if (row !== undefined) row[i % 16] = c;
    };
    for (let i = 0; i < 25; i++) set(i, [5, 8, 10][i % 3] ?? 5);
    const out = applyImpersonationCap(px, 'body', { isOwner: false }, 12);
    expect(count(out, 12)).toBe(25);
  });

  it('caps a head frame above 6', () => {
    expect(applyImpersonationCap(frame(8, 6, 5), 'head', { isOwner: false }, 4)).toEqual(
      frame(8, 6, 5),
    );
    expect(count(applyImpersonationCap(frame(8, 7, 5), 'head', { isOwner: false }, 4), 5)).toBe(0);
  });

  it("never touches the owner's frames", () => {
    const px = frame(16, 200, 5);
    expect(applyImpersonationCap(px, 'body', { isOwner: true }, 4)).toEqual(px);
  });

  it('returns a copy and leaves the input unchanged', () => {
    const px = frame(16, 30, 5);
    const before = JSON.stringify(px);
    const out = applyImpersonationCap(px, 'body', { isOwner: false }, 4);
    expect(JSON.stringify(px)).toBe(before);
    expect(out).not.toBe(px);
  });
});
