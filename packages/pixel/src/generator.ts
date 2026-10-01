/**
 * Default avatars (build plan I3, `defaultAvatar`): a character for every participant who has not
 * drawn their own, chosen deterministically from the participant id so the same agent always looks
 * the same on every host. A remote participant without a relayed avatar gets one of these too
 * (ruling 6).
 *
 * The characters are hand-drawn templates, not noise: a visor robot, a critter (cat, bear or bunny
 * ears), a mushroom sprite, a kid (three hair styles) and an owl. Each has every standard pose, so
 * the built-in emotes act properly on a default avatar (a wave waves, sleep closes its eyes), plus
 * a `blink` frame for the idle eye blink. The id picks the character, its variant, its accent, its
 * secondary colour and its eye colour.
 *
 * Templates use uppercase slot letters for colours the id chooses, and lowercase hex digits for
 * colours that never change. A pose is the idle frame with some rows replaced.
 */
import { ACCENT_ALLOWED, hash32 } from './palette.ts';
import type { AvatarPack, Frames } from './types.ts';

type Rows = readonly string[];
type Patch = Readonly<Record<number, string>>;
type Colours = Readonly<Record<string, string>>;

/** A colour a caller may choose: the slot it fills, what it is called, and what it may be. */
type Role = {
  slot: string;
  label: string;
  /** Candidate palette digits, in listing order; the picker drops any that clash with `clash`. */
  options: readonly string[];
  /** Slots whose colour the choice must differ from, or the part would vanish into its ground. */
  clash: readonly string[];
};

type Template = {
  name: string;
  /** One plain line for `avatar list`. */
  blurb: string;
  /** One label per variant, in `variants` order. */
  variantLabels: readonly string[];
  /** The character's second colour (belly, hair, antenna tip, spots). */
  secondary: Role;
  /** The eye colour; every template has one (slot `Y`, ink by default, or the bot's `E`). */
  eyes: Role;
  /** Rows whose ink `0` pixels are eyes (slot `Y`), for body and head; unset where `eyes.slot` is `E`. */
  eyeRows?: { body: readonly number[]; head: readonly number[] };
  body: Rows;
  bodyPoses: Readonly<Record<string, Patch>>;
  head: Rows;
  headPoses: Readonly<Record<string, Patch>>;
  /** Alternative rows applied to every frame before the pose (ears, hair). */
  variants: readonly { body: Patch; head: Patch }[];
  /** Accents this character never wears (they would hide a fixed colour it relies on). */
  avoid?: readonly number[];
  /** Colours for the slots this character uses, given the accent. */
  colours(accent: number, pick: (n: number) => number): Colours;
};

/** Darker and lighter companions of each allowed accent, as palette digits. */
const SHADE: Readonly<Record<number, string>> = {
  2: '1',
  3: '2',
  4: '1',
  6: '7',
  7: '1',
  9: 'f',
  11: 'c',
  12: '1',
  13: 'b',
  14: 'f',
  15: '1',
};
const LIGHT: Readonly<Record<number, string>> = {
  2: '3',
  3: '3',
  4: 'c',
  6: '3',
  7: '6',
  9: 'e',
  11: 'd',
  12: 'd',
  13: '3',
  14: '3',
  15: 'e',
};

const hex = (n: number) => n.toString(16);
const choose = <T>(xs: readonly T[], n: number): T => xs[n % xs.length] as T;

// ─── The visor robot ────────────────────────────────────────────────────────────────────────────
const BOT: Template = {
  name: 'bot',
  blurb: 'a visor robot with a glowing eye strip and a lit antenna',
  variantLabels: ['one antenna', 'two antennas', 'dish'],
  secondary: {
    slot: 'T',
    label: 'antenna tip',
    options: ['9', 'b', '6', 'd', 'c', '4', '3'],
    clash: [],
  },
  eyes: { slot: 'E', label: 'visor eyes', options: ['6', '9', 'd', 'b', 'c', '4', '3'], clash: [] },
  body: [
    '........T.......',
    '........2.......',
    '.....AAAAAA.....',
    '....AHHAAAAA....',
    '...AAAAAAAAAA...',
    '...A00000000A...',
    '...A0EE00EE0A...',
    '...A0EE00EE0A...',
    '...A00000000A...',
    '...SAAAAAAAAS...',
    '.....222222.....',
    '..2KKAAAAAAKK2..',
    '..2.KAAHHAAK.2..',
    '..2.KAAAAAAK.2..',
    '....KKKKKKKK....',
    '...222....222...',
  ],
  bodyPoses: {
    blink: { 6: '...A00000000A...' },
    talk: { 8: '...A000EE000A...' },
    wave: {
      7: '...A0EE00EE0A.2.',
      8: '...A00000000A.2.',
      9: '...SAAAAAAAAS2..',
      11: '..2KKAAAAAAKK...',
      12: '..2.KAAHHAAK....',
      13: '..2.KAAAAAAK....',
    },
    think: {
      0: '.........T......',
      6: '...A00EE00EEA...',
      7: '...A00000000A...',
      9: '...SAAAAAAAAS...',
      10: '...2.222222.....',
      11: '...2KAAAAAAKK2..',
      12: '....KAAHHAAK.2..',
    },
    celebrate: {
      0: '........T.......',
      6: '...A0E0000E0A...',
      7: '...AE0E00E0EA...',
      8: '..2A00000000A2..',
      9: '..2SAAAAAAAAS2..',
      10: '..2..222222..2..',
      11: '....KAAAAAAK....',
      12: '....KAAHHAAK....',
      13: '....KAAAAAAK....',
    },
    sleep: {
      6: '...A00000000A...',
      7: '...A01100110A...',
    },
  },
  head: [
    '....T...',
    '....2...',
    '.AAAAAA.',
    'AHAAAAAA',
    'A000000A',
    'A0E00E0A',
    'A000000A',
    '.SAAAAS.',
  ],
  headPoses: {
    blink: { 5: 'A000000A', 6: 'A0100100' },
    talk: { 6: 'A00EE00A' },
    sleep: { 5: 'A000000A', 6: 'A011110A' },
  },
  variants: [
    { body: {}, head: {} },
    // A second antenna.
    {
      body: { 0: '....T...T.......', 1: '....2...2.......' },
      head: { 0: '.T....T.', 1: '.2....2.' },
    },
    // A dish on top instead of an antenna.
    { body: { 0: '.......TTT......', 1: '........2.......' }, head: { 0: '...TTT..' } },
  ],
  colours: (a, pick) => ({
    A: hex(a),
    S: SHADE[a] ?? '1',
    H: LIGHT[a] ?? '3',
    K: a === 2 ? '1' : '2',
    E: choose(['6', '9', 'd', 'b', '6'], pick(0)),
    T: choose(['9', 'b', '6', 'd'], pick(1)),
  }),
};

// ─── The critter ───────────────────────────────────────────────────────────────────────────────
const CRITTER: Template = {
  name: 'critter',
  blurb: 'a round critter with a pale belly: cat, bear or bunny',
  variantLabels: ['cat (pointed ears)', 'bear (round ears)', 'bunny (tall ears)'],
  secondary: { slot: 'K', label: 'belly', options: ['3', 'e', 'd', '2'], clash: ['A'] },
  eyes: { slot: 'Y', label: 'pupils', options: ['0', '4', '6', '9', 'b', 'c', 'f'], clash: ['A'] },
  eyeRows: { body: [6, 7], head: [3, 4] },
  body: [
    '................',
    '...A........A...',
    '...AA......AA...',
    '...ACA....ACA...',
    '...AAAAAAAAAA...',
    '..AAAAAAAAAAAA..',
    '..AA30AAAA30AA..',
    '..AA00AAAA00AA..',
    '..ACAAA00AAACA..',
    '..AAAA0AA0AAAA..',
    '...AAAAAAAAAA...',
    '....SAAAAAAS....',
    '...ASKKKKKKSA...',
    '...A.KKKKKK.A...',
    '....SKKKKKKS....',
    '....AA....AA....',
  ],
  bodyPoses: {
    blink: { 6: '..AAAAAAAAAAAA..', 7: '..AA00AAAA00AA..' },
    talk: { 9: '..AAAA0dd0AAAA..' },
    wave: {
      9: '..AAAA0AA0AAAA.A',
      10: '...AAAAAAAAAA.A.',
      11: '....SAAAAAAS.A..',
      12: '...ASKKKKKKSA...',
      13: '...A.KKKKKK.....',
    },
    think: {
      6: '..AAA30AAAA30A..',
      7: '..AAA00AAAA00A..',
      9: '..AAAAA000AAAA..',
      11: '....SAAAAAAS.A..',
      12: '...ASKKKKKKSA...',
      13: '...A.KKKKKK.....',
    },
    celebrate: {
      6: '..AA0AAAAAA0AA..',
      7: '..A0A0AAAA0A0A..',
      9: '..AAAA0000AAAA..',
      10: '.A.AAAAAAAAAA.A.',
      11: '.A..SAAAAAAS..A.',
      12: '....SKKKKKKS....',
      13: '.....KKKKKK.....',
    },
    sleep: {
      6: '..AAAAAAAAAAAA..',
      7: '..A0000AA0000A..',
      9: '..AAAAA00AAAAA..',
    },
  },
  head: [
    '.A....A.',
    '.CA..AC.',
    'AAAAAAAA',
    'A30AA30A',
    'A00AA00A',
    'CAA00AAC',
    'AA0AA0AA',
    '.AAAAAA.',
  ],
  headPoses: {
    blink: { 3: 'AAAAAAAA' },
    talk: { 6: 'AAA00AAA' },
    sleep: { 3: 'AAAAAAAA', 4: '000AA000' },
  },
  variants: [
    // Cat: pointed ears.
    { body: {}, head: {} },
    // Bear: round ears.
    {
      body: { 1: '................', 2: '..AAA......AAA..', 3: '..ACA......ACA..' },
      head: { 0: 'AA....AA', 1: 'AC....CA' },
    },
    // Bunny: tall ears.
    {
      body: {
        0: '...AA......AA...',
        1: '...AC......CA...',
        2: '...AC......CA...',
        3: '...AA......AA...',
      },
      head: { 0: '.AC..CA.', 1: '.AC..CA.' },
    },
  ],
  colours: (a, pick) => ({
    Y: '0',
    A: hex(a),
    S: SHADE[a] ?? '1',
    C: a === 13 ? 'b' : 'd',
    K: a === 3 || a === 14 ? choose(['e', '3'], a === 3 ? 0 : 1) : choose(['3', 'e'], pick(0)),
  }),
};

// ─── The mushroom sprite ───────────────────────────────────────────────────────────────────────
const SHROOM: Template = {
  name: 'shroom',
  blurb: 'a mushroom sprite with a spotted cap and a little face',
  variantLabels: ['spotted', 'big spots', 'tall cap'],
  secondary: {
    slot: 'W',
    label: 'cap spots',
    options: ['3', 'd', 'e', '9', 'b', 'c'],
    clash: ['A'],
  },
  eyes: { slot: 'Y', label: 'eyes', options: ['0', '4', '6', '9', 'b', 'c', 'f'], clash: ['F'] },
  eyeRows: { body: [8, 9], head: [4, 5] },
  body: [
    '................',
    '.....AAAAAA.....',
    '...AAWWAAAAAA...',
    '..AAAWWAAAWWAA..',
    '.AAAAAAAAAWWAAA.',
    '.AAWWAAAAAAAAAA.',
    '.SSSSSSSSSSSSSS.',
    '...FFFFFFFFFF...',
    '...FF0FFFF0FF...',
    '...FF0FFFF0FF...',
    '...FCFF00FFCF...',
    '....FFFFFFFF....',
    '...2.FFFFFF.2...',
    '....2FFFFFF2....',
    '....FF....FF....',
    '...222....222...',
  ],
  bodyPoses: {
    blink: { 8: '...FFFFFFFFFF...', 9: '...FF0FFFF0FF...' },
    talk: { 10: '...FCFF00FFCF...', 11: '....FFF00FFF....' },
    wave: {
      9: '...FF0FFFF0FF.2.',
      10: '...FCFF00FFCF.2.',
      11: '....FFFFFFFF.2..',
      12: '...2.FFFFFF.....',
      13: '....2FFFFFF.....',
    },
    think: {
      8: '...FFF0FFFF0F...',
      9: '...FFF0FFFF0F...',
      10: '...FCFFF0FFCF...',
      11: '....FFFFFFFF2...',
      12: '...2.FFFFFF.2...',
      13: '....2FFFFFF.....',
    },
    celebrate: {
      8: '...F0F0FF0F0F...',
      9: '...FFFFFFFFFF...',
      10: '...FCF0000FCF...',
      11: '.2..FFFFFFFF..2.',
      12: '..2..FFFFFF..2..',
      13: '...2FFFFFFFF2...',
    },
    sleep: {
      8: '...FFFFFFFFFF...',
      9: '...F000FF000F...',
      10: '...FCFF00FFCF...',
    },
  },
  head: [
    '..AAAA..',
    '.AWAAWA.',
    'AAAAAAWA',
    'SSSSSSSS',
    '.F0FF0F.',
    '.F0FF0F.',
    '.CF00FC.',
    '..FFFF..',
  ],
  headPoses: {
    blink: { 4: '.FFFFFF.' },
    talk: { 6: '.C0000C.' },
    sleep: { 4: '.FFFFFF.', 5: '.00FF00.' },
  },
  variants: [
    { body: {}, head: {} },
    // Fewer, bigger spots.
    {
      body: {
        2: '...AAAAAAAAAA...',
        3: '..AAWWWAAAAAAA..',
        4: '.AAAWWWAAAAWWAA.',
        5: '.AAAAAAAAAAWWAA.',
      },
      head: { 1: '.AWWAAA.', 2: 'AAWWAAWA' },
    },
    // A tall cap.
    {
      body: {
        0: '......AAAA......',
        1: '....AAWWAAAA....',
        2: '...AAAWWAAAAA...',
        3: '..AAAAAAAAWWAA..',
      },
      head: { 0: '...AA...', 1: '.AAWAAA.' },
    },
  ],
  avoid: [14],
  colours: (a) => ({
    Y: '0',
    A: hex(a),
    S: SHADE[a] ?? '1',
    W: '3',
    F: a === 14 ? '3' : 'e',
    C: 'd',
  }),
};

// ─── The kid ────────────────────────────────────────────────────────────────────────────────────
const KID: Template = {
  name: 'kid',
  blurb: 'a kid in a shirt in your accent colour, with hair and a face',
  variantLabels: ['short hair', 'spiky hair', 'cap (in the accent colour)'],
  secondary: {
    slot: 'R',
    label: 'hair',
    options: ['f', '9', 'c', '2', 'b', 'd', '6', '4'],
    clash: ['A', 'P'],
  },
  eyes: { slot: 'Y', label: 'eyes', options: ['0', '4', '6', '9', 'b', 'c', 'f'], clash: ['P'] },
  eyeRows: { body: [6, 7], head: [3, 4] },
  body: [
    '................',
    '.....RRRRRR.....',
    '....RRRRRRRR....',
    '...RRRRRRRRRR...',
    '...RRPPPPPPRR...',
    '...RPPPPPPPPR...',
    '...RP0PPPP0PR...',
    '....PPPPPPPP....',
    '....PPP00PPP....',
    '.....PPPPPP.....',
    '....AAAAAAAA....',
    '...AAAHAAAAAA...',
    '...PAAAAAAAAP...',
    '....KKKKKKKK....',
    '....KKK..KKK....',
    '....00....00....',
  ],
  bodyPoses: {
    blink: { 6: '...RPPPPPPPPR...', 7: '....P0PPPP0P....' },
    talk: { 8: '....PPP00PPP....', 9: '.....PP00PP.....' },
    wave: {
      8: '....PPP00PPP..P.',
      9: '.....PPPPPP...A.',
      10: '....AAAAAAAA.A..',
      11: '...AAAHAAAAAA...',
      12: '...PAAAAAAAA....',
    },
    think: {
      6: '...RPP0PPPP0R...',
      8: '....PPPP00PP....',
      9: '.....PPPPPPP....',
      10: '....AAAAAAAAP...',
      11: '...AAAHAAAAAA...',
      12: '...PAAAAAAAA....',
    },
    celebrate: {
      6: '...RP0PPPP0PR...',
      8: '....PP0000PP....',
      9: '..P..PPPPPP..P..',
      10: '..AAAAAAAAAAAA..',
      11: '....AAHAAAAA....',
      12: '....AAAAAAAA....',
    },
    sleep: {
      6: '...RPPPPPPPPR...',
      7: '....000PP000....',
      8: '....PPPPPPPP....',
      9: '.....PP00PP.....',
    },
  },
  head: [
    '.RRRRRR.',
    'RRRRRRRR',
    'RRPPPPRR',
    'RP0PP0PR',
    '.PPPPPP.',
    '.PP00PP.',
    '..PPPP..',
    '..AAAA..',
  ],
  headPoses: {
    blink: { 3: 'RPPPPPPR', 4: '.0PPPP0.' },
    talk: { 5: '.PP00PP.', 6: '..P00P..' },
    sleep: { 3: 'RPPPPPPR', 4: '.00PP00.' },
  },
  variants: [
    // Short and tidy.
    { body: {}, head: {} },
    // Spiky.
    {
      body: {
        0: '....R.R..R.R....',
        1: '....RRRRRRRR....',
        2: '...RRRRRRRRRR...',
      },
      head: { 0: 'R.RRR.R.', 1: 'RRRRRRRR' },
    },
    // A cap in the accent colour.
    {
      body: {
        1: '.....SSSSSS.....',
        2: '....SAAAAAAS....',
        3: '...SAAAAAAAAAAA.',
        4: '...RRPPPPPPRR...',
      },
      head: { 0: '.SSSSSS.', 1: 'SAAAAAAA', 2: 'RRPPPPRR' },
    },
  ],
  colours: (a, pick) => {
    // Hair is never ink or night: both vanish on the glass ground.
    // A shirt in the skin's own colour would read as no shirt at all.
    const skin = a === 14 ? 'f' : a === 15 ? 'e' : choose(['e', 'f'], pick(0));
    const hair = choose(skin === 'f' ? ['2', 'c', '9', 'b'] : ['f', '9', 'c', '2', 'b'], pick(1));
    return {
      Y: '0',
      A: hex(a),
      S: SHADE[a] ?? '1',
      H: LIGHT[a] ?? '3',
      P: skin,
      R: hair === hex(a) ? (skin === 'f' ? '2' : 'f') : hair,
      K: a === 4 ? '1' : choose(['1', '4', '2'], pick(2)),
    };
  },
};

// ─── The owl ────────────────────────────────────────────────────────────────────────────────────
const OWL: Template = {
  name: 'owl',
  blurb: 'a round owl with big eyes, a beak and a feathered belly',
  variantLabels: ['ear tufts', 'round chick (no tufts)'],
  secondary: { slot: 'K', label: 'belly', options: ['e', '3', 'd', '2'], clash: ['A'] },
  eyes: { slot: 'Y', label: 'pupils', options: ['0', '4', '6', '9', 'b', 'c', 'f'], clash: ['A'] },
  eyeRows: { body: [7], head: [3] },
  body: [
    '................',
    '................',
    '....A......A....',
    '....AA....AA....',
    '....AAAAAAAA....',
    '...AAAAAAAAAA...',
    '...A33AAAA33A...',
    '..AA30AAAA03AA..',
    '..AA33ABBA33AA..',
    '..AAAAABBAAAAA..',
    '..SAAKKKKKKAAS..',
    '..SAKKLKKLKKAS..',
    '..SAKKKKKKKKAS..',
    '...AKKLKKLKKA...',
    '....AAAAAAAA....',
    '.....BB..BB.....',
  ],
  bodyPoses: {
    blink: { 6: '...AAAAAAAAAA...', 7: '..AA00AAAA00AA..' },
    talk: { 9: '..AAAAABBAAAAA..', 10: '..SAAKKBBKKAAS..' },
    wave: {
      8: '..AA33ABBA33AA.A',
      9: '..AAAAABBAAAAAA.',
      10: '..SAAKKKKKKAAA..',
      11: '..SAKKLKKLKKA...',
      12: '..SAKKKKKKKKA...',
    },
    think: {
      6: '...A33AAAA33A...',
      7: '..AA03AAAA30AA..',
      9: '..AAAAABBAAAAA..',
    },
    celebrate: {
      6: '...A33AAAA33A...',
      7: 'A.AA00AAAA00AA.A',
      8: 'AAAA33ABBA33AAAA',
      9: '.AAAAAABBAAAAAA.',
      10: '...AAKKKKKKAA...',
      11: '...AKKLKKLKKA...',
      12: '...AKKKKKKKKA...',
    },
    sleep: {
      6: '...AAAAAAAAAA...',
      7: '..AA00AAAA00AA..',
    },
  },
  head: [
    '.A....A.',
    '.AAAAAA.',
    'A33AA33A',
    'A30AA03A',
    'A33BB33A',
    'AAABBAAA',
    'AKKKKKKA',
    '.AAAAAA.',
  ],
  headPoses: {
    blink: { 2: 'AAAAAAAA', 3: 'A00AA00A', 4: 'AAABBAAA' },
    talk: { 5: 'AAABBAAA', 6: 'AKKBBKKA' },
    sleep: { 2: 'AAAAAAAA', 3: 'A00AA00A', 4: 'AAABBAAA' },
  },
  variants: [
    { body: {}, head: {} },
    // No ear tufts: a round chick.
    {
      body: { 2: '................', 3: '.....AAAAAA.....' },
      head: { 0: '........', 1: '..AAAA..' },
    },
  ],
  colours: (a, pick) => ({
    Y: '0',
    A: hex(a),
    S: SHADE[a] ?? '1',
    K: a === 14 ? '3' : choose(['e', '3'], pick(0)),
    L: a === 14 ? '2' : 'f',
    B: a === 9 ? 'f' : '9',
  }),
};

const TEMPLATES: readonly Template[] = [BOT, CRITTER, SHROOM, KID, OWL];

/** The body poses every default avatar has: the standard poses plus the idle eye blink. */
const BODY_POSES = ['idle', 'blink', 'talk', 'wave', 'think', 'celebrate', 'sleep'] as const;
const HEAD_POSES = ['idle', 'blink', 'talk', 'sleep'] as const;

/** Small deterministic generator (mulberry32), seeded from the participant id. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function render(
  rows: Rows,
  variant: Patch,
  pose: Patch,
  colours: Colours,
  eyeRows: readonly number[] = [],
): string[] {
  return rows.map((row, y) =>
    [...(pose[y] ?? variant[y] ?? row)]
      .map((c) => {
        if (c === '0' && eyeRows.includes(y)) return colours.Y ?? '0';
        return c >= 'A' && c <= 'Z' ? (colours[c] ?? '.') : c;
      })
      .join(''),
  );
}

/** Every character and its variant count, in the order `defaultAvatar` indexes them. */
export const DEFAULT_CHARACTERS: readonly { name: string; variants: number }[] = TEMPLATES.map(
  (t) => ({ name: t.name, variants: t.variants.length }),
);

/** Explicit colour choices (palette digits) that replace what the id would have picked. */
export type CharacterChoices = { secondary?: string; eyes?: string };

/** What a caller may choose for one character, for `avatar list` and for checking a choice. */
export type CharacterInfo = {
  name: string;
  blurb: string;
  variants: readonly string[];
  /** Accents the character may wear: allowed ones, never pale (a white block) or its own `avoid`. */
  accents: readonly string[];
  secondaryLabel: string;
  /** Every colour the secondary may be, before any is dropped for matching the accent. */
  secondaryOptions: readonly string[];
  eyesLabel: string;
  eyesOptions: readonly string[];
};

/** The picks the picker uses where the caller made no choice: stable, readable, never random. */
export const PICKER_PICKS: readonly number[] = [0, 0, 2];

const accentsFor = (t: Template) =>
  ACCENT_ALLOWED.filter((a) => a !== 3 && !(t.avoid ?? []).includes(a));

export function characterInfo(name: string): CharacterInfo | undefined {
  const t = TEMPLATES.find((x) => x.name === name);
  if (t === undefined) return undefined;
  return {
    name: t.name,
    blurb: t.blurb,
    variants: t.variantLabels,
    accents: accentsFor(t).map(hex),
    secondaryLabel: t.secondary.label,
    secondaryOptions: t.secondary.options,
    eyesLabel: t.eyes.label,
    eyesOptions: t.eyes.options,
  };
}

/**
 * The digits `role` may take for this character at this accent, default first: the candidates with
 * those that would disappear into a neighbouring colour dropped. The default is always allowed.
 */
export function characterColours(
  name: string,
  accent: number,
  role: 'secondary' | 'eyes',
): { default: string; options: readonly string[] } {
  const t = TEMPLATES.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no default character ${name}`);
  const base = t.colours(accent, (n) => PICKER_PICKS[n] ?? 0);
  const r = t[role];
  const dflt = base[r.slot] ?? '0';
  const grounds = r.clash.map((slot) => base[slot]);
  const options = r.options.filter((c) => !grounds.includes(c));
  return { default: dflt, options: options.includes(dflt) ? options : [dflt, ...options] };
}

/**
 * One character drawn exactly as asked: a template, a variant, an accent (an allowed palette index)
 * and the id-derived picks. `defaultAvatar` is this with every choice taken from the id; the capture
 * sheet calls it directly to show every character.
 */
export function characterAvatar(
  name: string,
  variantIndex: number,
  accent: number,
  picks: readonly number[] = [0, 0, 0],
  choices: CharacterChoices = {},
): AvatarPack {
  const template = TEMPLATES.find((t) => t.name === name);
  if (template === undefined) throw new Error(`no default character ${name}`);
  const variant = template.variants[variantIndex % template.variants.length] ?? {
    body: {},
    head: {},
  };
  const base = template.colours(accent, (n) => picks[n] ?? 0);
  const colours: Colours = {
    ...base,
    ...(choices.secondary === undefined ? {} : { [template.secondary.slot]: choices.secondary }),
    ...(choices.eyes === undefined ? {} : { [template.eyes.slot]: choices.eyes }),
  };
  const body: Record<string, string[]> = {};
  for (const pose of BODY_POSES) {
    body[pose] = render(
      template.body,
      variant.body,
      template.bodyPoses[pose] ?? {},
      colours,
      template.eyeRows?.body,
    );
  }
  const head: Record<string, string[]> = {};
  for (const pose of HEAD_POSES) {
    head[pose] = render(
      template.head,
      variant.head,
      template.headPoses[pose] ?? {},
      colours,
      template.eyeRows?.head,
    );
  }
  return {
    format: 1,
    accent: hex(accent),
    body: body as unknown as Frames,
    head: head as unknown as Frames,
  };
}

/**
 * A default avatar for `seed` (the participant id): deterministic, always valid format 1, with an
 * accent that is never refused, so its tag colour is its own.
 */
export function defaultAvatar(seed: string): AvatarPack {
  const next = rng(hash32(seed));
  const template = choose(TEMPLATES, next());
  const variantIndex = next() % template.variants.length;
  // Pale is allowed as an accent, but a body drawn mostly in it reads as a solid white block,
  // which the design contract forbids; defaults never wear it.
  const accents = ACCENT_ALLOWED.filter((a) => a !== 3 && !(template.avoid ?? []).includes(a));
  const accent = choose(accents, next());
  return characterAvatar(template.name, variantIndex, accent, [next(), next(), next()]);
}
