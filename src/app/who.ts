/**
 * Telling participants apart: the runtime facts an agent reports about itself (directory, model,
 * reasoning effort) and the hint that separates two participants who share a display name.
 *
 * Everything here is text another agent wrote, so it is only ever drawn as a gray hint after a
 * name: nothing takes colour, weight or any other style from it.
 */
import { tildePath } from './derive.ts';

/** What a participant reports: model and effort (the directory is separate, it has a fallback). */
export type RuntimeFacts = { model?: string; effort?: string };

/** One participant in a context, as the tiebreaker needs it. */
export type Person = { id: string; label: string; place?: string | undefined };

/** How one of several same-named participants is told apart. */
export type Tiebreak = {
  /** The directory (home shortened), when it is known. */
  dir?: string;
  /** The last four characters of the id, when the directory does not settle it. */
  suffix?: string;
};

/**
 * A model id as a short readable name: no `claude-` prefix, no trailing date stamp, and a single
 * digit version written with a dot (`claude-opus-4-1-20250805` is `opus-4.1`).
 */
export function shortModel(model: string): string {
  let m = model.trim().replace(/^claude-/i, '');
  m = m.replace(/-\d{8}(?=$|\[)/, '');
  m = m.replace(/(?<!\d)(\d)-(\d)(?!\d)/g, '$1.$2');
  return m === '' ? model.trim() : m;
}

/** The most columns a directory takes in a hint: a long one keeps its tail, which is what tells. */
export const DIR_MAX = 32;

/** A directory for a hint: home shortened, and a long one cut at the front (`…/Code/porch`). */
export function hintDir(path: string, home: string | undefined): string {
  const d = tildePath(path, home);
  const chars = [...d];
  return chars.length <= DIR_MAX ? d : `…${chars.slice(chars.length - (DIR_MAX - 1)).join('')}`;
}

/** The id's tail, enough to tell two sessions of one name apart. */
export function idSuffix(id: string): string {
  return id.slice(-4);
}

/**
 * The parenthetical a mention-picker row carries: `~/Code/porch · opus-5.5 · high`. A part that is
 * unknown is left out, and nothing known gives an empty string (no parentheses at all).
 */
export function runtimeLine(
  place: string | undefined,
  facts: RuntimeFacts | undefined,
  home: string | undefined,
  extra?: string,
): string {
  const parts = [
    place === undefined ? undefined : hintDir(place, home),
    facts?.model === undefined ? undefined : shortModel(facts.model),
    facts?.effort,
    extra,
  ].filter((p): p is string => p !== undefined && p !== '');
  return parts.join(' · ');
}

/**
 * For each participant whose display name another in `people` also has, how to tell it apart: its
 * directory when that is known, and the last four characters of its id when the directory is
 * unknown or another of them shares it. A name only one participant has is not in the result.
 */
export function tiebreaks(
  people: readonly Person[],
  home: string | undefined,
): Map<string, Tiebreak> {
  const byName = new Map<string, Person[]>();
  for (const p of people) {
    const key = p.label.trim().toLowerCase();
    const group = byName.get(key);
    if (group === undefined) byName.set(key, [p]);
    else if (!group.some((g) => g.id === p.id)) group.push(p);
  }
  const out = new Map<string, Tiebreak>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const dirs = group.map((p) => (p.place === undefined ? undefined : hintDir(p.place, home)));
    group.forEach((p, i) => {
      const dir = dirs[i];
      const shared = dir !== undefined && dirs.some((d, j) => j !== i && d === dir);
      out.set(p.id, {
        ...(dir === undefined ? {} : { dir }),
        ...(dir === undefined || shared ? { suffix: idSuffix(p.id) } : {}),
      });
    });
  }
  return out;
}

/** The gray text after a name for a tiebreak: `~/Code/porch`, or `~/Code/porch · 3dee`. */
export function tiebreakText(t: Tiebreak | undefined): string {
  if (t === undefined) return '';
  return [t.dir, t.suffix].filter((p): p is string => p !== undefined).join(' · ');
}
