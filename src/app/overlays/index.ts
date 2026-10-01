/**
 * The overlay lane's plug-in: importing this registers help, the quick switcher, the channel
 * browser (its archived view included) and search with the app's registry, plus `/search` and the
 * chords that open them (Ctrl+K, Ctrl+B, Ctrl+F). The registry offers chord bindings before the
 * core's own chords, so these agree with the core whether or not it binds the same keys.
 * F1 (layer 1), `?` on an empty composer and ← at column 0 (layer 8) are the core's; they open the
 * ids exported here. `src/app/plugins.ts` imports this at integration.
 */
import {
  type CommandContext,
  type Key,
  type KeyResult,
  registerCommand,
  registerKeyBinding,
  registerOverlay,
} from '../registry.ts';
import type { AppState } from '../state.ts';
import { BROWSER, createBrowser } from './browser.ts';
import { createHelp, HELP } from './help.ts';
import { chord } from './kit.ts';
import { createSearch, SEARCH } from './search.ts';
import { createSwitcher, SWITCHER } from './switcher.ts';

export { BROWSER, HELP, SEARCH, SWITCHER };

export const help = createHelp();
export const switcher = createSwitcher();
export const browser = createBrowser();
export const search = createSearch();

registerOverlay(help);
registerOverlay(switcher);
registerOverlay(browser);
registerOverlay(search);

/** Open an overlay from a chord, fresh. */
function opener(letter: string, open: (s: AppState) => void) {
  return (k: Key, s: AppState): KeyResult => {
    if (!chord(k, letter) || k.shift) return 'pass';
    open(s);
    return 'handled';
  };
}

registerKeyBinding({
  id: 'overlays:switcher',
  layer: 'chord',
  key: opener('k', (s) => {
    switcher.reset();
    s.actions.openOverlay(SWITCHER);
  }),
});
registerKeyBinding({
  id: 'overlays:browser',
  layer: 'chord',
  key: opener('b', (s) => {
    browser.reset();
    s.actions.openOverlay(BROWSER);
  }),
});
registerKeyBinding({
  id: 'overlays:search',
  layer: 'chord',
  key: opener('f', (s) => {
    search.reset();
    s.actions.openOverlay(SEARCH);
  }),
});

registerCommand({
  name: 'search',
  usage: '/search <words> — search this channel',
  needsChannel: true,
  async run(args: string, ctx: CommandContext): Promise<void> {
    search.reset();
    ctx.openOverlay(SEARCH);
    if (args.trim() !== '') search.run(args, ctx.state);
  },
});
