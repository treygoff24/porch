/**
 * The app as a host scene: the host calls in with a key, a paste, a click, a focus change or a
 * frame, and the scene hands each to the model and the view. Every call attaches the host first,
 * so the model can ask for frames and bursts from the moment the scene is first touched.
 *
 * The scene keeps the last grid it drew. When post's data moves (a poll, a verdict), the model
 * asks it whether drawing now would change any displayed cell, and asks the host for a frame only
 * then: an update to a channel nothing on screen shows costs a draw into a scratch grid, not a
 * render pass. (The host compares cells this way for animation ticks; data changes come through
 * the model, so the comparison for them is made here.)
 */
import type { KeyEvent } from '@opentui/core';
import { Grid, type HitAction, sameCell } from '../grid/grid.ts';
import type { HostApi, Scene } from '../host/grid-host.ts';
import { dispatchKey, toKey } from './keys.ts';
import type { AppModel } from './model.ts';
import { currentStage } from './registry.ts';
import { GROUND } from './theme.ts';
import { drawScreen } from './view.ts';

export function appScene(m: AppModel): Scene {
  let last: Grid | undefined;
  m.frameNeeded = () => {
    if (last === undefined) return true;
    const trial = new Grid(last.cols, last.rows, GROUND);
    drawScreen(trial, m);
    return differs(last, trial);
  };
  return {
    ground: GROUND,
    draw(grid, host) {
      m.attach(host);
      drawScreen(grid, m);
      last = grid;
    },
    key(key: KeyEvent, host: HostApi) {
      m.attach(host);
      return dispatchKey(m, toKey(key));
    },
    paste(text, host) {
      m.attach(host);
      m.stageEvent({ kind: 'input' });
      if (m.current === undefined && m.overlay === undefined) {
        m.status('open a channel first: Ctrl+K lists them', 'caution');
        return true;
      }
      void m.paste(text);
      return true;
    },
    hit(action: HitAction, host) {
      m.attach(host);
      return click(m, action);
    },
    focus(focused, host) {
      m.attach(host);
      m.focus(focused);
      return false;
    },
  };
}

/** A click on something the frame registered. */
export function click(m: AppModel, action: HitAction): boolean {
  const data = action.data;
  if (action.id.startsWith('stage:')) {
    const stage = currentStage();
    if (stage === undefined) return false;
    if (stage.hit !== undefined) stage.hit(action, m.state());
    else stage.key?.({ name: 'click', ctrl: false, alt: false, shift: false }, m.state());
    m.touch();
    return true;
  }
  switch (action.id) {
    case 'lane':
      if (typeof data === 'string') void m.openChannel(data);
      return true;
    case 'overlay':
      if (typeof data === 'string') m.openOverlay(data);
      return true;
    case 'next-needs':
      m.nextNeedsYou();
      return true;
    case 'mode':
      m.toggleSigned();
      return true;
    case 'layout':
      m.toggleSplit();
      return true;
    case 'pane':
      if (typeof data === 'number' && data !== m.focusedPane) m.focusPane(data);
      return true;
    case 'record': {
      const at = data as { pane: number; id: string } | undefined;
      if (at === undefined) return false;
      if (at.pane !== m.focusedPane) m.focusPane(at.pane);
      m.pick(m.pane().pick === at.id ? undefined : at.id);
      m.ensurePick = false;
      return true;
    }
    case 'reply': {
      const at = data as { pane: number; id: string } | undefined;
      if (at === undefined) return false;
      if (at.pane !== m.focusedPane) m.focusPane(at.pane);
      m.setReply(at.id);
      m.pick(undefined);
      return true;
    }
    case 'latest':
      if (typeof data === 'number' && data !== m.focusedPane) m.focusPane(data);
      m.jumpLatest();
      return true;
    case 'older':
      if (typeof data === 'number' && data !== m.focusedPane) m.focusPane(data);
      void m.loadOlder();
      return true;
    case 'ack':
      if (typeof data === 'number' && data !== m.focusedPane) m.focusPane(data);
      void m.acknowledge();
      return true;
    default:
      return false;
  }
}

/** Whether any cell of `b` would display differently from `a` (same size; a resize always draws). */
function differs(a: Grid, b: Grid): boolean {
  if (a.cols !== b.cols || a.rows !== b.rows) return true;
  for (let y = 0; y < a.rows; y++)
    for (let x = 0; x < a.cols; x++) {
      const p = a.at(x, y);
      const q = b.at(x, y);
      if (p === undefined || q === undefined || !sameCell(p, q)) return true;
    }
  return false;
}
