import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { type ClientConfig, crossCheck, ownerEnv, porchConfigPath, readConfig } from './owner.ts';
import { isRecord, parseRaw, type RawRecord, safeArgument } from './records.ts';
import { decodeJson, runProcess } from './run.ts';
import { boundedRead, SafeDirectory } from './safe-fs.ts';
import type { Runner } from './signing.ts';
import { verify } from './verify.ts';

const RESERVED = new Set([
  'archive',
  'rooms.json',
  'rules.json',
  'profiles.json',
  'owner.json',
  '.rooms.lock',
]);
const MESSAGE_ID = /^[0-9]{8}-[0-9]{6}-[0-9]{6}-[0-9a-fA-F]{6}$/;
export function signatureAge(tag: string, now = Date.now()): string {
  const clean = tag.replaceAll('-', '').replaceAll(':', '');
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(clean);
  const unknown = 'age unparseable; check freshness manually';
  if (m === null || clean.length < 16 || !clean.endsWith('Z')) return unknown;
  const stamp = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const then = Date.parse(stamp);
  if (!Number.isFinite(then) || new Date(then).toISOString().slice(0, 19) !== stamp.slice(0, 19))
    return unknown;
  const age = Math.trunc((now - then) / 1000);
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  if (age < 172800) return `${Math.floor(age / 3600)}h ago — CHECK: is this current?`;
  return `${Math.floor(age / 86400)}d ago — STALE: possible replay, reconfirm in-session`;
}
function parseStored(bytes: Buffer, channel: string, id: string): RawRecord {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const split = text.indexOf('\n---\n');
  if (split < 0) throw new Error('invalid message envelope');
  const envelope: unknown = JSON.parse(text.slice(0, split));
  const raw = parseRaw(envelope, channel, {
    file: 'msg',
    body: text.slice(split + 5),
    bodyComplete: true,
  });
  if (raw === undefined || raw.id !== id) throw new Error('invalid message envelope');
  return raw;
}
async function lookup(
  cfg: ClientConfig,
  id: string,
  channel?: string,
): Promise<{ raw?: RawRecord; duplicate?: boolean; invalid?: boolean }> {
  const channels = await SafeDirectory.open(join(cfg.mailRoot, 'channels'));
  try {
    const names =
      channel === undefined ? channels.names().filter((name) => !RESERVED.has(name)) : [channel];
    const hits: RawRecord[] = [];
    for (const name of names) {
      let messages: SafeDirectory;
      try {
        messages = await SafeDirectory.open(join(cfg.mailRoot, 'channels', name, 'messages'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      try {
        let fd: number;
        try {
          fd = messages.open(`${id}.msg`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        let bytes: Buffer;
        try {
          bytes = boundedRead(fd, 4 * 1024 * 1024);
        } finally {
          closeSync(fd);
        }
        try {
          hits.push(parseStored(bytes, name, id));
        } catch {
          return { invalid: true };
        }
      } finally {
        messages.close();
      }
    }
    return hits.length > 1 ? { duplicate: true } : hits[0] === undefined ? {} : { raw: hits[0] };
  } finally {
    channels.close();
  }
}

/** Return values are the public protocol: only 0 and 1 are verification verdicts. */
export async function runVerifyCli(
  argv: readonly string[],
  opts: {
    config?: ClientConfig;
    loadConfig?: typeof readConfig;
    env?: NodeJS.ProcessEnv;
    run?: Runner;
    stdin?: () => Promise<Buffer>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<0 | 1 | 2 | 3 | 4> {
  const out = opts.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = opts.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  let id: string | undefined;
  let channel: string | undefined;
  let configPath: string | undefined;
  let stdin = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === '--stdin') stdin = true;
      else if (arg === '--channel' || arg === '--config') {
        const value = argv[++i];
        if (value === undefined) throw new Error('missing option value');
        if (arg === '--channel') {
          safeArgument(value);
          if (RESERVED.has(value)) throw new Error('reserved channel');
          channel = value;
        } else configPath = value;
      } else if (arg.startsWith('-') || id !== undefined || !MESSAGE_ID.test(arg))
        throw new Error('invalid message id or option');
      else id = arg;
    }
    if ((stdin && (id !== undefined || channel !== undefined)) || (!stdin && id === undefined))
      throw new Error('pass a message id or --stdin');
  } catch (e) {
    err(`usage: ${(e as Error).message}`);
    return 2;
  }
  const env = opts.env ?? process.env;
  let cfg: ClientConfig;
  try {
    cfg =
      opts.config ?? (await (opts.loadConfig ?? readConfig)(configPath ?? porchConfigPath(env)));
  } catch (e) {
    err(`config: ${(e as Error).message}`);
    return 2;
  }
  const run = opts.run ?? runProcess;
  try {
    const shown = await run(env.PORCH_POST_BIN ?? 'post', {
      args: ['owner', 'show', '--json'],
      env: ownerEnv(env, cfg),
      cwd: cfg.ownerRoomDir,
      timeoutMs: 10000,
    });
    const data = decodeJson(shown.stdout, shown.stderr);
    if (shown.failed !== undefined || shown.code !== 0 || data === undefined) {
      err('environment: owner anchor could not be read');
      return 4;
    }
    const check = crossCheck(cfg, data);
    if (check.kind !== 'agree') {
      err(`config: ${check.reason}`);
      return 2;
    }
    let raw: RawRecord;
    if (stdin) {
      const bytes = opts.stdin === undefined ? await readStdin() : await opts.stdin();
      if (bytes.length > 4 * 1024 * 1024) {
        err('FAIL: input exceeds size limit');
        return 1;
      }
      let body: string;
      try {
        body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        err('FAIL: invalid UTF-8');
        return 1;
      }
      const separator = body.indexOf('\n---\n');
      if (separator >= 0) body = body.slice(separator + 5);
      raw = {
        file: 'msg',
        storageChannel: 'stdin',
        envelope: {},
        id: 'stdin',
        from: cfg.ownerRoom,
        channel: 'stdin',
        sent: '',
        mentions: [],
        body,
        bodyComplete: true,
        signature: { present: false },
      };
    } else {
      let found: Awaited<ReturnType<typeof lookup>>;
      try {
        found = await lookup(cfg, id as string, channel);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          err('lookup: message not found');
          return 3;
        }
        throw e;
      }
      if (found.invalid) {
        err('FAIL: invalid message encoding or envelope');
        return 1;
      }
      if (found.duplicate || found.raw === undefined) {
        err(found.duplicate ? 'lookup: duplicate message id' : 'lookup: message not found');
        return 3;
      }
      raw = found.raw;
    }
    const verdict = await verify(raw, cfg, { run, env });
    if (verdict.state === 'verified') {
      const tag =
        raw.signature.present && isRecord(raw.signature.raw)
          ? String(raw.signature.raw.tag)
          : (/\[signed:([0-9A-Za-z-]+)\]/.exec(raw.body)?.[1] ?? '');
      out(`VERIFIED: ${cfg.label} (${cfg.ownerRoom}) — signed ${tag} (${signatureAge(tag)})`);
      return 0;
    }
    if (verdict.state === 'unknown') {
      err(`environment: ${verdict.reason}`);
      return 4;
    }
    err(`FAIL: ${verdict.reason}`);
    return 1;
  } catch (e) {
    err(`environment: ${(e as Error).message}`);
    return 4;
  }
}

async function readStdin(): Promise<Buffer> {
  const buffers: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > 4 * 1024 * 1024) return Buffer.alloc(4 * 1024 * 1024 + 1);
    buffers.push(bytes);
  }
  return Buffer.concat(buffers);
}
