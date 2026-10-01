/**
 * Premade custom emotes for the avatar picker (`porch-next avatar set --emote <name>`). Each one
 * uses only standard poses, so it works for every character and every preset: a character that
 * lacks a pose falls back to its idle frame. Each is kept to two or three distinct body poses so
 * its frozen copy stays well inside the 1280-byte limit, and ends on a pose that still reads as
 * the emote for people who have asked for reduced motion (they see only the last step).
 *
 * None shares a name with a built-in, so choosing one never changes what `wave` or `celebrate`
 * does. `test/picker.test.ts` freezes every one against every character.
 */
import type { EmoteDef } from './types.ts';

export type PremadeEmote = { about: string; def: EmoteDef };

export const PREMADE_EMOTES: Readonly<Record<string, PremadeEmote>> = {
  cheer: {
    about: 'a happy double hop with sparks',
    def: {
      steps: [
        { pose: 'celebrate', motion: 'hop', particle: 'spark', ms: 375 },
        { pose: 'idle', ms: 125 },
        { pose: 'celebrate', motion: 'hop', particle: 'spark', ms: 375 },
        { pose: 'celebrate', particle: 'spark', ms: 500 },
      ],
    },
  },
  nod: {
    about: 'two small hops, like nodding yes',
    def: {
      steps: [
        { pose: 'idle', motion: 'hop', ms: 250 },
        { pose: 'idle', ms: 125 },
        { pose: 'idle', motion: 'hop', ms: 250 },
        { pose: 'talk', ms: 375 },
      ],
    },
  },
  shrug: {
    about: 'a puzzled wobble with a question mark',
    def: {
      steps: [
        { pose: 'think', motion: 'shake', particle: 'question', ms: 375 },
        { pose: 'idle', ms: 125 },
        { pose: 'think', motion: 'shake', particle: 'question', ms: 375 },
        { pose: 'think', particle: 'question', ms: 500 },
      ],
    },
  },
  sleepy: {
    about: 'a slow blink, then dozing off',
    def: {
      steps: [
        { pose: 'idle', ms: 375 },
        { pose: 'blink', ms: 250 },
        { pose: 'idle', ms: 250 },
        { pose: 'sleep', particle: 'zzz', ms: 1000 },
      ],
    },
  },
  excited: {
    about: 'bouncing and chattering with sparks and a heart',
    def: {
      steps: [
        { pose: 'talk', motion: 'hop', particle: 'spark', ms: 250 },
        { pose: 'celebrate', motion: 'hop', ms: 250 },
        { pose: 'talk', motion: 'hop', particle: 'spark', ms: 250 },
        { pose: 'celebrate', motion: 'hop', particle: 'heart', ms: 250 },
        { pose: 'celebrate', particle: 'heart', ms: 500 },
      ],
    },
  },
  oops: {
    about: 'a startled shake with an exclamation mark',
    def: {
      steps: [
        { pose: 'think', motion: 'shake', particle: 'exclaim', ms: 375 },
        { pose: 'think', motion: 'shake', ms: 250 },
        { pose: 'idle', ms: 125 },
        { pose: 'think', particle: 'question', ms: 500 },
      ],
    },
  },
};
