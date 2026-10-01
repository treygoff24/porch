/**
 * `porch-next [channel]`: load the config, arm signing if Trey says so, connect to post as Trey,
 * and run the app until it quits or a signal arrives. Then save the drafts and stop the private
 * signing agent, which ends the ssh-agent and removes its `porch-agent-*` directory.
 *
 * That cleanup runs when Porch quits or takes a signal, not on a crash: an uncaught error exits
 * through the host's exit guard (which gives the terminal back and exits 1) without reaching the
 * `finally` here. After a crash, or a SIGKILL, the agent's supervisor still ends the ssh-agent when
 * Porch's end of its pipe closes, and the agent removes its socket; the empty `porch-agent-*`
 * directory is left in the temporary directory.
 *
 * Order (plan T6, "The composer"; inventory §2):
 *  1. config and settings (a missing config says to run `porch-next init`);
 *  2. the arm question, then the passphrase without echo, both before the screen starts; arming
 *     never selects signed mode, and a signal during either cancels cleanly;
 *  3. one `DraftSpace`, shared by the drafts store and the client's send recovery records;
 *  4. connect (owner check, participant bind, acting room), the store (`markReadOnView: false`),
 *     avatars and names;
 *  5. the screen; then drafts saved and the agent stopped, on a quit or a signal (see above for
 *     a crash).
 */

import { existsSync } from 'node:fs';
import { type AvatarPack, parseAvatar } from '@estate/pixel';
import {
  ConfigError,
  clientConfig,
  DraftSpace,
  Drafts,
  drLogPath,
  loadPorchConfig,
  loadSettings,
  OwnerPost,
  type PorchConfig,
  PostStore,
  PrivateAgent,
  SendRecord,
} from '@estate/post-kit';
import type { CliRendererConfig } from '@opentui/core';
import { noColorRequested } from '../grid/color.ts';
import { bindCommands, registerCoreCommands } from './commands.ts';
import { DecisionWatch } from './decisions.ts';
import { AppModel, type Roster } from './model.ts';
import { loadLayout, saveLayout } from './remember.ts';
import { stateDir } from './stage/attract.ts';
import type { MotionMode } from './state.ts';
import { type Prompter, terminalPrompter } from './tty.ts';
import type { RuntimeFacts } from './who.ts';

const SIGNALS: NodeJS.Signals[] = ['SIGHUP', 'SIGTERM', 'SIGINT', 'SIGQUIT'];

export type BootOptions = {
  channel: string | undefined;
  /** `--no-sign`: never ask to arm. */
  noSign: boolean;
  env?: NodeJS.ProcessEnv;
  stderr?: NodeJS.WritableStream;
  prompter?: Prompter;
  createRenderer?: (config: CliRendererConfig) => Promise<import('@opentui/core').CliRenderer>;
};

export async function boot(opts: BootOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const err = opts.stderr ?? process.stderr;
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    err.write('porch-next needs a terminal on stdin and stdout\n');
    return 2;
  }
  let cfg: PorchConfig;
  try {
    cfg = loadPorchConfig({ env });
  } catch (e) {
    err.write(`porch-next: ${e instanceof ConfigError ? e.message : String(e)}\n`);
    return 2;
  }
  const { settings, warnings } = loadSettings({ env });
  for (const w of warnings) err.write(`porch-next: ${w}\n`);

  // Until the screen installs its own handlers, a signal cancels a waiting prompt (arming then
  // cleans up its own agent) or stops an armed agent, and Porch leaves.
  const prompter = opts.prompter ?? terminalPrompter();
  let agent: PrivateAgent | undefined;
  let signalled = false;
  const early = () => {
    signalled = true;
    prompter.cancel();
    if (agent !== undefined) void agent.stop().finally(() => process.exit(0));
  };
  for (const sig of SIGNALS) process.on(sig, early);
  const dropEarly = () => {
    for (const sig of SIGNALS) process.off(sig, early);
  };

  let notice: string | undefined;
  if (!opts.noSign && !signalled) {
    if (!existsSync(cfg.keyFile)) notice = `no signing key at ${cfg.keyFile}; sends are casual`;
    else {
      const answer = await prompter.ask('Arm signing for this session? [y/N] ');
      if (answer !== null && /^y(es)?$/i.test(answer.trim()) && !signalled) {
        try {
          agent = await PrivateAgent.start({
            keyFile: cfg.keyFile,
            askPassphrase: () => prompter.askHidden('Passphrase (empty for none): '),
            env,
          });
        } catch (e) {
          notice = `signing not armed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
  }
  if (signalled) {
    dropEarly();
    await agent?.stop();
    return 0;
  }

  const ccfg = clientConfig(cfg);
  const space = new DraftSpace(ccfg);
  const recovery = new SendRecord(space);
  const connected = await OwnerPost.connect({
    config: ccfg,
    env,
    space,
    recovery,
    ...(agent === undefined ? {} : { agent }),
    ...(env.PORCH_POST_BIN === undefined ? {} : { executable: env.PORCH_POST_BIN }),
  });
  if (!connected.ok) {
    dropEarly();
    await agent?.stop();
    err.write(`porch-next: ${connected.error.message}\n`);
    return 1;
  }
  const client = connected.value;
  const pollMs = Number(env.PORCH_POLL_MS ?? '');
  const store = new PostStore({
    client,
    markReadOnView: false,
    ...(Number.isFinite(pollMs) && pollMs > 0 ? { pollMs } : {}),
  });
  const [avatars, roster] = await Promise.all([loadAvatars(client), loadRoster(client)]);
  let model: AppModel | undefined;
  const decisions = new DecisionWatch({
    path: drLogPath(cfg),
    anchor: client.owner,
    message: (channel, id) => client.message(channel, id),
    changed: () => model?.touch(),
  });
  await decisions.refresh();
  const motion = settings.motion satisfies MotionMode as MotionMode;
  const state = stateDir(env);
  const remembered = loadLayout(state);
  model = new AppModel({
    owner: {
      room: cfg.ownerRoom,
      participant: client.owner.participant,
      label: cfg.label,
      marker: cfg.marker,
    },
    anchor: client.owner,
    source: store,
    send: (req) => client.transaction.send(req),
    sendEmote: (channel, name, at) => client.emote(channel, name, at),
    join: (channel) => client.join(channel),
    drafts: new Drafts(space),
    ...(remembered === undefined ? {} : { remembered }),
    saveLayout: (layout) => saveLayout(state, layout),
    rescue: recovery,
    history: (channel, limit) => client.history(channel, limit),
    services: { client, recovery, config: cfg, agent },
    armed: agent?.armed === true,
    ...(client.owner.signingBlocked === undefined
      ? {}
      : { signingBlocked: client.owner.signingBlocked }),
    motion,
    crossedStrip: settings.crossedStrip,
    noColor: noColorRequested(env),
    avatars,
    names: roster.names,
    places: roster.places,
    lineages: roster.lineages,
    runtimes: roster.runtimes,
    loadRoster: () => loadRoster(client),
    decisionsWaiting: () => decisions.channels(),
  });
  registerCoreCommands();
  bindCommands(model);
  // The overlay and feature lanes register here.
  await import('./plugins.ts');
  await model.start(opts.channel, cfg.initialChannel);
  if (notice !== undefined) model.status(notice, 'caution', true);

  const { runScene } = await import('../host/run.ts');
  const { appScene } = await import('./scene.ts');
  dropEarly();
  // The arm prompts leave stdin explicitly paused, and a paused stream stays paused when the
  // screen's input guard adds its reader: nothing would read the terminal, an idle screen holds no
  // timer, and Node would exit under the screen (code 13) right after the first frame. Resuming
  // here is safe: the guard's reader is attached synchronously inside runScene, before any data
  // event can be emitted.
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) process.stdin.resume();
  let code: number;
  try {
    code = await runScene(
      appScene(model),
      opts.createRenderer === undefined ? {} : { createRenderer: opts.createRenderer },
    );
  } finally {
    // A quit or a signal, or an error the screen itself rejects with. (An uncaught crash exits
    // through the host's exit guard and never reaches here; see the header.) A signal gets the same
    // save-then-rescue a quit does; past that there is nothing left to try, and Porch leaves.
    if (!(await model.saveDrafts().catch(() => false)))
      await model.rescueUnsaved().catch(() => false);
    model.dispose();
    store.dispose();
    await agent?.stop();
  }
  return code;
}

async function loadAvatars(client: OwnerPost): Promise<Map<string, AvatarPack>> {
  const out = new Map<string, AvatarPack>();
  const r = await client.avatars().catch(() => undefined);
  if (r === undefined || !r.ok) return out;
  for (const [id, value] of r.value) {
    const { pack } = parseAvatar(new TextEncoder().encode(JSON.stringify(value)));
    if (pack !== null) out.set(id, pack);
  }
  return out;
}

/**
 * Profile names, working directories and lineages, by participant id. Each read is a nicety: one
 * that fails leaves its part empty and the others stand.
 */
async function loadRoster(client: OwnerPost): Promise<Roster> {
  const names = new Map<string, string>();
  const places = new Map<string, string>();
  const lineages = new Map<string, string>();
  const runtimes = new Map<string, RuntimeFacts>();
  const [presence, roster] = await Promise.all([
    client.presence().catch(() => undefined),
    client.roster().catch(() => undefined),
  ]);
  if (presence?.ok === true)
    for (const [id, p] of presence.value.profiles)
      if (p.name !== undefined && p.name !== '') names.set(id, p.name);
  if (roster?.ok === true)
    for (const [id, e] of roster.value) {
      // The directory it said it works in, else the one post recorded when it joined.
      if (e.cwd !== undefined) places.set(id, e.cwd);
      if (e.lineage !== undefined) lineages.set(id, e.lineage);
      if (e.model !== undefined || e.effort !== undefined)
        runtimes.set(id, {
          ...(e.model === undefined ? {} : { model: e.model }),
          ...(e.effort === undefined ? {} : { effort: e.effort }),
        });
    }
  return { names, places, lineages, runtimes };
}
