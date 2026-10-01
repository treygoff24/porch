/**
 * Mentions in the composer. Post resolves `@<participant-id>` and not `@Name`, but Trey should see
 * names, so the composer holds the text as drawn (`@Fern`) and remembers which stretches of it are
 * a participant: each is a token `{ start, end, id }` over the drawn text. What is sent, saved as a
 * draft or rescued is the wire form, with each token written as `@<id>`.
 *
 * A token is atomic. Backspace, Delete and Ctrl+W remove all of it. Typing inside it, or deleting
 * part of it, turns what is left into plain text (the words stay; they are no longer a mention).
 * Two participants with one name stay two tokens with two ids, which is why the ids live in the
 * tokens and not in a name lookup. A hand-typed `@Name` that names exactly one participant of the
 * channel is converted on send.
 */
import { mentionSpans } from './derive.ts';

/** A participant mention in the drawn text: `[start, end)` holds `@Name`. */
export type Mention = { readonly start: number; readonly end: number; readonly id: string };

const WORD = /[A-Za-z0-9_]/;

/** Does a word go on at `i`: a letter, digit or `_`, or a `.`, `-` leading into one? */
function continuesWord(text: string, i: number): boolean {
  const c = text[i];
  if (c === undefined) return false;
  if (WORD.test(c)) return true;
  return (c === '.' || c === '-') && WORD.test(text[i + 1] ?? '');
}

/** One line, no controls: a name as the composer draws it. */
export function plainName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Where the tokens sit after `oldText` became `newText`. The edit is the stretch between their
 * common start (no further than `cap`, the caret, so an inserted letter equal to its neighbour is
 * placed where it was typed) and their common end. A token before it stays, one after it moves,
 * one it touches inside is dropped (its text stays, as plain text). A word typed straight after a
 * token also drops it: the word is the user's own.
 */
export function remapMentions(
  mentions: readonly Mention[],
  oldText: string,
  newText: string,
  cap: number = Number.POSITIVE_INFINITY,
): Mention[] {
  if (mentions.length === 0 || oldText === newText) return [...mentions];
  const most = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < most && p < cap && oldText[p] === newText[p]) p++;
  let s = 0;
  while (s < most - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  const oldEnd = oldText.length - s;
  const newEnd = newText.length - s;
  const delta = newText.length - oldText.length;
  const out: Mention[] = [];
  for (const m of mentions) {
    if (m.end <= p) {
      if (m.end === p && newEnd > p && continuesWord(newText, p)) continue;
      out.push(m);
    } else if (m.start >= oldEnd) out.push({ ...m, start: m.start + delta, end: m.end + delta });
  }
  return out;
}

/** The token a backspace at `caret` removes: one the caret is in or right after. */
export function mentionBefore(mentions: readonly Mention[], caret: number): Mention | undefined {
  return mentions.find((m) => m.start < caret && caret <= m.end);
}

/** The token Delete at `caret` removes: one the caret is in or right before. */
export function mentionAfter(mentions: readonly Mention[], caret: number): Mention | undefined {
  return mentions.find((m) => m.start <= caret && caret < m.end);
}

/** The token the caret stands strictly inside, if any. */
export function mentionAround(mentions: readonly Mention[], caret: number): Mention | undefined {
  return mentions.find((m) => m.start < caret && caret < m.end);
}

/** Who a hand-typed `@Name` can name: lower-cased name to the ids that carry it. */
export type NameIndex = ReadonlyMap<string, readonly string[]>;

export function indexNames(people: Iterable<readonly [id: string, name: string]>): NameIndex {
  const out = new Map<string, string[]>();
  for (const [id, name] of people) {
    const key = plainName(name).toLowerCase();
    if (key === '') continue;
    const ids = out.get(key) ?? [];
    if (!ids.includes(id)) ids.push(id);
    out.set(key, ids);
  }
  return out;
}

/** The text with each token as `@<id>`, and each hand-typed `@Name` of exactly one id converted. */
export function toWire(text: string, mentions: readonly Mention[], index?: NameIndex): string {
  const ordered = [...mentions].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const m of ordered) {
    if (m.start < at || m.end > text.length) continue;
    out += handTyped(text, at, m.start, index);
    // Post reads `@id` only as a whole word: keep a word's letters from running into it.
    if (out !== '' && /[A-Za-z0-9._-]$/.test(out)) out += ' ';
    out += `@${m.id}`;
    if (continuesWord(text, m.end)) out += ' ';
    at = m.end;
  }
  return out + handTyped(text, at, text.length, index);
}

/** `text[from, to)` with each `@Name` that names one id written as its id. */
function handTyped(text: string, from: number, to: number, index: NameIndex | undefined): string {
  const segment = text.slice(from, to);
  if (index === undefined || index.size === 0 || !segment.includes('@')) return segment;
  const names = [...index.keys()].sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    const before = i === 0 ? text[from - 1] : segment[i - 1];
    if (c === '@' && (before === undefined || !/[A-Za-z0-9._-]/.test(before))) {
      const rest = segment.slice(i + 1).toLowerCase();
      // The whole segment is only a stretch of the text: a name never runs past its end.
      const name = names.find(
        (n) => rest.startsWith(n) && !continuesWord(segment, i + 1 + n.length),
      );
      const ids = name === undefined ? undefined : index.get(name);
      if (name !== undefined && ids?.length === 1) {
        out += `@${ids[0]}`;
        i += 1 + name.length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The drawn text for a wire body: each `@<id>` of a participant that has a name becomes a token
 * `@Name`. `nameOf` gives the name, or undefined to leave the id as written (Trey's own id, a
 * room, a lineage, or someone with no name).
 */
export function fromWire(
  wire: string,
  nameOf: (id: string) => string | undefined,
): { text: string; mentions: Mention[] } {
  if (!wire.includes('@')) return { text: wire, mentions: [] };
  let text = '';
  let at = 0;
  const mentions: Mention[] = [];
  for (const span of mentionSpans(wire)) {
    const name = nameOf(span.name);
    if (name === undefined) continue;
    const shown = plainName(name);
    if (shown === '') continue;
    text += wire.slice(at, span.start);
    mentions.push({ start: text.length, end: text.length + 1 + shown.length, id: span.name });
    text += `@${shown}`;
    at = span.end;
  }
  return { text: text + wire.slice(at), mentions };
}

/**
 * The same text with each token redrawn under the name `nameOf` gives now, the caret kept where it
 * was in the words around it. A name that changed (a participant took a profile name) shows at
 * once; a token whose name is unknown keeps what it shows.
 */
export function retitle(
  text: string,
  caret: number,
  mentions: readonly Mention[],
  nameOf: (id: string) => string | undefined,
): { text: string; caret: number; mentions: Mention[] } {
  const ordered = [...mentions].sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  let shift = 0;
  let newCaret: number | undefined;
  const next: Mention[] = [];
  for (const m of ordered) {
    const name = nameOf(m.id);
    const shown = name === undefined ? text.slice(m.start, m.end) : `@${plainName(name)}`;
    out += text.slice(at, m.start);
    const start = out.length;
    out += shown;
    if (caret >= m.end) shift += shown.length - (m.end - m.start);
    else if (caret > m.start) newCaret = start + Math.min(caret - m.start, shown.length);
    next.push({ start, end: start + shown.length, id: m.id });
    at = m.end;
  }
  return { text: out + text.slice(at), caret: newCaret ?? caret + shift, mentions: next };
}
