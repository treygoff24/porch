import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DisplayRecord, RawRecord, SendOutcome, SendRequest } from '@estate/post-kit';
import type { AppState, CommandContext, SlashCommand } from '../registry.ts';

/** T6 advertises the emote route so an unsupported core cannot send emote syntax as chat. */
export type FeatureSend = CommandContext['send'] & { emotes?: true };
/** Append to this channel's latest draft, preserving newer words and a changed focus. */
export type FeatureActions = AppState['actions'] & {
  appendImagePath?: (channel: string, path: string) => void;
};
export type EmoteSendRequest = SendRequest & { emote: { name: string; at?: string } };
export type Execute = (file: string, args: string[], input?: Buffer) => Promise<Buffer>;
/**
 * The only programs Porch starts outside post-kit: clipboards, image conversion. Post itself runs
 * only through post-kit, so nothing here can become a second sending path.
 */
export const EXTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'pbcopy',
  'wl-copy',
  'xclip',
  'ffmpeg',
  'osascript',
  'sips',
]);
export const execute: Execute = (file, args, input) =>
  new Promise((resolve, reject) => {
    if (!EXTERNAL_TOOLS.has(file)) {
      reject(new Error(`${file} is not a tool Porch runs`));
      return;
    }
    const child = execFile(
      file,
      args,
      {
        timeout: ['pbcopy', 'wl-copy', 'xclip'].includes(file) ? 3000 : 10000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
export type FeatureOptions = {
  execute?: Execute;
  osc52?: (text: string) => void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spool?: string;
};
export class FeatureRuntime {
  private ffmpeg: Promise<boolean> | undefined;
  readonly execute: Execute;
  readonly osc52: (text: string) => void;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly spool: string | undefined;
  constructor(opts: FeatureOptions = {}) {
    this.execute = opts.execute ?? execute;
    this.osc52 =
      opts.osc52 ??
      ((text) => {
        process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
      });
    this.platform = opts.platform ?? process.platform;
    this.env = opts.env ?? process.env;
    this.spool = opts.spool;
  }
  ffmpegAvailable(): Promise<boolean> {
    this.ffmpeg ??= this.execute('ffmpeg', ['-version']).then(
      () => true,
      () => false,
    );
    return this.ffmpeg;
  }
  async copy(text: string): Promise<string> {
    const tools: [string, string[]][] = [];
    if (this.platform === 'darwin') tools.push(['pbcopy', []]);
    if (this.env.WAYLAND_DISPLAY) tools.push(['wl-copy', []]);
    if (this.env.DISPLAY) tools.push(['xclip', ['-selection', 'clipboard']]);
    for (const [file, args] of tools) {
      try {
        await this.execute(file, args, Buffer.from(text));
        return 'copied';
      } catch {
        /* Try the next clipboard. */
      }
    }
    this.osc52(text);
    return 'terminal clipboard requested';
  }
}
export function currentRecords(s: AppState): readonly DisplayRecord[] {
  return s.current ? (s.views.get(s.current)?.records ?? []) : [];
}
export function selected(s: AppState, arg = ''): DisplayRecord {
  const records = currentRecords(s).filter((r) => r.kind === 'message');
  if (!arg.trim()) {
    const pick = s.panes[s.focusedPane]?.pick;
    const r = pick ? records.find((r) => r.raw.id === pick) : records.at(-1);
    if (!r) throw new Error('nothing selected');
    return r;
  }
  if (!/^[1-9]\d*$/.test(arg.trim())) throw new Error('takes a positive message number');
  const r = records[records.length - Number(arg)];
  if (!r) throw new Error(`only ${records.length} messages here`);
  return r;
}
export function services(s: AppState) {
  if (!s.post) throw new Error('post is unavailable');
  return s.post;
}
export function channel(s: AppState): string {
  if (!s.current) throw new Error('open a channel first');
  return s.current;
}
export function request(s: AppState, body: string): SendRequest {
  return {
    channel: channel(s),
    body,
    mode: s.mode,
    draftRevision: s.composer.revision,
    ...(s.composer.replyTo ? { replyTo: s.composer.replyTo } : {}),
  };
}
export function outcome(ctx: CommandContext, result: SendOutcome): void {
  ctx.status(
    result.kind === 'confirmed'
      ? `sent ${result.id}`
      : result.kind === 'refused'
        ? result.message
        : result.kind === 'uncertain'
          ? 'delivery unknown; use /restore before retrying'
          : 'delivered; do not retry',
  );
}
export function featureCommand(
  name: string,
  usage: string,
  run: SlashCommand['run'],
  opts: { aliases?: readonly string[]; needsChannel?: boolean } = {},
): SlashCommand {
  return {
    name,
    usage,
    needsChannel: opts.needsChannel ?? true,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    async run(args, ctx) {
      try {
        if (opts.needsChannel ?? true) channel(ctx.state);
        await run(args.trim(), ctx);
      } catch (err) {
        ctx.status(`${name}: ${(err as Error).message}`);
      }
    },
  };
}
/** Complete history, without acknowledging, including full bodies for export and recovery. */
export async function fullHistory(s: AppState, name = channel(s)): Promise<RawRecord[]> {
  const client = services(s).client;
  let limit = 256;
  let records: RawRecord[];
  for (;;) {
    const page = await client.historyPage(name, limit);
    if (!page.ok) throw new Error(page.error.message);
    if (page.value.skipped?.count)
      throw new Error('history contains unreadable records; export refused');
    records = page.value.messages;
    if (records.length < limit) break;
    if (limit >= 1000000) throw new Error('history exceeds export limit');
    limit *= 2;
  }
  const out: RawRecord[] = [];
  for (const r of records) {
    if (r.file === 'emote' || r.bodyComplete) out.push(r);
    else {
      const exact = await client.message(name, r.id);
      if (!exact.ok || !exact.value.bodyComplete)
        throw new Error('complete message body unavailable');
      out.push(exact.value);
    }
  }
  return out;
}
export function saveTranscript(records: readonly RawRecord[], name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'porch-export-'));
  const path = join(dir, `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}.txt`);
  try {
    writeFileSync(
      path,
      records
        .map(
          (r) =>
            `--- ${r.from}   ${r.sent}   ${r.id}\n${r.file === 'emote' ? `✦ ${r.emote?.emote?.name ?? 'emote'}` : r.body}\n`,
        )
        .join('\n'),
      { mode: 0o600, flag: 'wx' },
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return path;
}
