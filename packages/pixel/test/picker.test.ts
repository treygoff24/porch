/**
 * The avatar picker: every pack it can build is valid by the validator post runs, wears an accent
 * Porch accepts, stays under the impersonation cap, and carries emotes that freeze within limits;
 * every refusal names the valid choices; a preset changes only its accent; and the refactor that
 * lets the generator take explicit choices left `defaultAvatar` byte for byte what it was.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { characterAvatar, characterColours, characterInfo } from '../src/generator.ts';
import {
  ACCENT_REFUSED,
  buildAvatar,
  canonicalAvatar,
  defaultAvatar,
  listText,
  PREMADE_EMOTES,
  PRESET_NAMES,
  parseAvatar,
  parseColour,
} from '../src/index.ts';
import { presetPack } from '../src/picker.ts';

const CHARACTERS = ['bot', 'critter', 'shroom', 'kid', 'owl'];
const enc = (s: string) => new TextEncoder().encode(s);
const info = (n: string) => {
  const i = characterInfo(n);
  if (i === undefined) throw new Error(`no ${n}`);
  return i;
};
const ok = (r: ReturnType<typeof buildAvatar>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('defaultAvatar after the picker refactor', () => {
  it('is byte for byte what it was for a sample of ids (hashes taken before the change)', () => {
    const want = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures/default-avatar-hashes.json'), 'utf8'),
    ) as Record<string, string>;
    const ids = Object.keys(want);
    expect(ids.length).toBeGreaterThanOrEqual(100);
    for (const id of ids) {
      const got = createHash('sha256')
        .update(canonicalAvatar(defaultAvatar(id)))
        .digest('hex');
      expect(got, id).toBe(want[id]);
    }
  });
});

describe('every character the picker can build', () => {
  it('is valid for every variant and every allowed accent, with every standard pose', () => {
    let built = 0;
    for (const name of CHARACTERS) {
      const i = info(name);
      for (let v = 0; v < i.variants.length; v++) {
        for (const accent of i.accents) {
          const r = ok(buildAvatar({ character: name, variant: v, accent }));
          expect(parseAvatar(enc(r.text)).rules, `${name} ${v} ${accent}`).toEqual([]);
          expect(ACCENT_REFUSED.has(Number.parseInt(r.pack.accent, 16))).toBe(false);
          for (const pose of ['idle', 'blink', 'talk', 'wave', 'think', 'celebrate', 'sleep']) {
            expect(r.pack.body[pose], pose).toBeDefined();
          }
          built += 1;
        }
      }
    }
    expect(built).toBeGreaterThan(100);
  });

  it('accepts every listed secondary and eye colour that does not clash, and refuses the rest', () => {
    let accepted = 0;
    let refused = 0;
    for (const name of CHARACTERS) {
      const i = info(name);
      for (const accent of i.accents) {
        for (const role of ['secondary', 'eyes'] as const) {
          const all = role === 'secondary' ? i.secondaryOptions : i.eyesOptions;
          const { options } = characterColours(name, Number.parseInt(accent, 16), role);
          for (const colour of all) {
            const r = buildAvatar({ character: name, accent, [role]: colour });
            if (options.includes(colour)) {
              ok(r);
              accepted += 1;
            } else {
              expect(r.ok, `${name} ${role} ${colour} on ${accent}`).toBe(false);
              refused += 1;
            }
          }
        }
      }
    }
    // The set is neither empty nor all-accepting, so both branches above ran.
    expect(accepted).toBeGreaterThan(200);
    expect(refused).toBeGreaterThan(10);
  });

  it('recolours only the eyes with --eyes, and only the second colour with --secondary', () => {
    for (const name of CHARACTERS) {
      const base = characterAvatar(name, 0, 9, [0, 0, 2]);
      const eyed = ok(
        buildAvatar({ character: name, accent: '9', eyes: name === 'bot' ? 'd' : '6' }),
      ).pack;
      const eyeDigit = name === 'bot' ? 'd' : '6';
      let changed = 0;
      for (const [target, frames, other] of [
        ['body', base.body, eyed.body],
        ['head', base.head, eyed.head],
      ] as const) {
        for (const pose of Object.keys(frames)) {
          frames[pose]?.forEach((row, y) => {
            [...row].forEach((c, x) => {
              const d = other[pose]?.[y]?.[x];
              if (c !== d) {
                changed += 1;
                // Never an outline or body pixel: a changed pixel took the eye digit.
                expect(d, `${name} ${target} ${pose} ${x},${y}`).toBe(eyeDigit);
              }
            });
          });
        }
      }
      expect(changed, `${name} eyes changed nothing`).toBeGreaterThan(0);
      // Idle body: the pupils change and the nose and mouth keep their ink.
      const idleChanged = base.body.idle
        .join('')
        .split('')
        .filter((c, i) => c !== eyed.body.idle.join('')[i]).length;
      const pupils: Record<string, number> = { critter: 6, shroom: 4, kid: 2, owl: 2 };
      if (name in pupils) {
        expect(idleChanged, `${name} idle pupils`).toBe(pupils[name]);
        if (name !== 'owl') expect(eyed.body.idle.join('')).toContain('0');
      }

      const alt = characterColours(name, 9, 'secondary').options.find(
        (c) => c !== characterColours(name, 9, 'secondary').default,
      );
      const second = ok(
        buildAvatar({ character: name, accent: '9', secondary: alt as string }),
      ).pack;
      expect(JSON.stringify(second)).not.toBe(JSON.stringify(base));
    }
  });

  it('with no choices builds the same avatar as the explicit defaults', () => {
    for (const name of CHARACTERS) {
      const accent = (characterInfo(name)?.accents ?? [])[0] as string;
      const a = ok(buildAvatar({ character: name, accent }));
      const idx = Number.parseInt(accent, 16);
      const b = ok(
        buildAvatar({
          character: name,
          accent,
          secondary: characterColours(name, idx, 'secondary').default,
          eyes: characterColours(name, idx, 'eyes').default,
        }),
      );
      expect(b.text).toBe(a.text);
    }
  });
});

describe('presets', () => {
  it('are bolt, wisp, mochi, ribbit and blob, never trey', () => {
    expect(PRESET_NAMES).toEqual(['bolt', 'wisp', 'mochi', 'ribbit', 'blob']);
    expect(buildAvatar({ character: 'trey' }).ok).toBe(false);
  });

  it('build as the example packs, byte for byte in content', () => {
    for (const name of PRESET_NAMES) {
      const r = ok(buildAvatar({ character: name }));
      expect(r.pack).toEqual(presetPack(name));
      expect(parseAvatar(enc(r.text)).rules).toEqual([]);
    }
  });

  it('change only the accent under --accent, and refuse the rest of the options', () => {
    for (const name of PRESET_NAMES) {
      const base = presetPack(name);
      const r = ok(buildAvatar({ character: name, accent: 'orange' }));
      expect(r.pack).toEqual({ ...base, accent: '9' });
      for (const extra of [{ variant: 1 }, { secondary: '9' }, { eyes: '9' }]) {
        const bad = buildAvatar({ character: name, ...extra });
        expect(bad.ok, name).toBe(false);
        if (!bad.ok) expect(bad.error).toContain('only --accent');
      }
    }
  });
});

describe('premade emotes', () => {
  it('number four to six and use only standard poses', () => {
    const names = Object.keys(PREMADE_EMOTES);
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names.length).toBeLessThanOrEqual(6);
    for (const e of Object.values(PREMADE_EMOTES)) {
      for (const s of e.def.steps) {
        expect(['idle', 'blink', 'talk', 'wave', 'think', 'celebrate', 'sleep']).toContain(s.pose);
      }
    }
  });

  it('freeze within the limit and validate together on every character and preset', () => {
    const all = Object.keys(PREMADE_EMOTES);
    for (const name of [...CHARACTERS, ...PRESET_NAMES]) {
      const r = ok(buildAvatar({ character: name, emotes: all }));
      // parseAvatar judges emote-freeze-too-large and the emote limits on the stored bytes.
      expect(parseAvatar(enc(r.text)).rules, name).toEqual([]);
      expect(Object.keys(r.pack.emotes ?? {})).toEqual(expect.arrayContaining(all));
    }
  });

  it('refuse an unknown emote, naming the real ones', () => {
    const r = buildAvatar({ character: 'owl', emotes: ['moonwalk'] });
    expect(r.ok).toBe(false);
    if (!r.ok) for (const n of Object.keys(PREMADE_EMOTES)) expect(r.error).toContain(n);
  });
});

describe('refusals say what is valid', () => {
  const bad = (req: Parameters<typeof buildAvatar>[0]) => {
    const r = buildAvatar(req);
    if (r.ok) throw new Error('expected a refusal');
    return r.error;
  };
  it('unknown character lists characters and presets', () => {
    const e = bad({ character: 'dragon' });
    for (const n of [...CHARACTERS, ...PRESET_NAMES]) expect(e).toContain(n);
  });
  it('unknown variant lists the variants', () => {
    const e = bad({ character: 'owl', variant: 5 });
    expect(e).toContain('0 ear tufts');
    expect(e).toContain('1 round chick');
  });
  it('never offers or accepts a refused accent (ink, night, cyan, lemon, red)', () => {
    for (const a of ['0', '1', '5', '8', 'a', 'cyan', 'red', 'lemon', 'ink', 'night']) {
      for (const n of [...CHARACTERS, ...PRESET_NAMES]) {
        expect(buildAvatar({ character: n, accent: a }).ok, `${n} ${a}`).toBe(false);
      }
    }
    expect(listText()).not.toMatch(/\b(cyan|lemon) \(/);
    expect(listText()).not.toMatch(/\b(ink|night|red) \([01a]\): .*--accent/);
  });
  it('unknown colour lists the choices for that part', () => {
    const e = bad({ character: 'kid', eyes: 'plaid' });
    expect(e).toContain('green (6)');
    expect(e).toContain('--eyes');
  });
  it('a colour that would vanish into the body is refused with the reason', () => {
    const e = bad({ character: 'critter', accent: 'tan', secondary: 'tan' });
    expect(e).toContain('vanish');
    expect(e).toContain('pale (3)');
  });
});

describe('colour names', () => {
  it('parse as digits or names in any case', () => {
    expect(parseColour('9')).toBe('9');
    expect(parseColour('Orange')).toBe('9');
    expect(parseColour('F')).toBe('f');
    expect(parseColour('plaid')).toBeUndefined();
  });
});

describe('list', () => {
  it('describes every character with a line and variants, every preset and every emote', () => {
    const t = listText();
    for (const n of [...CHARACTERS, ...PRESET_NAMES, ...Object.keys(PREMADE_EMOTES)]) {
      expect(t).toContain(`${n}:`);
    }
    for (const n of CHARACTERS) expect(t).toContain(info(n).blurb);
    expect(t).not.toContain('trey:');
  });
});
