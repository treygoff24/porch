/**
 * The colours the stage and overlays draw in: Loom's cockpit state law as the design contract
 * carries it over (OWN-WORLD), plus Porch's power gold. The values the main screen shares come
 * from the core's theme (`../theme.ts`), the single source; only the stage's own extras (panel,
 * deep, white, orange, pink, blue) are defined here, each named in the contract or the Arcade
 * prototype.
 *
 * - Cyan is Trey. Green is engaged or ready. Magenta is where an agent is headed (the task line).
 *   Red is warning. Gold is signed-and-verified only, and the power-up send is its one moment here.
 * - Caution is a word plus a dotted frame, never amber.
 * - Colour never carries meaning alone (NO_COLOR): every state below also has a word or a glyph.
 */
import { K } from '../theme.ts';

export const T = {
  glass: K.glass,
  scan: K.scan,
  panel: '#0d1319',
  bezel: K.bezel,
  bezelHi: K.bezelHi,
  deep: '#14184a',
  white: '#eef2f4',
  data: K.data,
  gray: K.gray,
  grayDim: K.grayDim,
  green: K.green,
  cyan: K.cyan,
  magenta: K.magenta,
  red: K.red,
  violet: K.violet,
  orange: '#ff8a2a',
  pink: '#ff9ec8',
  blue: '#3c5cf0',
  youBg: K.youBg,
  /** Power gold: a signed send's power-up, and nothing else. */
  gold: K.gold,
  /** The power-up's flash white, alternating with gold. */
  flash: K.flash,
} as const;

/**
 * The pixel title's rows, top to bottom: an arcade sunset from orange down to blue. No cyan (it is
 * Trey), gold (signed) or red (warning) in the title.
 */
export const TITLE_ROWS = [T.orange, T.pink, T.magenta, T.violet, T.blue] as const;
