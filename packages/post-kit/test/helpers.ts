import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ClientConfig, ownerEnv } from '../src/owner.ts';
import { parseRaw, type RawRecord } from '../src/records.ts';
import { decodeJson, type Outcome, runProcess } from '../src/run.ts';

export const vectors = join(dirname(fileURLToPath(import.meta.url)), 'vectors');
export const realPost = process.env.PORCH_REAL_POST;
export const referenceRoot =
  process.env.PORCH_REFERENCE_ROOT ?? join(homedir(), 'Code', 'porch-tui');
export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'porch-kit-'));
  const ownerRoomDir = join(root, 'mara');
  mkdirSync(ownerRoomDir, { mode: 0o700 });
  const cfg: ClientConfig = {
    ownerRoom: 'mara',
    ownerRoomDir,
    mailRoot: join(root, 'mail'),
    sidecarDir: ownerRoomDir,
    allowedSigners: join(ownerRoomDir, 'allowed_signers'),
    keyFile: join(root, 'test-key'),
    namespace: 'mara-porch',
    principal: 'mara@porch',
    marker: '🦊',
    label: 'Mara',
  };
  cpSync(join(vectors, 'test-key'), cfg.keyFile);
  // ssh refuses a private key others can read, and git checks the vector out with the umask's mode.
  chmodSync(cfg.keyFile, 0o600);
  cpSync(join(vectors, 'test-key.pub'), `${cfg.keyFile}.pub`);
  mkdirSync(join(ownerRoomDir, 'sigs'), { mode: 0o700 });
  for (const tag of ['20260930T230000Z', '20260930T230001Z', '20260930T230002Z']) {
    cpSync(join(vectors, `${tag}.txt`), join(ownerRoomDir, 'sigs', `${tag}.txt`));
    cpSync(join(vectors, `${tag}.txt.sig`), join(ownerRoomDir, 'sigs', `${tag}.txt.sig`));
  }
  cpSync(join(vectors, 'allowed_signers'), cfg.allowedSigners);
  const env = ownerEnv(
    { ...process.env, HOME: root, PORCH_CONFIG: join(root, 'config.toml') },
    cfg,
  );
  delete env.DELEGATE_RUN_ID;
  const config = `${[
    ['owner_room', cfg.ownerRoom],
    ['owner_room_dir', cfg.ownerRoomDir],
    ['mail_root', cfg.mailRoot],
    ['sidecar_dir', cfg.sidecarDir],
    ['allowed_signers', cfg.allowedSigners],
    ['key_file', cfg.keyFile],
    ['signing_namespace', cfg.namespace],
    ['principal', cfg.principal],
    ['marker', cfg.marker],
    ['label', cfg.label],
  ]
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join('\n')}\n`;
  writeFileSync(env.PORCH_CONFIG as string, config, { mode: 0o600 });
  return { root, cfg, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export const jsonOutcome = (data: unknown, code = 0): Outcome => ({
  code,
  stdout: JSON.stringify(data),
  stderr: '',
});
export function raw(
  id = '20260930-230000-000001-abcdef',
  extra: Partial<RawRecord> = {},
): RawRecord {
  const r = parseRaw(
    {
      id,
      from: 'agent',
      channel: 'commons',
      sent: '2026-09-30T23:00:00Z',
      body: 'hello',
      from_participant: 'p-agent',
    },
    'commons',
  );
  if (r === undefined) throw new Error('test record failed to parse');
  return { ...r, ...extra };
}
export async function initializePost(s: ReturnType<typeof sandbox>): Promise<void> {
  if (!realPost) throw new Error('real post required by post-kit contract tests');
  const call = async (args: string[]) => {
    const out = await runProcess(realPost, {
      args,
      env: s.env,
      cwd: s.cfg.ownerRoomDir,
      timeoutMs: 10000,
    });
    if (out.code !== 0 || out.failed !== undefined)
      throw new Error(`post setup ${args.join(' ')}: ${out.stderr}`);
    return decodeJson(out.stdout, out.stderr);
  };
  await call(['doctor', '--fix', '--json']);
  await call(['rooms', 'add', s.cfg.ownerRoom, s.cfg.ownerRoomDir, '--json']);
  await call([
    'owner',
    'init',
    '--room',
    s.cfg.ownerRoom,
    '--marker',
    s.cfg.marker,
    '--label',
    s.cfg.label,
    '--sidecar-dir',
    s.cfg.sidecarDir,
    '--allowed-signers',
    s.cfg.allowedSigners,
    '--principal',
    s.cfg.principal,
    '--namespace',
    s.cfg.namespace,
    '--json',
  ]);
}
export function writeMessage(
  s: ReturnType<typeof sandbox>,
  record: Record<string, unknown>,
  channel = 'commons',
): void {
  const messages = join(s.cfg.mailRoot, 'channels', channel, 'messages');
  mkdirSync(messages, { recursive: true });
  const { body, ...envelope } = record;
  writeFileSync(
    join(messages, `${String(record.id)}.msg`),
    `${JSON.stringify(envelope)}\n---\n${String(body)}`,
    { mode: 0o600 },
  );
}
export function python(s: ReturnType<typeof sandbox>, code: string, args: string[] = []): string {
  const reference = referenceRoot;
  return execFileSync(join(reference, '.venv', 'bin', 'python'), ['-c', code, ...args], {
    env: { ...s.env, PYTHONPATH: join(reference, 'src'), PYTHONDONTWRITEBYTECODE: '1' },
    cwd: s.cfg.ownerRoomDir,
    encoding: 'utf8',
  });
}
export const goldenCases = JSON.parse(readFileSync(join(vectors, 'records.json'), 'utf8')) as {
  name: string;
  expected: string;
  record: Record<string, unknown>;
}[];
