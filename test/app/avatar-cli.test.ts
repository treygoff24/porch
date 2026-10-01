/**
 * `porch-next avatar`: list, preview and set. Set is exercised through a stubbed post runner, and
 * once through the installed post against a throwaway store (never ~/.claude-mail), so the pack the
 * picker writes is the pack post's own validator accepts.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAvatar } from '@estate/pixel';
import type { Outcome, Runner } from '@estate/post-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { AVATAR_USAGE, runAvatar } from '../../src/app/avatar-cli.ts';

type Run = {
  code: number;
  out: string;
  err: string;
  calls: { bin: string; args: string[]; file: string }[];
};

async function run(
  argv: string[],
  opts: {
    env?: NodeJS.ProcessEnv;
    post?: (file: string) => Outcome;
    /** Use the real post-kit runner (the installed post) instead of the stub. */
    real?: boolean;
  } = {},
): Promise<Run> {
  const r: Run = { code: 0, out: '', err: '', calls: [] };
  const run: Runner = async (bin, spec) => {
    const file = spec.args[spec.args.indexOf('--file') + 1] as string;
    r.calls.push({ bin, args: [...spec.args], file: readFileSync(file, 'utf8') });
    return opts.post?.(file) ?? { code: 0, stdout: '{"ok":true,"warnings":[]}', stderr: '' };
  };
  r.code = await runAvatar(argv, {
    stdout: (t) => {
      r.out += t;
    },
    stderr: (t) => {
      r.err += t;
    },
    env: opts.env ?? {},
    ...(opts.real === true ? {} : { run }),
  });
  return r;
}

describe('list', () => {
  it('prints the characters, presets and emotes and exits 0', async () => {
    const r = await run(['list']);
    expect(r.code).toBe(0);
    for (const n of ['bot:', 'critter:', 'shroom:', 'kid:', 'owl:', 'bolt:', 'blob:', 'cheer:']) {
      expect(r.out).toContain(n);
    }
  });
  it('with no subcommand prints usage and exits 2', async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    expect(r.out).toBe(AVATAR_USAGE);
  });
});

describe('preview', () => {
  it('--plain prints the idle body and head as digits, 16 and 8 rows', async () => {
    const r = await run(['preview', 'owl', '--variant', '1', '--accent', 'c', '--plain']);
    expect(r.code).toBe(0);
    const rows = r.out.split('\n').filter((l) => /^[.0-9a-f]{16}$/.test(l));
    expect(rows).toHaveLength(16);
    expect(r.out.split('\n').filter((l) => /^[.0-9a-f]{8}$/.test(l))).toHaveLength(8);
    expect(r.out).not.toContain('\x1b');
    expect(r.out).toContain('accent violet (c)');
  });
  it('NO_COLOR in the environment gives the plain digits too', async () => {
    const r = await run(['preview', 'bot'], { env: { NO_COLOR: '1' } });
    expect(r.out).not.toContain('\x1b');
    expect(r.out).toMatch(/^[.0-9a-f]{16}$/m);
  });
  it('by default draws truecolor half blocks in the sprite palette', async () => {
    const r = await run(['preview', 'kid', '--accent', 'orange']);
    expect(r.out).toContain('\x1b[38;2;255;138;42m'); // orange (9) is #ff8a2a
    expect(r.out).toMatch(/[▀▄]/);
    expect(r.out.split('\n').filter((l) => l.includes('\x1b[0m'))).toHaveLength(8 + 4);
  });
  it('shows a preset, with only its accent changed', async () => {
    const r = await run(['preview', 'mochi', '--accent', 'blue', '--plain']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('accent blue (4)');
  });
  it('refuses --emote, which only set uses', async () => {
    const r = await run(['preview', 'bot', '--emote', 'cheer']);
    expect(r.code).toBe(2);
  });
});

describe('errors list the valid choices and exit 2, touching nothing', () => {
  const cases: [string[], RegExp][] = [
    [['set', 'dragon'], /Characters: bot, critter, shroom, kid, owl/],
    [['set', 'kid', '--variant', '9'], /0 short hair; 1 spiky hair/],
    [['set', 'kid', '--variant', 'x'], /whole number/],
    [['set', 'kid', '--accent', 'red'], /Accents: .*steel \(2\)/],
    [['set', 'owl', '--eyes', 'plaid'], /Choices here: .*ink \(0\)/],
    [['set', 'owl', '--emote', 'moonwalk'], /Premade emotes: cheer, nod/],
    [['set', 'bolt', '--variant', '1'], /only --accent/],
    [['set'], /name one character/],
    [['set', 'owl', '--wings', '2'], /unknown option --wings/],
    [['set', 'owl', '--accent'], /needs a value/],
    [['frobnicate'], /unknown subcommand/],
  ];
  for (const [argv, want] of cases) {
    it(argv.join(' '), async () => {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(want);
      expect(r.calls).toEqual([]);
    });
  }
});

describe('set', () => {
  it('--dry-run prints the pack JSON, valid, and does not call post', async () => {
    const r = await run([
      'set',
      'critter',
      '--variant',
      '2',
      '--accent',
      'pink',
      '--emote',
      'cheer',
      'nod',
      '--dry-run',
    ]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    const pack = JSON.parse(r.out);
    expect(pack.format).toBe(1);
    expect(pack.accent).toBe('d');
    expect(Object.keys(pack.emotes).sort()).toEqual(['cheer', 'nod']);
    expect(parseAvatar(new TextEncoder().encode(r.out)).rules).toEqual([]);
  });

  it('accepts --flag=value and a comma list of emotes', async () => {
    const r = await run(['set', 'shroom', '--accent=violet', '--emote=cheer,sleepy', '--dry-run']);
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.out).emotes).sort()).toEqual(['cheer', 'sleepy']);
  });

  it('writes the pack to a temp file, runs post profile avatar set --file on it, and cleans up', async () => {
    const r = await run(['set', 'bot', '--accent', 'green', '--eyes', 'pink', '--emote', 'shrug'], {
      env: { PORCH_POST_BIN: '/stub/post' },
    });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0] as Run['calls'][number];
    expect(call.bin).toBe('/stub/post');
    expect(call.args.slice(0, 4)).toEqual(['profile', 'avatar', 'set', '--file']);
    const file = call.args[4] as string;
    expect(existsSync(file)).toBe(false);
    const pack = JSON.parse(call.file);
    expect(pack.accent).toBe('6');
    expect(pack.emotes.shrug).toBeDefined();
    expect(parseAvatar(new TextEncoder().encode(call.file)).rules).toEqual([]);
    expect(r.out).toContain('avatar set: bot');
    // Post's reply echoes the whole avatar; the verdict is one line.
    expect(r.out.split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('prints post warnings, and post’s verdict and exit code when it refuses', async () => {
    const warned = await run(['set', 'owl'], {
      post: () => ({
        code: 0,
        stdout: '{"ok":true,"warnings":["pixel-char later"]}',
        stderr: '',
      }),
    });
    expect(warned.out).toContain('post warning: pixel-char later');

    const refused = await run(['set', 'owl'], {
      post: () => ({
        code: 65,
        stdout: '{"ok":false,"error":{"code":"avatar_invalid"}}',
        stderr: 'nope',
      }),
    });
    expect(refused.code).toBe(65);
    expect(refused.out).toContain('avatar_invalid');
    expect(refused.err).toContain('nope');
    expect(refused.err).toContain('nothing was stored');
  });
});

describe('set against the installed post, in a throwaway store', () => {
  const root = mkdtempSync(join(tmpdir(), 'porch-avatar-post-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const real = process.env.PORCH_REAL_POST ?? '';

  it('is accepted by post’s own validator, and post shows what was stored', async () => {
    if (real === '') throw new Error('the installed post is required (PORCH_REAL_POST)');
    const env = { ...process.env, POST_MAIL_ROOT: join(root, 'mail'), PORCH_POST_BIN: real };
    const bind = spawnSync(real, ['participant', 'bind', '--new'], { encoding: 'utf8', env });
    const participant = /POST_PARTICIPANT=(\S+)/.exec(bind.stdout)?.[1];
    expect(participant, bind.stderr).toBeDefined();
    const withWho = { ...env, POST_PARTICIPANT: participant as string };
    const every = ['cheer', 'nod', 'shrug', 'sleepy', 'excited', 'oops'];
    for (const [argv, accent] of [
      [
        [
          'set',
          'kid',
          '--variant',
          '1',
          '--accent',
          'orange',
          '--eyes',
          'blue',
          '--secondary',
          'violet',
          '--emote',
          ...every,
        ],
        '9',
      ],
      [['set', 'ribbit', '--accent', 'pink', '--emote', ...every], 'd'],
    ] as const) {
      const r = await run([...argv], { env: withWho, real: true });
      expect(r.code, r.out + r.err).toBe(0);
      const shown = spawnSync(real, ['profile', 'avatar', 'show'], {
        encoding: 'utf8',
        env: withWho,
      });
      const stored = JSON.parse(shown.stdout);
      expect(stored.ok).toBe(true);
      expect(stored.warnings).toEqual([]);
      expect(stored.avatar.accent).toBe(accent);
      expect(Object.keys(stored.avatar.emotes)).toEqual(expect.arrayContaining(every));
    }
  });
});
