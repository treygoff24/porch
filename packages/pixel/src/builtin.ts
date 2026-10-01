/**
 * The built-in emote table, version `builtin-1` (`contract/emotes/builtin-1.json`). It is written
 * out here rather than read from `contract/` at run time so the package stands alone when Loom
 * adopts it as a git dependency; `test/builtin.test.ts` holds it equal to the corpus file, member
 * for member.
 */
import type { EmoteDef } from './types.ts';

export const BUILTIN_LIBRARY = 'builtin-1' as const;

export const BUILTIN_EMOTES: Readonly<Record<string, EmoteDef>> = {
  wave: {
    steps: [
      { pose: 'wave', ms: 250 },
      { pose: 'idle', ms: 250 },
      { pose: 'wave', ms: 250 },
      { pose: 'idle', ms: 250 },
    ],
  },
  hop: { steps: [{ pose: 'idle', motion: 'hop', ms: 500 }] },
  shake: { steps: [{ pose: 'idle', motion: 'shake', ms: 500 }] },
  flip: {
    steps: [
      { pose: 'idle', motion: 'flip', ms: 250 },
      { pose: 'idle', ms: 250 },
      { pose: 'idle', motion: 'flip', ms: 250 },
      { pose: 'idle', ms: 250 },
    ],
  },
  blink: { steps: [{ pose: 'idle', motion: 'blink', ms: 500 }] },
  celebrate: {
    steps: [
      { pose: 'celebrate', motion: 'hop', particle: 'spark', ms: 750 },
      { pose: 'idle', ms: 250 },
    ],
  },
  think: { steps: [{ pose: 'think', particle: 'question', ms: 1000 }] },
  sleep: { steps: [{ pose: 'sleep', particle: 'zzz', ms: 1500 }] },
  heart: { steps: [{ pose: 'idle', particle: 'heart', ms: 1000 }] },
  spark: { steps: [{ pose: 'celebrate', particle: 'spark', ms: 750 }] },
  zzz: { steps: [{ pose: 'sleep', particle: 'zzz', ms: 1000 }] },
  question: { steps: [{ pose: 'think', particle: 'question', ms: 750 }] },
  exclaim: { steps: [{ pose: 'idle', motion: 'hop', particle: 'exclaim', ms: 500 }] },
};
