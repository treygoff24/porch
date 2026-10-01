/**
 * The one keybinding precedence table (build plan, "Keybindings"). A key is offered to each layer
 * in order and the first that handles it wins:
 *
 *   1 global · 2 attract screen · 3 flourish · 4 open overlay · 5 mentions picker · 6 app chords ·
 *   7 pick mode · 8 empty composer · 9 composer
 *
 * Layers 2 and 3 belong to the stage (`Stage.key`): the attract screen consumes the key; a
 * flourish skips to its end state and passes the key on. Features add chords and pick keys through
 * `registerKeyBinding`, offered before the core's own at layers 6 and 7.
 */
import type { KeyEvent } from '@opentui/core';
import { graphemes } from '../grid/text.ts';
import * as edit from './composer.ts';
import type { AppModel } from './model.ts';
import { command, currentStage, type Key, keyBindings, overlay } from './registry.ts';
import { composerWidth } from './view.ts';

/** OpenTUI's key event as the registries' `Key`: Alt is meta or option, text only when typed. */
export function toKey(
  e: Pick<KeyEvent, 'name' | 'ctrl' | 'meta' | 'shift' | 'option' | 'sequence'>,
): Key {
  const alt = e.meta || e.option;
  const key: Key = { name: e.name, ctrl: e.ctrl, alt, shift: e.shift };
  const seq = e.sequence;
  if (!e.ctrl && !alt && seq !== '' && printable(seq) && graphemes(seq).length >= 1) key.text = seq;
  return key;
}

/** Text with no control character in it (an unmapped escape is not typing). */
function printable(s: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
  return !/[\u0000-\u001f\u007f-\u009f]/.test(s);
}

const is = (k: Key, name: string, mods: { ctrl?: boolean; alt?: boolean } = {}) =>
  k.name === name && k.ctrl === (mods.ctrl ?? false) && k.alt === (mods.alt ?? false);

const isEnter = (k: Key) => k.name === 'return' || k.name === 'enter';

/** Run `f` and report the key handled. */
const did = (f: () => void): true => {
  f();
  return true;
};

/**
 * Offer `k` to every layer in order. Returns false when no layer took it (no frame is needed).
 */
export function dispatchKey(m: AppModel, k: Key): boolean {
  const s = () => m.state();
  // Every key is input to the stage (its blink window and the attract screen's idle timer),
  // the global ones included.
  m.stageEvent({ kind: 'input' });
  // 1. Global.
  if (k.ctrl && !k.alt && (k.name === 'q' || k.name === 'c')) {
    void m.quit();
    return true;
  }
  if (k.name === 'f1' && !k.ctrl && !k.alt) {
    if (m.overlay === 'help' || m.helpFallback) m.closeOverlay();
    else {
      if (m.overlay !== undefined) m.closeOverlay();
      m.openOverlay('help');
    }
    return true;
  }
  // 2 and 3. The stage: the attract screen consumes; a flourish skips, then passes.
  const stage = currentStage();
  if (stage?.key !== undefined && stage.key(k, s()) === 'handled') {
    m.touch();
    return true;
  }
  // 4. An open overlay owns every remaining key; Esc closes it.
  if (m.overlay !== undefined) {
    if (is(k, 'escape')) {
      m.closeOverlay();
      return true;
    }
    overlay(m.overlay)?.key(k, s());
    m.touch();
    return true;
  }
  if (m.helpFallback) {
    if (is(k, 'escape') || k.text === '?') m.closeOverlay();
    return true;
  }
  // 5. The mentions picker.
  if (m.pickerOpen()) {
    if (is(k, 'up')) return did(() => m.movePicker(-1));
    if (is(k, 'down')) return did(() => m.movePicker(1));
    if (is(k, 'tab') || (isEnter(k) && !k.shift && !k.alt && !k.ctrl))
      return did(() => m.completePicker());
    if (is(k, 'escape')) return did(() => m.dismissPicker());
  }
  // 6. App chords: a feature's first, then the core's.
  for (const b of keyBindings('chord'))
    if (b.key(k, s()) === 'handled') return did(() => m.touch());
  if (chord(m, k)) return true;
  // 7. Pick mode.
  if (m.pane().pick !== undefined) {
    for (const b of keyBindings('pick'))
      if (b.key(k, s()) === 'handled') return did(() => m.touch());
    if (pickKey(m, k)) return true;
  }
  if (is(k, 'escape')) {
    m.escape();
    return true;
  }
  // 8. The empty composer (with no channel open, there is no draft: `?` and ← still work).
  const c = m.composer();
  if (c.text === '') {
    if (is(k, 'up') && m.current !== undefined) {
      m.movePick(-1);
      return true;
    }
    if (k.text === '?') {
      m.openOverlay('help');
      return true;
    }
    if (is(k, 'left')) {
      m.openOverlay('browser');
      return true;
    }
  }
  // 9. The composer.
  return composerKey(m, k);
}

/** Layer 6: the core's chords. */
function chord(m: AppModel, k: Key): boolean {
  if (k.ctrl && !k.alt) {
    switch (k.name) {
      case 'k':
        m.openOverlay('switcher');
        return true;
      case 'f':
        if (m.current === undefined) m.status('open a channel to search it', 'caution');
        else m.openOverlay('search');
        return true;
      case 'b':
        m.openOverlay('browser');
        return true;
      case 'u':
        void m.acknowledge();
        return true;
      case 'g':
        m.jumpLatest();
        return true;
      case 'o':
        void m.loadOlder();
        return true;
      case 'r':
        m.status('there are no deferred images to reveal');
        return true;
      case 'v':
        // Linux pastes text through the terminal's own paste; a feature binds the Mac image.
        return false;
      case 's':
        m.toggleSigned();
        return true;
      case '\\':
        m.toggleSplit();
        return true;
      case 'up':
        m.movePick(-1);
        return true;
      case 'down':
        m.movePick(1);
        return true;
    }
    return false;
  }
  if (is(k, 'tab')) {
    m.nextNeedsYou();
    return true;
  }
  if (k.alt && !k.ctrl && /^[1-9]$/.test(k.name)) {
    m.lane(Number(k.name));
    return true;
  }
  if (is(k, 'f2')) {
    m.toggleSplit();
    return true;
  }
  if (is(k, 'pageup') || is(k, 'pagedown')) {
    const rows = m.paneViews.get(m.focusedPane)?.streamRows ?? 10;
    m.scroll(k.name === 'pageup' ? rows - 1 : -(rows - 1));
    return true;
  }
  return false;
}

/** Layer 7: a message is picked. */
function pickKey(m: AppModel, k: Key): boolean {
  const pick = m.pane().pick;
  if (pick === undefined) return false;
  if (is(k, 'up')) return did(() => m.movePick(-1));
  if (is(k, 'down')) return did(() => m.movePick(1));
  if (is(k, 'escape')) {
    m.pick(undefined);
    return true;
  }
  if (k.text === 'r') {
    m.setReply(pick);
    m.pick(undefined);
    return true;
  }
  const named = k.text === 'c' ? 'copy' : k.text === 's' ? 'seen' : undefined;
  if (named !== undefined && command(named) !== undefined) {
    void m.invoke(named, '');
    return true;
  }
  if (k.text !== undefined && /^[1-9]$/.test(k.text) && command('vote') !== undefined) {
    void m.invoke('vote', k.text);
    return true;
  }
  // Any other printable key clears the pick and types.
  if (k.text !== undefined) m.pick(undefined);
  return false;
}

/** Layer 9: grapheme editing; Enter sends; Shift/Alt+Enter and Ctrl+J insert a newline. */
function composerKey(m: AppModel, k: Key): boolean {
  const e = m.editOf();
  const set = (next: edit.Edit) => {
    m.setComposer(next);
    return true;
  };
  if (isEnter(k) && !k.ctrl) {
    if (k.shift || k.alt) return set(edit.insert(e, '\n'));
    void m.submit();
    return true;
  }
  if (k.name === 'linefeed') return set(edit.insert(e, '\n'));
  const erase = (kind: 'backspace' | 'delete' | 'word') => {
    m.eraseKey(kind);
    return true;
  };
  if (k.name === 'backspace') return erase(k.alt || k.ctrl ? 'word' : 'backspace');
  if (is(k, 'w', { ctrl: true })) return erase('word');
  if (is(k, 'delete')) return erase('delete');
  if (is(k, 'left')) return set(edit.left(e));
  if (is(k, 'right')) return set(edit.right(e));
  if (is(k, 'home') || is(k, 'a', { ctrl: true })) return set(edit.home(e));
  if (is(k, 'end') || is(k, 'e', { ctrl: true })) return set(edit.end(e));
  if (is(k, 'up') || is(k, 'down')) {
    const width = composerWidth(m.cols, m.state().layout === 'phone');
    const moved = edit.vertical(e, width, k.name === 'up' ? -1 : 1);
    // At the draft's top or bottom edge the arrows do nothing.
    return moved.edge ? false : set(moved.edit);
  }
  if (k.name === 'space' && !k.ctrl && !k.alt) return set(edit.insert(e, ' '));
  if (k.text !== undefined) {
    if (m.current === undefined) {
      m.status('open a channel first: Ctrl+K lists them', 'caution');
      return true;
    }
    return set(edit.insert(e, k.text));
  }
  return false;
}
