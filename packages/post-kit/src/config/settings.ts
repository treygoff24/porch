/**
 * porch-next's own settings, kept out of porch-tui's config (which refuses unknown keys):
 * `~/.config/porch-next/settings.toml`, then environment variables, which win.
 *
 * Two settings. `motion` (build plan ruling 4): `full` (the default), `reduced` (end states only) or
 * `off` (no motion; emotes appear only as their line in the stream). `crossed_strip` (env
 * `PORCH_CROSSED_STRIP`, Trey 2026-10-01): a boolean, false by default, for whether a send that
 * crossed new messages shows the "crossed while you typed" strip. A bad value or an unknown key
 * never stops launch; it comes back as a warning and the default applies.
 */
import { heldReadRegular, MAX_CONFIG_BYTES } from './porch-config.ts';
import { pyHome, pyJoin } from './pypath.ts';
import { parseFlatToml, TomlError } from './toml.ts';

export const MOTION_MODES = ['full', 'reduced', 'off'] as const;
export type Motion = (typeof MOTION_MODES)[number];

export type Settings = { readonly motion: Motion; readonly crossedStrip: boolean };
export const DEFAULT_SETTINGS: Settings = { motion: 'full', crossedStrip: false };

/** An environment value for a boolean setting: true/false, on/off, yes/no or 1/0; else undefined. */
function parseBoolEnv(v: string): boolean | undefined {
  const t = v.trim().toLowerCase();
  if (['true', 'on', 'yes', '1'].includes(t)) return true;
  if (['false', 'off', 'no', '0'].includes(t)) return false;
  return undefined;
}

const isMotion = (v: unknown): v is Motion =>
  typeof v === 'string' && (MOTION_MODES as readonly string[]).includes(v);

export function settingsPath(home?: string): string {
  return pyJoin(pyHome(home), '.config', 'porch-next', 'settings.toml');
}

export function loadSettings(
  options: {
    path?: string;
    env?: Readonly<Record<string, string | undefined>>;
    home?: string;
  } = {},
): { settings: Settings; warnings: string[] } {
  const env = options.env ?? process.env;
  const path = options.path ?? settingsPath(options.home);
  const warnings: string[] = [];
  let motion: Motion = DEFAULT_SETTINGS.motion;
  let crossedStrip = DEFAULT_SETTINGS.crossedStrip;

  let raw: Buffer | null = null;
  try {
    raw = heldReadRegular(path, MAX_CONFIG_BYTES, 'settings').data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`settings at ${path} ignored: ${(err as Error).message}`);
    }
  }
  if (raw !== null) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
      for (const [key, value] of parseFlatToml(text)) {
        if (key === 'crossed_strip') {
          if (typeof value === 'boolean') crossedStrip = value;
          else {
            warnings.push(
              `settings at ${path}: crossed_strip must be true or false; using ${crossedStrip}`,
            );
          }
        } else if (key !== 'motion') {
          warnings.push(`settings at ${path}: unknown key '${key}' ignored`);
        } else if (isMotion(value)) {
          motion = value;
        } else {
          warnings.push(
            `settings at ${path}: motion must be one of ${MOTION_MODES.join(', ')}; using ${motion}`,
          );
        }
      }
    } catch (err) {
      const why = err instanceof TomlError ? err.message : 'not valid UTF-8';
      warnings.push(`settings at ${path} ignored: ${why}`);
    }
  }

  const fromEnv = env.PORCH_MOTION;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (isMotion(fromEnv)) motion = fromEnv;
    else warnings.push(`PORCH_MOTION must be one of ${MOTION_MODES.join(', ')}; using ${motion}`);
  }

  const stripEnv = env.PORCH_CROSSED_STRIP;
  if (stripEnv !== undefined && stripEnv !== '') {
    const parsed = parseBoolEnv(stripEnv);
    if (parsed !== undefined) crossedStrip = parsed;
    else warnings.push(`PORCH_CROSSED_STRIP must be true or false; using ${crossedStrip}`);
  }
  return { settings: { motion, crossedStrip }, warnings };
}
