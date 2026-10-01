/**
 * `porch-next init`: the real post binary end to end in a throwaway mail root, porch-tui's own
 * `run_init` agreeing on the result, and a stand-in post for the refusal and rollback paths. Keys
 * come from the real `ssh-keygen`, in temporary directories only.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postOwnerInitCommand } from '../../src/config/owner-check.ts';
import { buildConfig, loadConfigBytes } from '../../src/config/porch-config.ts';
import { type InitDeps, matchPatternList, parseInitArgs, runInit } from '../../src/init/init.ts';
import { type CommandRunner, runCommand, shellQuote } from '../../src/init/shell.ts';
import { cleanTemps, porchPython, pyJson, runPy, tempDir } from '../stores/pyharness.ts';

afterAll(cleanTemps);

const realPost = process.env.PORCH_REAL_POST ?? '';
const haveKeygen = spawnSync('ssh-keygen', ['-?']).error === undefined;

let home: string;
let room: string;
let mail: string;
let cfg: string;
beforeEach(() => {
  home = tempDir('porch-t3b-init-');
  room = join(home, 'room');
  mkdirSync(room);
  mail = join(home, 'mail');
  cfg = join(home, '.config', 'porch', 'config.toml');
});

type Captured = { out: string[]; err: string[] };
function deps(extra: Partial<InitDeps> = {}): InitDeps & Captured {
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.PORCH_CONFIG;
  return {
    env,
    home,
    isTty: false,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    tmpDir: tempDir('porch-t3b-keys-'),
    out,
    err,
    ...extra,
  };
}
const baseArgs = () => [
  '--owner-room',
  'mara',
  '--owner-room-dir',
  room,
  '--mail-root',
  mail,
  '--config',
  cfg,
];

/** Environment for running post as Trey would: no agent identity, this run's mail root. */
function postEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['POST_PARTICIPANT', 'POST_FROM', 'POST_SENDER_ADDRESS', 'POST_HARNESS']) {
    delete env[k];
  }
  env.POST_MAIL_ROOT = mail;
  env.HOME = home;
  return env;
}

describe.skipIf(realPost === '' || !haveKeygen)('against the real post', () => {
  it('names a working post owner init command, then initialises, then is idempotent', async () => {
    const add = spawnSync(realPost, ['rooms', 'add', 'mara', room, '--json'], {
      cwd: room,
      env: postEnv(),
      encoding: 'utf8',
    });
    expect(add.status, add.stdout + add.stderr).toBe(0);

    // 1. Post has no owner yet: init refuses and names the command, marker included.
    const first = deps({ post: realPost });
    expect(await runInit(baseArgs(), first)).toBe(2);
    const message = first.err.join('\n');
    const cmd = /run `([^`]+)` first/.exec(message)?.[1];
    expect(cmd, message).toBeDefined();
    expect(cmd).toContain(" --marker '🦊'");
    expect(existsSync(cfg)).toBe(false);

    // 2. Run exactly that command through a shell, with `post` resolving to the real binary.
    const bin = join(home, 'bin');
    mkdirSync(bin);
    symlinkSync(realPost, join(bin, 'post'));
    const shellEnv = postEnv();
    delete shellEnv.POST_MAIL_ROOT; // the printed command carries it
    shellEnv.PATH = `${bin}:${shellEnv.PATH}`;
    const ran = spawnSync('bash', ['-c', cmd as string], {
      cwd: room,
      env: shellEnv,
      encoding: 'utf8',
    });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);

    // 3. Now init writes the key pair, the signer line and the config.
    const second = deps({ post: realPost });
    expect(await runInit(baseArgs(), second), second.err.join('\n')).toBe(0);
    const key = join(room, 'mara_porch_key');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(`${key}.pub`).mode & 0o777).toBe(0o644);
    const signers = join(room, 'allowed_signers');
    expect(statSync(signers).mode & 0o777).toBe(0o600);
    const pub = readFileSync(`${key}.pub`, 'utf8').split(' ');
    expect(readFileSync(signers, 'utf8')).toBe(
      `mara@porch namespaces="mara-porch" ${pub[0]} ${pub[1]}\n`,
    );
    const written = loadConfigBytes(readFileSync(cfg), { env: {}, home });
    expect(written.mailRoot).toBe(mail);
    expect(written.marker).toBe('🦊');

    // 4. Again: identical, nothing changes.
    const snapshot = () =>
      [cfg, signers, key, `${key}.pub`].map((p) => [readFileSync(p, 'hex'), statSync(p).mtimeMs]);
    const before = snapshot();
    const third = deps({ post: realPost });
    expect(await runInit(baseArgs(), third)).toBe(0);
    expect(third.out.join('\n')).toContain('config already present and identical');
    expect(snapshot()).toEqual(before);

    // 5. porch-tui's own init agrees: identical, returns 0, changes nothing.
    if (porchPython !== null) {
      const py = runPy(
        `from pathlib import Path
from porch3.initcli import run_init
print(run_init(owner_room='mara', owner_room_dir=INPUT['room'], mail_root=INPUT['mail'], config_path=Path(INPUT['cfg']), interactive=False))`,
        { room, mail, cfg },
        { porch: true, env: { ...shellEnv, POST_MAIL_ROOT: mail } },
      );
      expect(py.status, py.stderr).toBe(0);
      expect(py.stdout).toContain('config already present and identical');
      expect(py.stdout.trim().endsWith('0')).toBe(true);
      expect(snapshot()).toEqual(before);
    }
  });
});

// --- a stand-in post ---------------------------------------------------------------------------

type Answer = { status?: number; body: unknown };
function standIn(answers: { owner: Answer; profile: Answer }): { post: string; log: string } {
  const dir = tempDir('porch-t3b-standin-');
  const log = join(dir, 'calls.jsonl');
  const answersPath = join(dir, 'answers.json');
  writeFileSync(answersPath, JSON.stringify(answers));
  const post = join(dir, 'post');
  writeFileSync(
    post,
    `#!/usr/bin/env python3
import json, os, sys
answers = json.load(open(${JSON.stringify(answersPath)}))
open(${JSON.stringify(log)}, 'a').write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'root': os.environ.get('POST_MAIL_ROOT'), 'participant': os.environ.get('POST_PARTICIPANT')}) + '\\n')
a = answers['owner' if sys.argv[1] == 'owner' else 'profile']
print(json.dumps(a['body']))
sys.exit(a.get('status', 0))
`,
  );
  chmodSync(post, 0o755);
  return { post, log };
}
const ownerOk = (over: Record<string, string> = {}) => ({
  body: {
    ok: true,
    state: 'configured',
    owner: {
      room: 'mara',
      sidecar_dir: room,
      allowed_signers: join(room, 'allowed_signers'),
      principal: 'mara@porch',
      namespace: 'mara-porch',
      marker: '🦊',
      label: 'Mara',
      ...over,
    },
  },
});
const profileOk = (r = 'mara') => ({ body: { ok: true, room: r, profile: {} } });

describe.skipIf(!haveKeygen)('with a stand-in post', () => {
  it('runs post in the owner room, with the mail root pinned and no agent identity', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const d = deps({ post: s.post, env: { ...deps().env, POST_PARTICIPANT: 'agent-x' } });
    expect(await runInit(baseArgs(), d), d.err.join('\n')).toBe(0);
    const calls = readFileSync(s.log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(calls.map((c) => c.argv)).toEqual([
      ['owner', 'show', '--json'],
      ['profile', 'show', '--json'],
    ]);
    for (const c of calls) {
      expect(c.cwd).toBe(room);
      expect(c.root).toBe(mail);
      expect(c.participant).toBeNull();
    }
  });

  it('tolerates JSON members post adds later', async () => {
    const owner = ownerOk();
    (owner.body as Record<string, unknown>).future = { x: 1 };
    (owner.body.owner as Record<string, unknown>).future_field = 'x';
    const profile = {
      body: { ok: true, room: 'mara', profile: { name: 'M', badge: 'new' }, v: 2 },
    };
    const s = standIn({ owner, profile });
    const d = deps({ post: s.post });
    expect(await runInit(baseArgs(), d), d.err.join('\n')).toBe(0);
  });

  it('always names --marker, even for the default marker', async () => {
    const s = standIn({ owner: { body: { ok: true, state: 'none' } }, profile: profileOk() });
    const d = deps({ post: s.post });
    expect(await runInit([...baseArgs(), '--label', "O'Hara"], d)).toBe(2);
    const text = d.err.join('\n');
    expect(text).toContain(
      `run \`env POST_MAIL_ROOT=${shellQuote(mail)} post owner init --room mara --marker '🦊' --label 'O'"'"'Hara'\` first`,
    );
    expect(existsSync(join(room, 'mara_porch_key'))).toBe(false);
  });

  it('refuses before any change when post disagrees', async () => {
    for (const [owner, profile, pattern] of [
      [ownerOk({ marker: '🧔' }), profileOk(), /marker: porch="🦊" post="🧔"/],
      [ownerOk(), profileOk('someone-else'), /acting-room mismatch/],
      [{ status: 3, body: { ok: false } }, profileOk(), /exited 3/],
      [
        { body: { ok: true, state: 'configured', owner: { room: 'mara' } } },
        profileOk(),
        /missing/,
      ],
    ] as const) {
      const s = standIn({ owner, profile });
      const d = deps({ post: s.post });
      expect(await runInit(baseArgs(), d)).toBe(2);
      expect(d.err.join('\n')).toMatch(pattern);
      expect(existsSync(join(room, 'mara_porch_key'))).toBe(false);
      expect(existsSync(join(room, 'allowed_signers'))).toBe(false);
      expect(existsSync(cfg)).toBe(false);
    }
  });

  it('refuses a different existing config and a symlinked one', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    mkdirSync(join(home, '.config', 'porch'), { recursive: true });
    writeFileSync(
      cfg,
      `owner_room = "mara"\nowner_room_dir = "${room}"\nmail_root = "/elsewhere"\n`,
    );
    const d = deps({ post: s.post });
    expect(await runInit(baseArgs(), d)).toBe(2);
    expect(d.err.join('\n')).toMatch(/different values — refuse/);

    const cfg2 = join(home, 'link.toml');
    symlinkSync(cfg, cfg2);
    const d2 = deps({ post: s.post });
    const args = baseArgs();
    args[args.length - 1] = cfg2;
    expect(await runInit(args, d2)).toBe(2);
    expect(d2.err.join('\n')).toMatch(/refusing symlink/);
  });

  it('rolls back the new key pair when allowed_signers already authorises the principal', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const signers = join(room, 'allowed_signers');
    for (const existing of [
      '* namespaces="x" ssh-ed25519 AAAAother\n',
      'mara@porch namespaces="mara-porch" ssh-ed25519 AAAAdifferent\n',
    ]) {
      writeFileSync(signers, existing, { mode: 0o644 });
      const d = deps({ post: s.post });
      expect(await runInit(baseArgs(), d)).toBe(2);
      expect(d.err.join('\n')).toMatch(/refuse/);
      expect(existsSync(join(room, 'mara_porch_key'))).toBe(false);
      expect(existsSync(join(room, 'mara_porch_key.pub'))).toBe(false);
      expect(readFileSync(signers, 'utf8')).toBe(existing);
    }
  });

  it('restores allowed_signers bytes and mode when the config commit fails', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const signers = join(room, 'allowed_signers');
    const existing = 'other@porch namespaces="other-porch" ssh-ed25519 AAAAother\n';
    writeFileSync(signers, existing);
    chmodSync(signers, 0o644);
    // The config's parent is a regular file, so the commit cannot create it.
    writeFileSync(join(home, 'blocker'), '');
    const args = baseArgs();
    args[args.length - 1] = join(home, 'blocker', 'config.toml');
    const d = deps({ post: s.post });
    expect(await runInit(args, d)).toBe(4);
    expect(readFileSync(signers, 'utf8')).toBe(existing);
    expect(statSync(signers).mode & 0o777).toBe(0o644);
    expect(existsSync(join(room, 'mara_porch_key'))).toBe(false);
    expect(existsSync(join(room, 'mara_porch_key.pub'))).toBe(false);
  });

  it('adopts a matching 0600 key pair and refuses a loose or partial one', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const key = join(room, 'mara_porch_key');
    const gen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', key, '-N', '', '-q', '-C', 'x']);
    expect(gen.status).toBe(0);
    const keyBytes = readFileSync(key);

    chmodSync(key, 0o644);
    const loose = deps({ post: s.post });
    expect(await runInit(baseArgs(), loose)).toBe(2);
    expect(loose.err.join('\n')).toMatch(/want 0600/);

    chmodSync(key, 0o600);
    const d = deps({ post: s.post });
    expect(await runInit(baseArgs(), d), d.err.join('\n')).toBe(0);
    expect(readFileSync(key).equals(keyBytes)).toBe(true);
    const pub = readFileSync(`${key}.pub`, 'utf8').split(' ');
    expect(readFileSync(join(room, 'allowed_signers'), 'utf8')).toContain(`${pub[0]} ${pub[1]}`);

    const room2 = join(home, 'room2');
    mkdirSync(room2);
    writeFileSync(join(room2, 'mara_porch_key.pub'), 'ssh-ed25519 AAAA x\n');
    const s2 = standIn({
      owner: ownerOk({ sidecar_dir: room2, allowed_signers: join(room2, 'allowed_signers') }),
      profile: profileOk(),
    });
    const partial = deps({ post: s2.post });
    const args = baseArgs();
    args[3] = room2;
    args[args.length - 1] = join(home, 'cfg2.toml');
    expect(await runInit(args, partial)).toBe(2);
    expect(partial.err.join('\n')).toMatch(/partially present/);
  });

  it('prompts on a terminal, and encrypts the key with the passphrase through askpass', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const answers: Record<string, string> = {
      owner_room: 'mara',
      'owner_room_dir (absolute)': room,
      marker: '',
      label: '',
      mail_root: mail,
      initial_channel: '',
    };
    const asked: string[] = [];
    const d = deps({
      post: s.post,
      isTty: true,
      prompt: async (q) => {
        asked.push(q);
        const key = q.replace(/( \[.*\])?: $/, '');
        return answers[key] ?? '';
      },
      promptHidden: async () => 'correct horse',
    });
    expect(await runInit(['--config', cfg], d), d.err.join('\n')).toBe(0);
    expect(asked).toContain('marker [🦊]: ');
    expect(asked).toContain('label [Mara]: ');
    const key = join(room, 'mara_porch_key');
    const noPass = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', key]);
    expect(noPass.status).not.toBe(0);
    const withPass = spawnSync('ssh-keygen', ['-y', '-P', 'correct horse', '-f', key]);
    expect(withPass.status).toBe(0);
  });

  /** A runner that, once ssh-keygen has generated a key, holds init there until released. */
  function gatedKeygen() {
    let enter = () => {};
    let release = () => {};
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run: CommandRunner = async (program, args, options) => {
      const result = await runCommand(program, args, options);
      if (program === 'ssh-keygen' && args.includes('-t')) {
        enter();
        await gate;
      }
      return result;
    };
    return { run, entered, release };
  }
  const settles = (p: Promise<number>) => {
    const state = { settled: false, done: p };
    state.done = p.then((code) => {
      state.settled = true;
      return code;
    });
    return state;
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const signerLine = (keyFile: string) => {
    const pub = readFileSync(`${keyFile}.pub`, 'utf8').split(' ');
    return `mara@porch namespaces="mara-porch" ${pub[0]} ${pub[1]}\n`;
  };

  it('holds allowed_signers locked for its whole run, so a concurrent init waits, then refuses', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const gated = gatedKeygen();
    const a = deps({ post: s.post, run: gated.run });
    const first = runInit(baseArgs(), a);
    await gated.entered; // A is inside its transaction: a key generated, nothing installed yet
    const b = deps({ post: s.post });
    const second = settles(runInit([...baseArgs(), '--initial-channel', 'elsewhere'], b));
    await pause(1500);
    expect(second.settled).toBe(false);
    expect(existsSync(cfg)).toBe(false);
    gated.release();
    expect(await first, a.err.join('\n')).toBe(0);
    expect(await second.done).toBe(2);
    expect(b.err.join('\n')).toMatch(/different values — refuse/);
    // A's identity is whole and consistent: its key, its one signer line, its config.
    const key = join(room, 'mara_porch_key');
    expect(readFileSync(join(room, 'allowed_signers'), 'utf8')).toBe(signerLine(key));
    expect(loadConfigBytes(readFileSync(cfg), { env: {}, home }).initialChannel).not.toBe(
      'elsewhere',
    );
  });

  it('lets a concurrent identical init wait, then find the config present and change nothing', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const gated = gatedKeygen();
    const a = deps({ post: s.post, run: gated.run });
    const first = runInit(baseArgs(), a);
    await gated.entered;
    const b = deps({ post: s.post });
    const second = settles(runInit(baseArgs(), b));
    await pause(800);
    expect(second.settled).toBe(false);
    gated.release();
    expect(await first, a.err.join('\n')).toBe(0);
    const files = [cfg, join(room, 'allowed_signers'), join(room, 'mara_porch_key')];
    const after = files.map((p) => readFileSync(p, 'hex'));
    expect(await second.done, b.err.join('\n')).toBe(0);
    expect(b.out.join('\n')).toContain('config already present and identical');
    expect(files.map((p) => readFileSync(p, 'hex'))).toEqual(after);
  });

  it('rolls back only its own work while a concurrent init waits, which then succeeds', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const gated = gatedKeygen();
    writeFileSync(join(home, 'blocker'), '');
    const failing = baseArgs();
    failing[failing.length - 1] = join(home, 'blocker', 'config.toml'); // its commit will fail
    const a = deps({ post: s.post, run: gated.run });
    const first = runInit(failing, a);
    await gated.entered;
    const b = deps({ post: s.post });
    const second = settles(runInit(baseArgs(), b));
    await pause(1500);
    expect(second.settled).toBe(false);
    gated.release();
    expect(await first).toBe(4);
    expect(await second.done, b.err.join('\n')).toBe(0);
    // B's key pair, B's line alone, B's config: A's rollback removed nothing of B's.
    const key = join(room, 'mara_porch_key');
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(room, 'allowed_signers'), 'utf8')).toBe(signerLine(key));
    expect(existsSync(cfg)).toBe(true);
  });

  it('starts a new line when allowed_signers ends without one, and ssh reads both signers', async () => {
    const s = standIn({ owner: ownerOk(), profile: profileOk() });
    const other = join(home, 'other_key');
    expect(spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', other, '-N', '', '-q']).status).toBe(0);
    const otherPub = readFileSync(`${other}.pub`, 'utf8').split(' ');
    const signers = join(room, 'allowed_signers');
    writeFileSync(signers, `other@porch namespaces="mara-porch" ${otherPub[0]} ${otherPub[1]}`, {
      mode: 0o600,
    });
    const d = deps({ post: s.post });
    expect(await runInit(baseArgs(), d), d.err.join('\n')).toBe(0);

    // Sign with each key and let ssh-keygen read allowed_signers to say who signed.
    const message = join(home, 'message');
    writeFileSync(message, 'hello\n');
    for (const [keyFile, principal] of [
      [other, 'other@porch'],
      [join(room, 'mara_porch_key'), 'mara@porch'],
    ] as const) {
      const sig = `${message}.sig`;
      if (existsSync(sig)) unlinkSync(sig);
      const signed = spawnSync('ssh-keygen', [
        '-Y',
        'sign',
        '-f',
        keyFile,
        '-n',
        'mara-porch',
        message,
      ]);
      expect(signed.status, signed.stderr.toString()).toBe(0);
      const found = spawnSync(
        'ssh-keygen',
        ['-Y', 'find-principals', '-s', sig, '-f', signers, '-n', 'mara-porch'],
        { encoding: 'utf8' },
      );
      expect(found.status, found.stderr).toBe(0);
      expect(found.stdout.trim()).toBe(principal);
      const verified = spawnSync(
        'ssh-keygen',
        ['-Y', 'verify', '-f', signers, '-I', principal, '-n', 'mara-porch', '-s', sig],
        { input: readFileSync(message), encoding: 'utf8' },
      );
      expect(verified.status, verified.stderr).toBe(0);
    }
  });
});

describe('arguments and helpers', () => {
  it('parses flags like argparse', () => {
    expect(parseInitArgs(['--owner-room=mara', '--label', 'M', '--from-legacy'])).toMatchObject({
      ownerRoom: 'mara',
      label: 'M',
      fromLegacy: true,
    });
    expect(() => parseInitArgs(['--bogus'])).toThrow(/unrecognized/);
    expect(() => parseInitArgs(['--label'])).toThrow(/expected one argument/);
    expect(() => parseInitArgs(['--label', '--marker'])).toThrow(/expected one argument/);
  });

  it('answers -h and refuses bad arguments with exit 2', async () => {
    const d = deps();
    expect(await runInit(['-h'], d)).toBe(0);
    expect(d.out[0]).toMatch(/^usage: porch-next init/);
    expect(await runInit(['--nope'], deps())).toBe(2);
    expect(await runInit([], deps())).toBe(2);
  });

  it.skipIf(porchPython === null)(
    'matches porch-tui on quoting, patterns and the init command',
    () => {
      const quotes = ['', 'plain/path-1.2', "it's", 'a b', '🦊', '$HOME', 'x=y,z:@%+'];
      const patterns: [string, string][] = [
        ['*', 'mara@porch'],
        ['mara@porch', 'mara@porch'],
        ['!mara@porch,*', 'mara@porch'],
        ['*,!mara@porch', 'mara@porch'],
        ['m?ra@*', 'mara@porch'],
        ['MARA@porch', 'mara@porch'],
        ['!other,x', 'mara@porch'],
        [',,', 'mara@porch'],
        ['*@porch', 'mara@porch'],
        ['ma*ch', 'mara@porch'],
        ['ma*x', 'mara@porch'],
      ];
      const configs = [
        { ownerRoom: 'mara', ownerRoomDir: '/r/mara', mailRoot: '/m' },
        {
          ownerRoom: 'mara',
          ownerRoomDir: '/r/mara',
          mailRoot: "/m/it's here",
          marker: '🧔',
          label: 'Trey',
          sidecarDir: '/s',
          principal: 'p@x',
          signingNamespace: 'ns',
        },
      ];
      const py = pyJson<{ q: string[]; p: boolean[]; c: string[] }>(
        `import shlex
from pathlib import Path
from porch3.initcli import _match_pattern_list
from porch3.roomcheck import post_owner_init_command
from porch3.config import build_config
def cfg(c):
    kw = dict(owner_room=c['ownerRoom'], owner_room_dir=Path(c['ownerRoomDir']), mail_root=Path(c['mailRoot']))
    for k, n in [('marker', 'marker'), ('label', 'label'), ('sidecarDir', 'sidecar_dir'), ('principal', 'principal'), ('signingNamespace', 'signing_namespace')]:
        if k in c: kw[n] = c[k]
    return build_config(**kw)
print(json.dumps({'q': [shlex.quote(s) for s in INPUT['q']], 'p': [_match_pattern_list(a, b) for a, b in INPUT['p']], 'c': [post_owner_init_command(cfg(c)) for c in INPUT['c']]}))`,
        { q: quotes, p: patterns, c: configs },
        { porch: true, env: { HOME: home } },
      );
      expect(quotes.map(shellQuote)).toEqual(py.q);
      expect(patterns.map(([a, b]) => matchPatternList(a, b))).toEqual(py.p);
      const ours = configs.map((c) => postOwnerInitCommand(buildConfig(c, { env: {}, home })));
      // porch-tui drops --marker for its own default; porch-next always passes it.
      expect(ours[0]).toBe(
        (py.c[0] as string).replace(' --room mara', " --room mara --marker '🦊'"),
      );
      expect(ours[1]).toBe(py.c[1]);
      expect(py.c[0]).not.toContain('--marker');
    },
  );
});
