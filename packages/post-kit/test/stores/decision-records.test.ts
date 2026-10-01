/**
 * Decision records: the same log file, line format, replay rules and append lock as porch-tui's
 * `drstore.py` (run for real from porch-tui's virtualenv against temporary files), and the authority
 * rules of the projection.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ActionLookup,
  type ActionVerdict,
  appendEvent,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  badgeFor,
  DecisionAuthority,
  DecisionLogError,
  type DrEvent,
  decide,
  MAX_VERIFY_CALLS,
  newEventId,
  nextDrId,
  offerLine,
  parseActionBody,
  parseEvents,
  parseV2ActionBody,
  project,
  propose,
  replay,
  supersede,
  type TailRepair,
  utcCreated,
  validEvent,
} from '../../src/stores/decision-records.ts';
import {
  type PyJson,
  PyNumberLiteral,
  pyJsonDumps,
  pyJsonLoads,
  pyJsonString,
} from '../../src/stores/py.ts';
import { cleanTemps, porchPython, pyJson, runPy, startPy, tempDir } from './pyharness.ts';

afterAll(cleanTemps);

let log: string;
beforeEach(() => {
  const room = join(tempDir(), 'room');
  mkdirSync(room);
  log = join(room, 'decision-records.jsonl');
});

const needsPorch = describe.skipIf(porchPython === null);

/** Replay a log with porch-tui and return each kept event re-encoded as porch-tui writes it. */
function pyReplayLines(path: string): string[] {
  return pyJson<string[]>(
    `from pathlib import Path
from porch3 import drstore
print(json.dumps([json.dumps(ev, ensure_ascii=False) for ev in drstore.replay(Path(INPUT))]))`,
    path,
    { porch: true },
  );
}
/**
 * `json.dumps(ev, ensure_ascii=False)` for comparison only: numbers print as JavaScript prints them,
 * which matches Python for the integers, `2.5` and `NaN` the corpus holds. (The writer itself refuses
 * non-integers; porch-next never writes one.)
 */
function canon(v: PyJson): string {
  if (typeof v === 'number') return String(v);
  if (v instanceof PyNumberLiteral) return Number.isNaN(v.value) ? 'NaN' : String(v.value);
  if (typeof v === 'string') return pyJsonString(v, false);
  if (v === null || typeof v === 'boolean') return pyJsonDumps(v, false);
  if (Array.isArray(v)) return `[${v.map(canon).join(', ')}]`;
  return `{${[...v].map(([k, x]) => `${pyJsonString(k, false)}: ${canon(x)}`).join(', ')}}`;
}
const tsLines = (events: DrEvent[]) => events.map(canon);

describe('ids and stamps', () => {
  it('allocates the smallest unused id, never highest+1', () => {
    const ev = (dr: string): DrEvent =>
      new Map([
        ['type', 'proposed'],
        ['dr', dr],
      ]);
    expect(nextDrId([])).toBe('dr-1');
    expect(nextDrId([ev('dr-1'), ev('dr-3')])).toBe('dr-2');
    expect(nextDrId([ev('dr-999999999')])).toBe('dr-1');
    // Python's int() reads Unicode digits and ignores a trailing newline.
    expect(nextDrId([ev('dr-١'), ev('dr-2\n')])).toBe('dr-3');
  });

  it('stamps event ids and creation times in porch-tui formats', () => {
    const at = new Date(Date.UTC(2026, 8, 30, 7, 5, 9));
    expect(utcCreated(at)).toBe('2026-09-30T07:05:09Z');
    expect(newEventId(at)).toMatch(/^20260930T070509Z-[0-9a-f]{6}$/);
  });
});

describe('writing', () => {
  it('writes the exact line porch-tui writes', async () => {
    const ev = await appendEvent(
      {
        type: 'ratified',
        dr: 'dr-1',
        actor_message_id: '20260930-070509-000001-abcdef',
        event_id: '20260930T070509Z-0a0b0c',
        created: '2026-09-30T07:05:09Z',
      },
      log,
    );
    const expected = runPy(
      'print(json.dumps(INPUT, ensure_ascii=False))',
      Object.fromEntries(ev),
    ).stdout;
    expect(readFileSync(log, 'utf8')).toBe(expected);
  });

  it('refuses unknown types, missing members, invalid events and lone surrogates', async () => {
    await expect(appendEvent({ type: 'vetoed', dr: 'dr-1' }, log)).rejects.toThrow(
      /unknown event type/,
    );
    await expect(appendEvent({ type: 'ratified', dr: 'dr-1' }, log)).rejects.toThrow(
      /missing actor_message_id/,
    );
    await expect(
      appendEvent({ type: 'ratified', dr: 'dr-1', actor_message_id: 'a/b' }, log),
    ).rejects.toThrow(/invalid ratified event/);
    await expect(
      propose({ title: 'bad \udc00', project: 'p', channel: 'c', anchorMessageId: 'm' }, log),
    ).rejects.toBeInstanceOf(DecisionLogError);
    await expect(decide('dr-1', 'maybe' as 'ratified', 'm', log)).rejects.toThrow(/verdict/);
  });

  it('proposes with the smallest free id and the full porch-tui member order', async () => {
    writeFileSync(log, '{"type": "proposed", "dr": "dr-2", "title": "t"}\n');
    const ev = await propose(
      { title: 'T', project: 'P', channel: 'c', anchorMessageId: 'm1', detail: 'd' },
      log,
    );
    expect([...ev.keys()]).toEqual([
      'type',
      'dr',
      'title',
      'project',
      'channel',
      'anchor_message_id',
      'detail',
      'event_id',
      'created',
    ]);
    expect(ev.get('dr')).toBe('dr-1');
    expect(replay(log).map((e) => e.get('dr'))).toEqual(['dr-2', 'dr-1']);
  });
});

/** Lines both implementations must keep or drop identically. */
const HOSTILE = [
  '',
  '   ',
  'not json',
  '[1, 2]',
  '"string"',
  '{"type": "vetoed", "dr": "dr-1"}',
  '{"type": "proposed", "dr": "dr-1", "title": "ok"}',
  '{"type": "proposed", "dr": "dr-1\\n", "title": "trailing newline id is valid in Python"}',
  '{"type": "proposed", "dr": "dr-١٢", "title": "Arabic-Indic digits"}',
  '{"type": "proposed", "dr": "dr-1234567890", "title": "ten digits"}',
  '{"type": "proposed", "dr": "DR-1"}',
  '{"type": "proposed", "dr": 5}',
  '{"type": "proposed", "dr": "dr-3", "title": 7}',
  '{"type": "proposed", "dr": "dr-3", "title": null, "detail": {"x": [1, 2.5, NaN]}}',
  '{"type": "superseded", "dr": "dr-4"}',
  '{"type": "superseded", "dr": "dr-4", "supersedes": "dr-x", "actor_message_id": "m"}',
  '{"type": "superseded", "dr": "dr-4", "supersedes": "dr-1", "actor_message_id": "m"}',
  '{"type": "ratified", "dr": "dr-1", "actor_message_id": "../../etc/passwd"}',
  '{"type": "ratified", "dr": "dr-1", "actor_message_id": "ok.id-1_\\n"}',
  '{"type": "ratified", "dr": "dr-1", "actor_message_id": ""}',
  `{"type": "proposed", "dr": "dr-5", "title": "${'x'.repeat(65536)}"}`,
  '{"type": "proposed", "dr": "dr-6", "title": "a b"}',
  '{"type": "proposed", "dr": "dr-7", "dr": "dr-8", "title": "duplicate key"}',
  '{"type": "proposed", "dr": "dr-9", "title": "raw \t tab is refused by Python"}',
  '﻿{"type": "proposed", "dr": "dr-10", "title": "BOM"}',
  '  {"type": "proposed", "dr": "dr-11", "title": "padded"}  ',
  '{"type": "proposed", "dr": "dr-12", "title": "lone \\ud800 escape"}',
];

needsPorch('replay against porch-tui', () => {
  it('keeps and drops the same hostile lines, with CR, CRLF and LS line breaks', () => {
    const text = `${HOSTILE.join('\n')}\r\n${HOSTILE.slice(6, 9).join('\r')}\n`;
    writeFileSync(log, text, 'utf8');
    expect(tsLines(replay(log))).toEqual(pyReplayLines(log));
    expect(replay(log).length).toBeGreaterThan(8);
  });

  it('agrees on id allocation over the same log', () => {
    writeFileSync(log, `${HOSTILE.join('\n')}\n`, 'utf8');
    const py = runPy(
      `from pathlib import Path
from porch3 import drstore
print(drstore.next_dr_id(drstore.replay(Path(INPUT))))`,
      log,
      { porch: true },
    );
    expect(nextDrId(replay(log))).toBe(py.stdout.trim());
  });

  it('round-trips a log written by porch-tui, byte for byte', () => {
    runPy(
      `from pathlib import Path
from porch3 import drstore
p = Path(INPUT)
drstore.propose(title='Ship 🦊 "now"', project='porch', channel='commons', anchor_message_id='20260930-070509-000001-abcdef', detail='tab\\tand é', path=p)
drstore.propose(title='second', project='p', channel='c', anchor_message_id='a', path=p)
drstore.decide('dr-1', 'ratified', '20260930-070510-000001-abcdef', path=p)
drstore.decide('dr-2', 'rejected', '20260930-070511-000001-abcdef', path=p)
drstore.supersede('dr-1', 'dr-2', '20260930-070512-000001-abcdef', path=p)
`,
      log,
      { porch: true },
    );
    const bytes = readFileSync(log, 'utf8');
    const events = replay(log);
    expect(events).toHaveLength(5);
    expect(
      tsLines(events)
        .map((l) => `${l}\n`)
        .join(''),
    ).toBe(bytes);
  });

  it('porch-tui reads what TypeScript wrote', async () => {
    await propose(
      { title: 'Ship 🦊', project: 'porch', channel: 'commons', anchorMessageId: 'x1' },
      log,
    );
    await decide('dr-1', 'ratified', '20260930-070510-000001-abcdef', log);
    await supersede('dr-1', 'dr-1', '20260930-070511-000001-abcdef', log);
    expect(pyReplayLines(log)).toEqual(readFileSync(log, 'utf8').trimEnd().split('\n'));
  });

  it('parses action bodies exactly as porch-tui does', () => {
    const bodies = [
      '⚖️ DR dr-1 accepted',
      '⚖️ DR dr-1 rejected',
      '⚖️ DR dr-1 superseded by dr-2',
      '⚖️ DR dr-١ accepted',
      '⚖️ DR dr-1 accepted\n',
      ' ⚖️ DR dr-1 accepted',
      '⚖️ DR dr-1 accepted please',
      '⚖️ DR dr-1234567890 accepted',
      '⚖ DR dr-1 accepted',
      '🦊🔏 ⚖️ DR dr-1 accepted [signed:abc]',
      '🦊🔏 ⚖️ DR dr-1 accepted  [signed:abc]  ',
      '🦊🔏 ⚖️ DR dr-1 accepted[signed:abc]',
      '🦊🔏 ⚖️ DR dr-1 accepted [signed:abc] ',
      '🦊🔏 ⚖️ DR dr-1 accepted [signed:abc]\n',
      '🦊🔏 ⚖️ DR dr-1 accepted [signed:]',
      `🦊🔏 ⚖️ DR dr-1 accepted [signed:${'t'.repeat(65)}]`,
      '🦊🔏 ⚖️ DR dr-2 superseded by dr-3 [signed:t]',
      '🧔🔏 ⚖️ DR dr-1 accepted [signed:abc]',
      'x🦊🔏 ⚖️ DR dr-1 accepted [signed:abc]',
    ];
    const py = pyJson<[unknown, unknown][]>(
      `from porch3 import drstore
from porch3.wire import compile_wire
w = compile_wire('🦊')
print(json.dumps([[drstore.parse_v2_action_body(b), drstore.parse_action_body(b, wire=w)] for b in INPUT]))`,
      bodies,
      { porch: true },
    );
    const asTuple = (p: ReturnType<typeof parseV2ActionBody>) =>
      p === null ? null : [p.dr, p.verb, p.replacement];
    const ts = bodies.map((b) => [
      asTuple(parseV2ActionBody(b)),
      asTuple(parseActionBody(b, '🦊')),
    ]);
    expect(ts).toEqual(py);
    expect(ts.filter(([v2, v1]) => v2 !== null || v1 !== null).length).toBeGreaterThan(6);
  });

  it('renders badges and offer lines like porch-tui', () => {
    const states = ['needs_operator_decision', 'ratified', 'rejected', 'superseded', 'other'];
    const record = { dr: 'dr-4', title: 'Ship "it" 🦊', project: 'porch' };
    const py = pyJson<string[]>(
      `from porch3 import drstore
out = [drstore.badge_for(s, label='Trey') for s in INPUT['states']]
out.append(drstore.offer_line(INPUT['record'], label='Trey'))
print(json.dumps(out))`,
      { states, record },
      { porch: true },
    );
    expect([...states.map((s) => badgeFor(s, 'Trey')), offerLine(record, 'Trey')]).toEqual(py);
  });
});

needsPorch('the append lock against porch-tui', () => {
  it('waits for a porch-tui holder and refuses after the timeout', async () => {
    await propose({ title: 't', project: 'p', channel: 'c', anchorMessageId: 'm' }, log);
    const held = await startPy(
      `import fcntl, sys
fh = open(${JSON.stringify(log)}, 'a', encoding='utf-8')
fcntl.flock(fh, fcntl.LOCK_EX)
print('holding', flush=True)
sys.stdin.readline()
`,
    );
    expect(held.ready).toBe('holding');
    try {
      await expect(
        decide('dr-1', 'ratified', '20260930-070510-000001-abcdef', log, { lockTimeoutMs: 300 }),
      ).rejects.toThrow(/holding the decision log/);
      await expect(
        propose({ title: 'u', project: 'p', channel: 'c', anchorMessageId: 'm' }, log, {
          lockTimeoutMs: 300,
        }),
      ).rejects.toThrow(/holding the decision log/);
    } finally {
      expect((await held.finish()).status).toBe(0);
    }
    expect(replay(log)).toHaveLength(1);
  });

  it('never hands out the same id when both apps propose at once', async () => {
    const n = 25;
    const py = startPy(
      `import sys
from pathlib import Path
from porch3 import drstore
print('ready', flush=True)
sys.stdin.readline()
for k in range(${n}):
    drstore.propose(title=f'py{k}', project='p', channel='c', anchor_message_id='m', path=Path(${JSON.stringify(log)}))
`,
      { porch: true },
    );
    const started = await py;
    const pyDone = started.finish();
    const tsDone = (async () => {
      for (let k = 0; k < n; k++) {
        await propose({ title: `ts${k}`, project: 'p', channel: 'c', anchorMessageId: 'm' }, log);
      }
    })();
    const [pyResult] = await Promise.all([pyDone, tsDone]);
    expect(pyResult.status).toBe(0);
    const ids = replay(log).map((e) => e.get('dr'));
    expect(ids).toHaveLength(2 * n);
    expect(new Set(ids).size).toBe(2 * n);
  });
});

describe('replay details porch-tui cannot express', () => {
  it('drops lines porch-tui would crash on instead of failing the whole replay', () => {
    const deep = `{"type": "proposed", "dr": "dr-1", "detail": ${'['.repeat(5000)}${']'.repeat(5000)}}`;
    const unhashable = '{"type": [], "dr": "dr-2"}';
    const events = parseEvents([deep, unhashable, '{"type": "proposed", "dr": "dr-3"}'].join('\n'));
    expect(events.map((e) => e.get('dr'))).toEqual(['dr-3']);
  });

  it('reports a log that is not UTF-8 instead of replaying it as empty', () => {
    writeFileSync(log.replace('/room/', '/'), Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    expect(() => replay(log.replace('/room/', '/'))).toThrow(DecisionLogError);
    expect(replay(join(tempDir(), 'missing.jsonl'))).toEqual([]);
  });

  it('validates events structurally', () => {
    const ok = pyJsonLoads('{"type": "ratified", "dr": "dr-1", "actor_message_id": "m"}');
    expect(validEvent(ok)).toBe(true);
    expect(validEvent(pyJsonLoads('{"type": "ratified", "dr": "dr-1", "channel": 5}'))).toBe(false);
  });
});

// --- authority --------------------------------------------------------------------------------

const MID = (n: number) => `20260930-070500-${String(n).padStart(6, '0')}-abcdef`;
const enc = (s: string) => new TextEncoder().encode(s);
const verified = (body: string, v2 = true): ActionVerdict => ({
  kind: 'verified',
  body: enc(body),
  signatureRefPresent: v2,
  from: v2 ? 'mara' : null,
});

function events(lines: Record<string, string>[]): DrEvent[] {
  return lines.map((l) => new Map(Object.entries(l)));
}
const proposed = (dr: string) => ({ type: 'proposed', dr, title: `t${dr}`, project: 'p' });

describe('the projection', () => {
  function authorityWith(table: Record<string, ActionVerdict>, now = () => 0) {
    const lookup = vi.fn<ActionLookup>(async (mid) => table[mid] ?? { kind: 'unknown' });
    return {
      lookup,
      authority: new DecisionAuthority({ lookup, ownerRoom: 'mara', marker: '🦊', now }),
    };
  }

  it('counts a decision only when a signed owner action names that exact record and verb', async () => {
    const { authority } = authorityWith({
      [MID(1)]: verified('⚖️ DR dr-1 accepted'),
      [MID(2)]: verified('⚖️ DR dr-1 accepted'), // real, but for dr-1, not dr-2
      [MID(3)]: verified('🦊🔏 ⚖️ DR dr-3 rejected [signed:t]', false),
      [MID(4)]: verified('⚖️ DR dr-4 rejected'), // wrong verb for a ratify line
      [MID(5)]: { kind: 'failed' },
    });
    const recs = await project(
      events([
        proposed('dr-1'),
        proposed('dr-2'),
        proposed('dr-3'),
        proposed('dr-4'),
        proposed('dr-5'),
        { type: 'ratified', dr: 'dr-1', actor_message_id: MID(1) },
        { type: 'ratified', dr: 'dr-2', actor_message_id: MID(2) },
        { type: 'rejected', dr: 'dr-3', actor_message_id: MID(3) },
        { type: 'ratified', dr: 'dr-4', actor_message_id: MID(4) },
        { type: 'ratified', dr: 'dr-5', actor_message_id: MID(5) },
      ]),
      authority,
    );
    expect([...recs.values()].map((r) => [r.dr, r.state])).toEqual([
      ['dr-1', 'ratified'],
      ['dr-2', 'needs_operator_decision'],
      ['dr-3', 'rejected'],
      ['dr-4', 'needs_operator_decision'],
      ['dr-5', 'needs_operator_decision'],
    ]);
    expect(recs.get('dr-2')?.history[0]?.ignored).toBe('actor message unverified');
  });

  it('checks the supersede transition before spending any verification', async () => {
    const { lookup, authority } = authorityWith({
      [MID(1)]: verified('⚖️ DR dr-1 accepted'),
      [MID(2)]: verified('⚖️ DR dr-2 accepted'),
      [MID(3)]: verified('⚖️ DR dr-1 superseded by dr-2'),
    });
    const base = [
      proposed('dr-1'),
      proposed('dr-2'),
      { type: 'superseded', dr: 'dr-2', supersedes: 'dr-1', actor_message_id: MID(9) },
    ];
    let recs = await project(events(base), authority);
    expect(recs.get('dr-2')?.history[0]?.ignored).toBe('invalid supersede transition');
    expect(lookup).not.toHaveBeenCalled();

    recs = await project(
      events([
        proposed('dr-1'),
        proposed('dr-2'),
        { type: 'ratified', dr: 'dr-1', actor_message_id: MID(1) },
        { type: 'ratified', dr: 'dr-2', actor_message_id: MID(2) },
        { type: 'superseded', dr: 'dr-2', supersedes: 'dr-1', actor_message_id: MID(3) },
        // A cycle back is refused: dr-1 is no longer ratified.
        { type: 'superseded', dr: 'dr-1', supersedes: 'dr-2', actor_message_id: MID(3) },
      ]),
      authority,
    );
    expect(recs.get('dr-1')?.state).toBe('superseded');
    expect(recs.get('dr-1')?.supersededBy).toBe('dr-2');
    expect(recs.get('dr-2')?.state).toBe('ratified');
    expect(recs.get('dr-1')?.history.at(-1)?.ignored).toBe('invalid supersede transition');
  });

  it(`spends at most ${MAX_VERIFY_CALLS} new verifications per projection, and memoizes`, async () => {
    const { lookup, authority } = authorityWith({});
    const lines = [];
    for (let k = 1; k <= 12; k++) {
      lines.push(proposed(`dr-${k}`), {
        type: 'ratified',
        dr: `dr-${k}`,
        actor_message_id: MID(k),
      });
    }
    await project(events(lines), authority);
    expect(lookup).toHaveBeenCalledTimes(MAX_VERIFY_CALLS);
  });

  it(`makes at most ${MAX_VERIFY_CALLS} lookups per projection, retries included, shared fairly`, async () => {
    let now = 0;
    const { lookup, authority } = authorityWith({}, () => now);
    const lines = [];
    for (let k = 1; k <= 24; k++) {
      lines.push(proposed(`dr-${k}`), {
        type: 'ratified',
        dr: `dr-${k}`,
        actor_message_id: MID(k),
      });
    }
    const log = events(lines);
    const ids = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => MID(from + k));
    const round = async () => {
      lookup.mockClear();
      await project(log, authority);
      return lookup.mock.calls.map((call) => call[0]);
    };
    expect(await round()).toEqual(ids(1, 8));
    // Ids waiting out a backoff cost nothing; the budget moves on down the log.
    expect(await round()).toEqual(ids(9, 16));
    expect(await round()).toEqual(ids(17, 24));
    expect(await round()).toEqual([]);
    // Every backoff has expired: the retries are paid for, oldest attempt first, not all 24.
    now += BACKOFF_CAP_MS + 1;
    expect(await round()).toEqual(ids(1, 8));
    now += BACKOFF_CAP_MS + 1;
    expect(await round()).toEqual(ids(9, 16));
  });

  it('spends nothing on memoized answers, and finishes the log across projections', async () => {
    const table: Record<string, ActionVerdict> = {};
    const lines = [];
    for (let k = 1; k <= 20; k++) {
      table[MID(k)] = verified(`⚖️ DR dr-${k} accepted`);
      lines.push(proposed(`dr-${k}`), {
        type: 'ratified',
        dr: `dr-${k}`,
        actor_message_id: MID(k),
      });
    }
    const { lookup, authority } = authorityWith(table);
    const log = events(lines);
    const counts: number[] = [];
    let recs = await project(log, authority);
    for (let pass = 0; pass < 4; pass++) {
      lookup.mockClear();
      recs = await project(log, authority);
      counts.push(lookup.mock.calls.length);
    }
    expect(counts).toEqual([8, 4, 0, 0]);
    expect([...recs.values()].every((r) => r.state === 'ratified')).toBe(true);
  });

  it('never looks up a message id that is not post-shaped', async () => {
    const { lookup, authority } = authorityWith({});
    await project(
      events([proposed('dr-1'), { type: 'ratified', dr: 'dr-1', actor_message_id: 'dr-1.msg' }]),
      authority,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('backs off an unknown verdict, doubling, then retries', async () => {
    let now = 0;
    const table: Record<string, ActionVerdict> = {};
    const { lookup, authority } = authorityWith(table, () => now);
    expect(await authority.authenticAction(MID(1))).toBeNull();
    expect(await authority.authenticAction(MID(1))).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    now = BACKOFF_BASE_MS;
    expect(await authority.authenticAction(MID(1))).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(2);
    now = BACKOFF_BASE_MS * 2; // the second window is twice as long
    await authority.authenticAction(MID(1));
    expect(lookup).toHaveBeenCalledTimes(2);
    now = BACKOFF_BASE_MS * 3;
    table[MID(1)] = verified('⚖️ DR dr-1 accepted');
    expect(await authority.authenticAction(MID(1))).toEqual({
      dr: 'dr-1',
      verb: 'accepted',
      replacement: null,
    });
    // A verified answer is final.
    await authority.authenticAction(MID(1));
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('treats a v2 body only as v2 when it came from the owner room', async () => {
    const { authority } = authorityWith({
      [MID(1)]: { ...verified('⚖️ DR dr-1 accepted'), from: 'someone-else' } as ActionVerdict,
    });
    expect(await authority.authenticAction(MID(1))).toBeNull();
  });
});

describe('writes replay keeps', () => {
  const fields = (title: string) => ({ title, project: 'p', channel: 'c', anchorMessageId: 'm' });

  it('refuses, before opening the log, any record replay would drop', async () => {
    for (const title of ['a b', 'a b', 'a\u0085b', 'x'.repeat(65536)]) {
      await expect(propose(fields(title), log)).rejects.toBeInstanceOf(DecisionLogError);
      expect(existsSync(log)).toBe(false);
    }
    await expect(
      appendEvent({ type: 'ratified', dr: 'dr-1', actor_message_id: MID(1), note: 'x y' }, log),
    ).rejects.toThrow(/line separator/);
    expect(existsSync(log)).toBe(false);
  });

  it('refuses to write back a float or a huge integer from an unknown member, never changing it', async () => {
    for (const number of ['2.0', '9007199254740993']) {
      const [ev] = parseEvents(
        `{"type": "ratified", "dr": "dr-1", "actor_message_id": "${MID(1)}", "weight": ${number}}`,
      );
      await expect(appendEvent(ev as DrEvent, log)).rejects.toThrow(
        `refusing to write the number ${number}`,
      );
    }
    expect(existsSync(log)).toBe(false);
  });

  needsPorch('against porch-tui', () => {
    it('keeps every proposal it writes, with the hostile corpus as titles, so no id is reused', async () => {
      const titles = [...HOSTILE, 'a b', 'é\u0085', 'x'.repeat(65000), 'x'.repeat(65536)];
      const written: PyJson[] = [];
      const writtenTitles: string[] = [];
      let refused = 0;
      for (const title of titles) {
        const before = existsSync(log) ? readFileSync(log) : null;
        try {
          written.push((await propose(fields(title), log)).get('dr') as PyJson);
          writtenTitles.push(title);
        } catch (err) {
          expect(err).toBeInstanceOf(DecisionLogError);
          expect(existsSync(log) ? readFileSync(log) : null).toEqual(before);
          refused++;
        }
      }
      const kept = replay(log);
      expect(kept.map((e) => e.get('dr'))).toEqual(written);
      expect(new Set(written).size).toBe(written.length);
      expect(kept.map((e) => e.get('title'))).toEqual(writtenTitles);
      expect(pyReplayLines(log)).toEqual(tsLines(kept));
      expect(written.length).toBeGreaterThan(20);
      expect(refused).toBeGreaterThanOrEqual(4);
    });
  });
});

describe('interrupted writes', () => {
  const fields = (title: string) => ({ title, project: 'p', channel: 'c', anchorMessageId: 'm' });
  const line = (dr: string) =>
    `{"type": "proposed", "dr": "${dr}", "title": "t", "project": "p", "channel": "c", "anchor_message_id": "m"}`;
  const drs = () => replay(log).map((e) => e.get('dr'));

  it('ends a complete last event that lost its newline, keeping it', async () => {
    writeFileSync(log, line('dr-1'));
    const repairs: TailRepair[] = [];
    const ev = await propose(fields('next'), log, { onRepair: (r) => repairs.push(r) });
    expect(repairs).toEqual([{ kind: 'terminated', bytes: Buffer.byteLength(line('dr-1')) }]);
    expect(ev.get('dr')).toBe('dr-2');
    expect(drs()).toEqual(['dr-1', 'dr-2']);
    if (porchPython !== null) expect(pyReplayLines(log)).toHaveLength(2);
  });

  it('ends a partial fragment, so the next record is not swallowed with it', async () => {
    const fragment = '{"type": "proposed", "dr": "dr-';
    writeFileSync(log, `${line('dr-1')}\n${fragment}`);
    const repairs: TailRepair[] = [];
    await decide('dr-1', 'ratified', MID(1), log, { onRepair: (r) => repairs.push(r) });
    expect(repairs).toEqual([{ kind: 'terminated', bytes: fragment.length }]);
    expect(replay(log).map((e) => e.get('type'))).toEqual(['proposed', 'ratified']);
    if (porchPython !== null) expect(pyReplayLines(log)).toHaveLength(2);
  });

  it('cuts off a fragment that ends inside a UTF-8 character, which made the log unreadable', async () => {
    const fox = Buffer.from('🦊');
    const head = Buffer.from(`${line('dr-1')}\n`);
    writeFileSync(
      log,
      Buffer.concat([head, Buffer.from('{"type": "proposed", "title": "'), fox.subarray(0, 2)]),
    );
    expect(() => replay(log)).toThrow(DecisionLogError);
    const repairs: TailRepair[] = [];
    const ev = await propose(fields('after'), log, { onRepair: (r) => repairs.push(r) });
    expect(repairs.map((r) => r.kind)).toEqual(['truncated']);
    expect(ev.get('dr')).toBe('dr-2');
    expect(drs()).toEqual(['dr-1', 'dr-2']);
    expect(readFileSync(log).subarray(0, head.length).equals(head)).toBe(true);
  });

  it('refuses, writing nothing, when the last line holds bytes that are not UTF-8 at all', async () => {
    const bytes = Buffer.concat([Buffer.from(`${line('dr-1')}\n`), Buffer.from([0xff, 0x20])]);
    writeFileSync(log, bytes);
    await expect(propose(fields('x'), log)).rejects.toThrow(/not valid UTF-8/);
    await expect(decide('dr-1', 'ratified', MID(1), log)).rejects.toThrow(/not valid UTF-8/);
    expect(readFileSync(log).equals(bytes)).toBe(true);
  });

  const haveUlimit = spawnSync('bash', ['-c', 'ulimit -f 1']).status === 0;
  it.skipIf(!haveUlimit)(
    'cuts a failed append back to the previous length (a real EFBIG under a file-size limit)',
    async () => {
      writeFileSync(log, `${line('dr-1')}\n`);
      const before = readFileSync(log);
      const script = join(tempDir(), 'append.mts');
      const src = resolve(import.meta.dirname, '../../src/stores/decision-records.ts');
      writeFileSync(
        script,
        `const { propose } = await import(${JSON.stringify(src)});
try {
  await propose({ title: 'y'.repeat(4000), project: 'p', channel: 'c', anchorMessageId: 'm' }, process.argv[2]);
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, name: err.name, message: err.message }));
}
`,
      );
      // 1 KiB: the log fits, the new line does not. Node ignores SIGXFSZ, so write() fails EFBIG.
      const child = spawnSync('bash', ['-c', 'ulimit -f 1; exec node "$0" "$1"', script, log], {
        encoding: 'utf8',
      });
      const result = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}');
      expect(result, child.stderr).toMatchObject({ ok: false, name: 'DecisionLogError' });
      expect(result.message).toMatch(/EFBIG|too large/i);
      expect(result.message).toMatch(/cut back to its previous length/);
      expect(readFileSync(log).equals(before)).toBe(true);
      expect((await propose(fields('next'), log)).get('dr')).toBe('dr-2');
      expect(drs()).toEqual(['dr-1', 'dr-2']);
    },
  );
});

describe('the log file itself', () => {
  const fields = { title: 't', project: 'p', channel: 'c', anchorMessageId: 'm' };

  it('never writes through a symlink, a FIFO or a hard link, and never blocks on a FIFO', async () => {
    const victim = join(tempDir(), 'victim');
    writeFileSync(victim, 'precious\n');
    symlinkSync(victim, log);
    await expect(propose(fields, log)).rejects.toThrow(/symlink/);
    await expect(decide('dr-1', 'ratified', MID(1), log)).rejects.toThrow(/symlink/);
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
    unlinkSync(log);

    expect(spawnSync('mkfifo', [log]).status).toBe(0);
    await expect(propose(fields, log)).rejects.toThrow(/regular file/);
    expect(replay(log)).toEqual([]);
    unlinkSync(log);

    linkSync(victim, log);
    await expect(propose(fields, log)).rejects.toThrow(/one link/);
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
  });
});
