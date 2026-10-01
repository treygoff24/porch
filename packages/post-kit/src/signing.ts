import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnerAnchor } from './owner.ts';
import { ownerEnv } from './owner.ts';
import { type Outcome, type RunSpec, runProcess } from './run.ts';
import { component, privateFile, SafeDirectory } from './safe-fs.ts';

export type Runner = (executable: string, spec: RunSpec) => Promise<Outcome>;
export const MAX_SIGNED_BODY_BYTES = 1048576;
export const DEFAULT_BODY_BYTES = 32768;
export function bodyBytes(body: string): Buffer {
  if (!body.isWellFormed()) throw new Error('body is not valid UTF-8');
  return Buffer.from(body, 'utf8');
}
export function validateTag(tag: string): string {
  if (!/^[0-9A-Za-z-]+$/.test(tag)) throw new Error('invalid signature tag');
  return tag;
}
export function manifestBytes(tag: string, channel: string, body: string): Buffer {
  validateTag(tag);
  component(channel);
  const bytes = bodyBytes(body);
  return Buffer.from(
    `porch-signed-v2\ntag: ${tag}\nchannel: ${channel}\nbytes: ${bytes.length}\nsha256: ${createHash('sha256').update(bytes).digest('hex')}\n`,
  );
}

/** Owns only the agent it started. No inherited/service socket can arm this object. */
export class PrivateAgent {
  private active = true;
  private readonly onExit = () => this.child.stdin?.destroy();
  private constructor(
    private readonly child: ChildProcess,
    private readonly directory: string,
    readonly env: NodeJS.ProcessEnv,
  ) {
    process.once('exit', this.onExit);
    child.once('exit', () => {
      this.active = false;
    });
  }
  get armed(): boolean {
    return this.active;
  }
  static async start(opts: {
    keyFile: string;
    askPassphrase: () => string | null | Promise<string | null>;
    env?: NodeJS.ProcessEnv;
  }): Promise<PrivateAgent> {
    const directory = mkdtempSync(join(tmpdir(), 'porch-agent-'));
    chmodSync(directory, 0o700);
    const socket = join(directory, 'agent.sock');
    const env = ownerEnv(opts.env ?? process.env, {
      mailRoot: opts.env?.POST_MAIL_ROOT ?? process.env.POST_MAIL_ROOT ?? '',
    });
    // The supervisor's read sees EOF even when Node is killed with SIGKILL. It reaps only
    // its own agent, which removes its socket. No service or inherited agent is involved.
    const child = spawn(
      'sh',
      [
        '-c',
        'ssh-agent -D -a "$1" >/dev/null & a=$!; cleanup() { trap "" HUP INT TERM; kill "$a" 2>/dev/null || :; wait "$a" 2>/dev/null || :; }; trap "cleanup; exit" HUP INT TERM; printf "%s\\n" "$a"; read -r _ || :; cleanup',
        'porch-private-agent',
        socket,
      ],
      {
        detached: true,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    let spawnError: Error | undefined;
    child.once('error', (err) => {
      spawnError = err;
    });
    const agent = new PrivateAgent(child, directory, {
      ...env,
      SSH_AUTH_SOCK: socket,
    });
    let agentPid: string | undefined;
    child.stdout?.once('data', (bytes) => {
      const pid = String(bytes).trim();
      if (/^[1-9][0-9]*$/.test(pid)) {
        agentPid = pid;
        agent.env.SSH_AGENT_PID = pid;
      }
    });
    try {
      const deadline = performance.now() + 5000;
      for (;;) {
        if (spawnError !== undefined) throw spawnError;
        if (!agent.armed || performance.now() >= deadline)
          throw new Error('private ssh-agent did not start');
        try {
          if (agentPid !== undefined && lstatSync(socket).isSocket()) break;
        } catch {
          /* starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let passphrase = await opts.askPassphrase();
      if (passphrase === null) throw new Error('signing cancelled');
      const askSocket = join(directory, 'ask.sock');
      let answered = false;
      let repeated = false;
      const server = createServer((connection) => {
        repeated ||= answered;
        connection.end(`${answered ? '' : (passphrase ?? '')}\n`);
        answered = true;
        passphrase = null;
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(askSocket, resolve);
      });
      const helper = join(directory, 'askpass');
      // The helper contains no passphrase; it reads it from the private, short-lived socket.
      const node = `'${process.execPath.replaceAll("'", "'\\''")}'`;
      writeFileSync(
        helper,
        `#!/bin/sh\nexec ${node} -e 'const n=require("node:net");const s=n.connect(process.env.PORCH_ASKPASS_SOCKET);s.on("data",d=>process.stdout.write(d));s.on("error",()=>process.exit(1));'\n`,
        { mode: 0o700 },
      );
      try {
        const out = await runProcess('ssh-add', {
          args: [opts.keyFile],
          env: {
            ...agent.env,
            SSH_ASKPASS: helper,
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: 'porch',
            PORCH_ASKPASS_SOCKET: askSocket,
          },
          timeoutMs: 15000,
        });
        if (out.failed !== undefined || out.code !== 0)
          throw new Error(repeated ? 'wrong passphrase' : 'could not arm private signing agent');
      } finally {
        passphrase = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      return agent;
    } catch (err) {
      await agent.stop();
      throw err;
    }
  }
  private kill(): void {
    if (
      this.child.pid !== undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.active = false;
  }
  async stop(): Promise<void> {
    process.removeListener('exit', this.onExit);
    const exited =
      this.child.exitCode !== null ||
      this.child.signalCode !== null ||
      this.child.pid === undefined;
    const left = exited
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.active = false;
    this.child.stdin?.end();
    const fallback = setTimeout(() => this.kill(), 1000);
    fallback.unref();
    await left;
    clearTimeout(fallback);
    rmSync(this.directory, { recursive: true, force: true });
  }
}

export type SignedSidecar = {
  signature_ref: { version: 2; tag: string };
  payload: string;
  signature: string;
  discard(): Promise<void>;
};

export async function signV2(opts: {
  channel: string;
  body: string;
  tag?: string;
  anchor: OwnerAnchor;
  keyFile: string;
  agent: PrivateAgent;
  run?: Runner;
}): Promise<SignedSidecar> {
  const bytes = bodyBytes(opts.body);
  if (bytes.length > MAX_SIGNED_BODY_BYTES)
    throw new Error('signed body exceeds the 1,048,576-byte limit');
  if (opts.anchor.signingBlocked) throw new Error(opts.anchor.signingBlocked);
  if (!opts.agent.armed) throw new Error('private signing agent is not armed');
  component(opts.channel);
  const dir = await SafeDirectory.open(join(opts.anchor.sidecarDir, 'sigs'), {
    create: true,
    private: true,
  });
  let name: string | undefined;
  let sigName: string | undefined;
  try {
    let tag =
      opts.tag ??
      new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
    for (let attempt = 0; attempt < 8; attempt++) {
      validateTag(tag);
      const candidate = `${tag}.txt`;
      try {
        const fd = dir.open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        name = candidate;
        try {
          privateFile(fd);
          writeFileSync(fd, manifestBytes(tag, opts.channel, opts.body));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        break;
      } catch (err) {
        if (
          name !== undefined ||
          (err as NodeJS.ErrnoException).code !== 'EEXIST' ||
          opts.tag !== undefined
        )
          throw err;
        tag = `${new Date()
          .toISOString()
          .replace(/[-:]/g, '')
          .replace(/\.\d{3}Z$/, 'Z')}${randomBytes(3).toString('hex')}`;
      }
    }
    if (name === undefined) throw new Error('could not create a unique signature sidecar');
    const out = await (opts.run ?? runProcess)('ssh-keygen', {
      args: ['-Y', 'sign', '-f', `${opts.keyFile}.pub`, '-n', opts.anchor.namespace],
      env: opts.agent.env,
      input: manifestBytes(tag, opts.channel, opts.body).toString('utf8'),
      timeoutMs: 15000,
    });
    if (
      out.failed !== undefined ||
      out.code !== 0 ||
      !out.stdout.startsWith('-----BEGIN SSH SIGNATURE-----')
    )
      throw new Error('SIGN FAILED');
    const candidate = `${name}.sig`;
    const fd = dir.open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    sigName = candidate;
    try {
      privateFile(fd);
      writeFileSync(fd, out.stdout);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    dir.sync();
    const payload = join(opts.anchor.sidecarDir, 'sigs', name);
    const signature = join(opts.anchor.sidecarDir, 'sigs', sigName);
    return {
      signature_ref: { version: 2, tag },
      payload,
      signature,
      async discard() {
        const held = await SafeDirectory.open(join(opts.anchor.sidecarDir, 'sigs'), {
          private: true,
        });
        try {
          for (const file of [candidate, `${tag}.txt`]) {
            const fd = held.open(file);
            try {
              privateFile(fd);
            } finally {
              closeSync(fd);
            }
            held.unlink(file);
          }
          held.sync();
        } finally {
          held.close();
        }
      },
    };
  } catch (err) {
    for (const file of [sigName, name])
      if (file !== undefined) {
        try {
          dir.unlink(file);
        } catch {
          /* leave evidence when cleanup fails */
        }
      }
    throw err;
  } finally {
    dir.close();
  }
}
