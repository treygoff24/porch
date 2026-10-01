/**
 * The core's slash commands (inventory §6): `/quit` (alias `/q`), `/help` and `/reply`. The rest
 * belong to the overlay and feature lanes and register the same way. `/quit`, `/q` and `/help`
 * work before a channel is open; `/reply` needs one.
 *
 * They act on the app through the model the scene hands them, never by sending: none of these
 * sends anything.
 */
import type { AppModel } from './model.ts';
import { registerCommand } from './registry.ts';

let model: AppModel | undefined;

/** The model the core commands act on (the scene sets it before any command can run). */
export function bindCommands(m: AppModel): void {
  model = m;
}

let registered = false;

/** Register the core commands once. */
export function registerCoreCommands(): void {
  if (registered) return;
  registered = true;
  registerCommand({
    name: 'quit',
    aliases: ['q'],
    usage: '/quit — save drafts and leave (same as Ctrl+Q)',
    needsChannel: false,
    async run() {
      await model?.quit();
    },
  });
  registerCommand({
    name: 'help',
    usage: '/help — keys and commands',
    needsChannel: false,
    async run(_args, ctx) {
      ctx.openOverlay('help');
    },
  });
  registerCommand({
    name: 'crossed',
    usage: '/crossed [on|off] — show or hide the "crossed while you typed" strip this session',
    needsChannel: false,
    async run(args) {
      model?.setCrossedStrip(args);
    },
  });
  registerCommand({
    name: 'reply',
    usage: '/reply [id-prefix] — reply to a loaded message, or clear the reply',
    needsChannel: true,
    async run(args) {
      model?.replyByPrefix(args);
    },
  });
}
