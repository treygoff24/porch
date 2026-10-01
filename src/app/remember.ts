/**
 * What Porch remembers between runs: the layout (split or single) and which channel was open, in
 * one small JSON file, `layout.json`, in Porch's state directory (`~/.local/state/porch-next`,
 * moved by `PORCH_STATE_DIR`; see `stage/attract.ts`).
 *
 * A file that is missing, unreadable, corrupt or the wrong shape means "remember nothing": the
 * defaults, never a crash. A write is a temporary file renamed over the old one (mode 0600), so a
 * crash mid-write leaves the previous file; a write that fails is silent, because forgetting a
 * layout is not worth a notice.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LAYOUT_FILE = 'layout.json';

/**
 * `split` is Trey's preference (it holds on a narrow terminal too). `panes` are the channels in
 * screen order: one when the screen showed one pane, and then the channel last shown beside it, if
 * any; at most two. `focused` is the index of the pane he was last in.
 */
export type SavedLayout = {
  split: boolean;
  panes: string[];
  focused: number;
};

/** The layout last saved in `dir`, or undefined when there is none worth using. */
export function loadLayout(dir: string): SavedLayout | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, LAYOUT_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.split !== 'boolean') return undefined;
  const panes = Array.isArray(o.panes)
    ? o.panes.filter((c): c is string => typeof c === 'string' && c !== '').slice(0, 2)
    : [];
  const focused =
    typeof o.focused === 'number' && o.focused >= 0 && o.focused < panes.length ? o.focused : 0;
  return { split: o.split, panes, focused: Math.floor(focused) };
}

/** Save `layout` in `dir`; true when it was written. */
export function saveLayout(dir: string, layout: SavedLayout): boolean {
  const target = join(dir, LAYOUT_FILE);
  const temp = join(dir, `.${LAYOUT_FILE}.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify({ version: 1, ...layout })}\n`, { mode: 0o600 });
    renameSync(temp, target);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing more to do.
    }
    return false;
  }
}
