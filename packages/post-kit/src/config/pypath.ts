/**
 * POSIX path strings exactly as Python's `pathlib` prints them. porch-tui hashes `str(Path(…))` of
 * its configured directories into the drafts namespace and compares them as strings with post's
 * owner record, so porch-next must produce the same string for the same configured value:
 * `/a//b/./c/` is `/a/b/c`, a leading `//` (exactly two slashes) survives, and `..` is kept.
 */
import { homedir, userInfo } from 'node:os';

export class PathHomeError extends Error {
  constructor(message = 'Could not determine home directory.') {
    super(message);
    this.name = 'PathHomeError';
  }
}

/** `str(PurePosixPath(raw))`. */
export function pyPath(raw: string): string {
  if (raw === '') return '.';
  let root = '';
  if (raw.startsWith('/')) root = raw.startsWith('//') && !raw.startsWith('///') ? '//' : '/';
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  const body = parts.join('/');
  if (root === '') return body === '' ? '.' : body;
  return root + body;
}

/** `str(Path(a) / b)` for a relative `b`. */
export function pyJoin(a: string, ...rest: string[]): string {
  let out = pyPath(a);
  for (const b of rest) {
    const p = pyPath(b);
    if (p.startsWith('/')) out = p;
    else if (p !== '.') out = out === '.' ? p : out.endsWith('/') ? out + p : `${out}/${p}`;
  }
  return out;
}

/** `Path.is_absolute()` on a pathlib string. */
export function pyIsAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/**
 * `str(Path(raw).expanduser())`. Only a leading `~` or `~<name>` component expands; `~` uses
 * `$HOME` when set (as Python does).
 *
 * Known difference from porch-tui (coordinator ruling, 2026-09-30): `~<name>` expands only for the
 * current user. Python looks any user's home up with `getpwnam`; Node has no such call, so
 * `~otheruser/...` is refused with a message naming the form, never guessed.
 */
export function pyExpandUser(raw: string, home: string | undefined = process.env.HOME): string {
  const p = pyPath(raw);
  if (p.startsWith('/') || !p.startsWith('~')) return p;
  const slash = p.indexOf('/');
  const first = slash === -1 ? p : p.slice(0, slash);
  const tail = slash === -1 ? '' : p.slice(slash + 1);
  let dir: string;
  if (first === '~') {
    dir = home ?? homedir();
  } else {
    let me: { username: string; homedir: string };
    try {
      me = userInfo();
    } catch {
      throw new PathHomeError();
    }
    if (first.slice(1) !== me.username) {
      throw new PathHomeError(
        `cannot expand ${first}: porch-next expands only ~ and ~${me.username} (your own home); write ${first}'s home as an absolute path`,
      );
    }
    dir = me.homedir;
  }
  // Python strips trailing slashes from the home directory, then re-parses the result.
  const trimmed = dir.replace(/\/+$/, '');
  const base = pyPath(trimmed === '' ? '/' : trimmed);
  return tail === '' ? base : pyJoin(base, tail);
}

/** `os.path.abspath(p)`: joined onto the working directory, then `normpath` (which folds `..`). */
export function pyAbspath(p: string, cwd: string = process.cwd()): string {
  const joined = p.startsWith('/') ? p : `${cwd}/${p}`;
  let root = '';
  if (joined.startsWith('/')) {
    root = joined.startsWith('//') && !joined.startsWith('///') ? '//' : '/';
  }
  const out: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (root === '') out.push('..');
      continue;
    }
    out.push(part);
  }
  return root + out.join('/') || '.';
}

/** `str(Path.home())`. */
export function pyHome(home: string | undefined = process.env.HOME): string {
  return pyExpandUser('~', home);
}
