import { NAME_GRAMMAR } from '@estate/pixel';
import {
  registerCommand,
  registerKeyBinding,
  registerMessageRenderer,
  registerOverlay,
  registerPasteHandler,
  registerPollObserver,
} from '../registry.ts';
import type { AppState } from '../state.ts';
import { Decisions } from './decisions.ts';
import { Images } from './images.ts';
import { Polls, voteCommand } from './polls.ts';
import { Recovery } from './recovery.ts';
import {
  type EmoteSendRequest,
  FeatureRuntime,
  type FeatureSend,
  featureCommand,
  fullHistory,
  outcome,
  request,
  saveTranscript,
  selected,
  services,
} from './runtime.ts';

/** A reader's name for /seen: with the directory (or id tail) after it when the name is shared. */
function seenName(s: AppState, channel: string, id: string): string {
  const name = s.names.get(id) ?? id;
  const hint = s.hints(channel).get(id);
  return hint === undefined || hint === '' ? name : `${name} · ${hint}`;
}

export const featureRuntime = new FeatureRuntime();
export const images = new Images(featureRuntime);
export const decisions = new Decisions();
export const recovery = new Recovery();
export const polls = new Polls();
export const featureCommands = [
  images.command(),
  voteCommand,
  ...decisions.commands(),
  recovery.command(),
  featureCommand(
    'copy',
    '/copy [N] — copy the picked message, or the Nth newest',
    async (args, ctx) => {
      const record = selected(ctx.state, args);
      const exact = await services(ctx.state).client.message(record.raw.channel, record.raw.id);
      if (!exact.ok || !exact.value.bodyComplete) throw new Error('complete body unavailable');
      // Clipboard input may later reach a shell; retain only printable text, newline and tab.
      const text = exact.value.body.replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal and bidi controls
        /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
        '',
      );
      ctx.status(await featureRuntime.copy(text));
    },
  ),
  featureCommand('save', "/save — save this channel's history to a file", async (_, ctx) => {
    const records = await fullHistory(ctx.state);
    if (!records.length) throw new Error('nothing to save');
    ctx.status(
      `saved ${records.length} records → ${saveTranscript(records, ctx.state.current ?? 'channel')}`,
    );
  }),
  featureCommand(
    'seen',
    '/seen [N] — who has read the picked message, or the Nth newest',
    async (args, ctx) => {
      const r = selected(ctx.state, args);
      const result = await services(ctx.state).client.seenBy(r.raw.channel, r.raw.id);
      if (!result.ok) throw new Error(result.error.message);
      ctx.status(
        `seen-by ${r.raw.id.slice(-12)}: ${result.value.map((p) => seenName(ctx.state, r.raw.channel, p)).join(', ') || 'nobody yet'}`,
      );
    },
  ),
  ...(['archive', 'unarchive'] as const).map((verb) =>
    featureCommand(
      verb,
      verb === 'archive'
        ? '/archive — archive this channel'
        : '/unarchive — bring this archived channel back',
      async (_, ctx) => {
        const result = await services(ctx.state).client[verb](ctx.state.current ?? '');
        if (!result.ok) throw new Error(result.error.message);
        ctx.status(`${verb === 'archive' ? 'archived' : 'restored'} #${ctx.state.current}`);
        ctx.state.actions.requestFrame();
      },
    ),
  ),
  featureCommand(
    'emote',
    '/emote <name> [@who] — play one of your emotes on stage',
    async (args, ctx) => {
      const [name, at, extra] = args.split(/\s+/);
      if (
        !name ||
        !NAME_GRAMMAR.test(name) ||
        extra ||
        (at && !/^@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(at))
      )
        throw new Error('/emote <name> [@who]');
      if (!ctx.state.avatars.has(ctx.state.owner.participant))
        throw new Error('set an avatar first');
      if ((ctx.send as FeatureSend).emotes !== true)
        throw new Error('emote send route is unavailable');
      const req: EmoteSendRequest = {
        ...request(ctx.state, ''),
        mode: 'casual',
        emote: { name, ...(at ? { at: at.slice(1) } : {}) },
      };
      delete req.replyTo;
      outcome(ctx, await ctx.send(req));
    },
  ),
];
for (const command of featureCommands) registerCommand(command);
registerMessageRenderer(decisions.renderer());
registerMessageRenderer(decisions.decorate(polls.renderer()));
registerMessageRenderer(decisions.decorate(images.renderer()));
registerOverlay(recovery.overlay());
registerKeyBinding(images.key());
registerKeyBinding(polls.key());
// Pasted image paths become attachments before the composer sees the paste.
registerPasteHandler({ id: 'features-images', paste: (text, s) => images.paste(text, s) });
// Decision records are re-read after each post poll that found something.
registerPollObserver({ id: 'features-decisions', observe: (s) => decisions.observe(s) });
