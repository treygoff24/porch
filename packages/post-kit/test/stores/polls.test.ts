/**
 * Polls: tallies and listings must match porch-tui's `post-poll` script, run for real with `HOME`
 * pointed at a temporary directory (post-poll reads `~/.claude-mail`, so the temporary home keeps it
 * off Trey's mail). A stand-in `post` records what `new` and `vote` would send.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ballotBody,
  checkVote,
  findBallots,
  findPolls,
  formatPollList,
  formatTally,
  loadChannelMessages,
  newPollId,
  PollError,
  parseMessageText,
  pollBody,
  tally,
} from '../../src/stores/polls.ts';
import { cleanTemps, porchTuiDir, python3, tempDir } from './pyharness.ts';

afterAll(cleanTemps);

const postPoll = join(porchTuiDir, 'post-poll');
const havePostPoll = python3 && existsSync(postPoll);

let home: string;
let mailRoot: string;
let seq = 0;
beforeEach(() => {
  home = tempDir('porch-t3b-home-');
  mailRoot = join(home, '.claude-mail');
  seq = 0;
});

function msg(channel: string, from: unknown, body: string, extra: Record<string, unknown> = {}) {
  const dir = join(mailRoot, 'channels', channel, 'messages');
  mkdirSync(dir, { recursive: true });
  seq++;
  const id = `20260930-0700${String(seq).padStart(2, '0')}-000001-abcdef`;
  const head = JSON.stringify(
    { id, from, sent: `2026-09-30T07:00:${String(seq).padStart(2, '0')}.123456Z`, ...extra },
    null,
    2,
  );
  writeFileSync(join(dir, `${id}.msg`), `${head}\n---\n${body}`);
  return id;
}

function runPostPoll(args: string[], fakePostLog?: string) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.HOME = home;
  if (fakePostLog !== undefined) {
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'post');
    writeFileSync(
      fake,
      `#!/usr/bin/env python3\nimport json, sys\nopen(${JSON.stringify(fakePostLog)}, 'a').write(json.dumps(sys.argv[1:]) + '\\n')\n`,
    );
    chmodSync(fake, 0o755);
    env.PATH = `${bin}:${env.PATH}`;
  }
  const r = spawnSync('python3', [postPoll, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function busyChannel(channel: string) {
  msg(channel, 'mara', '📊 POLL p0930-070000: Ship it?\na) yes\nb) no\n  c)  later  \nvote: …');
  msg(channel, 'ann', '🗳️ p0930-070000: a');
  msg(channel, 'bob', '🗳️ p0930-070000: B please');
  msg(channel, 'cy', '🗳️ p0930-070000:c');
  msg(channel, 'ann', '🗳️ p0930-070000: b'); // revote: latest wins
  msg(channel, 'trey-devbox', '🦊 🗳️ p0930-070000: a'); // casual owner line: not a ballot
  msg(channel, 'dee', '🗳️ p0930-070000: z'); // counts as a vote, for no option
  msg(channel, 'eve', '🗳️ p0930-070000:   '); // empty choice: ignored
  msg(channel, 'fay', '  🗳️ p0930-070000: a  '); // body is stripped first
  msg(channel, 'gus', '🗳️ p0930-070000: Ärger'); // non-ASCII first letter
  msg(channel, 'mara', '📊 POLL p0930-070100 : Lunch?\r\na) tacos\r\na) pizza\r\nb) soup');
  msg(channel, 'mara', '📊 POLL p0930-070200 no colon\na) x');
  msg(channel, 'mara', '📊 POLL p0930-070300: no options\njust text');
  msg(channel, 'hal', '🗳️ p0930-070100: A');
  msg(channel, 5, '🗳️ p0930-070000: a'); // non-string sender: post-poll would crash; skipped
  const dir = join(mailRoot, 'channels', channel, 'messages');
  writeFileSync(join(dir, '20260930-075959-000001-abcdef.msg'), 'not json\n---\n🗳️ p0930-070000: a');
  writeFileSync(join(dir, 'ignored.txt'), '{}\n---\n🗳️ p0930-070000: a');
}

describe.skipIf(!havePostPoll)('against post-poll', () => {
  it('tallies exactly as post-poll prints it', () => {
    busyChannel('commons');
    // post-poll crashes on the non-string sender, so compare on a copy without it.
    const clean = 'clean';
    busyChannel(clean);
    const skip = 'from": 5';
    const dir = join(mailRoot, 'channels', clean, 'messages');
    for (const name of readdirSync(dir)) {
      if (readFileSync(join(dir, name), 'utf8').includes(skip)) {
        writeFileSync(join(dir, name), '{"from": "x"}\n---\nunrelated');
      }
    }
    for (const pid of ['p0930-070000', 'p0930-070100']) {
      const expected = runPostPoll(['-c', clean, 'tally', pid]);
      expect(expected.status, expected.stderr).toBe(0);
      // Not a vacuous match: real votes, voters and a leader are on the line.
      expect(expected.stdout).toMatch(/votes\)\n[\s\S]*█[\s\S]*◀[\s\S]*\[/u);
      const msgs = loadChannelMessages(mailRoot, clean);
      const poll = findPolls(msgs).get(pid);
      if (poll === undefined) throw new Error(`no poll ${pid}`);
      const ours = formatTally(tally(poll, findBallots(msgs, pid)));
      expect(`${ours.join('\n')}\n`).toBe(expected.stdout);
    }
    // The skipped sender changes nothing else: the busy channel tallies the same.
    const busy = loadChannelMessages(mailRoot, 'commons');
    const clean0 = loadChannelMessages(mailRoot, clean);
    expect(findBallots(busy, 'p0930-070000')).toEqual(findBallots(clean0, 'p0930-070000'));
  });

  it('lists polls exactly as post-poll prints them', () => {
    busyChannel('commons');
    msg('empty', 'x', 'hello');
    for (const ch of ['commons', 'empty']) {
      const dir = join(mailRoot, 'channels', ch, 'messages');
      // Drop the non-string sender for post-poll's sake.
      for (const name of readdirSync(dir)) {
        if (readFileSync(join(dir, name), 'utf8').includes('from": 5')) {
          writeFileSync(join(dir, name), '{"from": "x"}\n---\nunrelated');
        }
      }
      const expected = runPostPoll(['-c', ch, 'list']);
      expect(expected.status, expected.stderr).toBe(0);
      const ours = formatPollList(loadChannelMessages(mailRoot, ch), ch);
      expect(`${ours.join('\n')}\n`).toBe(expected.stdout);
    }
  });

  it('builds the bodies post-poll sends for new polls and votes', () => {
    msg('commons', 'mara', '📊 POLL p0930-070000: Ship it?\na) yes\nb) no');
    const log = join(home, 'sent.jsonl');
    const made = runPostPoll(['new', 'Ship "it"?', 'yes', 'no', 'maybe 🦊'], log);
    expect(made.status, made.stderr).toBe(0);
    const voted = runPostPoll(['vote', 'p0930-070000', 'B'], log);
    expect(voted.status, voted.stderr).toBe(0);
    const [newArgs, voteArgs] = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    const sentNew = (newArgs as string[])[4] as string;
    const pid = /^📊 POLL (p\d{4}-\d{6}):/u.exec(sentNew)?.[1] as string;
    expect(pollBody(pid, 'Ship "it"?', ['yes', 'no', 'maybe 🦊'])).toBe(sentNew);
    expect(newArgs?.slice(0, 4)).toEqual(['chat', 'commons', '--send', '--body']);
    expect(ballotBody('p0930-070000', 'B')).toBe((voteArgs as string[])[4]);
  });
});

describe('poll rules', () => {
  it('mints ids as post-poll does', () => {
    expect(newPollId(new Date(Date.UTC(2026, 8, 3, 4, 5, 6)))).toBe('p0903-040506');
  });

  it('checks votes the way post-poll vote does', () => {
    msg('commons', 'mara', '📊 POLL p1: Q\na) x\nb) y');
    const polls = findPolls(loadChannelMessages(mailRoot, 'commons'));
    expect(checkVote(polls, 'p1', 'B', 'commons')).toBe('b');
    expect(() => checkVote(polls, 'p1', 'c', 'commons')).toThrow(/not an option; choices: a, b/);
    expect(() => checkVote(polls, 'p2', 'a', 'commons')).toThrow(/no poll 'p2' in #commons/);
  });

  it('refuses polls with too few or too many options', () => {
    expect(() => pollBody('p', 'q', ['one'])).toThrow(PollError);
    expect(() =>
      pollBody(
        'p',
        'q',
        Array.from({ length: 9 }, (_, k) => `o${k}`),
      ),
    ).toThrow(/max 8/);
  });

  it('skips headers that are not objects, and reads through the mail root it is given', () => {
    expect(parseMessageText('[1]\n---\nbody')).toBeNull();
    expect(parseMessageText('{"from": "a"}\n---\n  body  ')).toEqual({
      from: 'a',
      sent: '',
      body: 'body',
    });
    expect(() => loadChannelMessages(mailRoot, '../escape')).toThrow();
  });
});
