/**
 * The main screen's colours (design contract, OWN-WORLD): Loom's glass ground with alternate-row
 * scanlines and Loom's state law. Cyan is Trey (youBg behind his messages), green is engaged or
 * ready, magenta is where an agent is headed, red is a warning. Power gold is signed-and-verified
 * only. Caution is a word and a dotted frame, never amber. Every state also carries a word or a
 * glyph, so `NO_COLOR` (the host's monochrome pair) loses nothing.
 */
import { scanlines } from '../grid/grid.ts';

export const K = {
  glass: '#05080b',
  scan: '#0a0f14',
  bezel: '#1d2227',
  bezelHi: '#2b3238',
  data: '#dfe6ea',
  gray: '#8f9aa2',
  grayDim: '#434d56',
  green: '#3ee56d',
  cyan: '#3fd9f2',
  magenta: '#ff5bdc',
  red: '#ff3d32',
  violet: '#cd8bff',
  youBg: '#123440',
  /** Power gold: a signed send that verified, and nothing else. */
  gold: '#ffc400',
  /** The power-up flash, over gold only. */
  flash: '#fff6d8',
} as const;

export const GROUND = scanlines(K.glass, K.scan, K.data);
