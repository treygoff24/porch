/**
 * The T7 capture set: the stage strip, its motion caught mid-frame, the attract screen, the
 * power-up, and the four overlays, each at the three sizes the design is judged at, through T1's
 * capture (`scripts/capture.ts`). Writes `docs/captures/stage-*.png`. Not a test; run it as
 *
 *   node --import tsx test/stage/capture-stage.ts [--out docs/captures]
 *
 * Every frame is the rig's, so what is captured is what the frame tests assert on. The state dir
 * is a temporary one; nothing reads Trey's own state or mail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Presence } from '@estate/post-kit';
import { captureGrid } from '../../scripts/capture.ts';
import { createBrowser } from '../../src/app/overlays/browser.ts';
import { createHelp } from '../../src/app/overlays/help.ts';
import { createSearch } from '../../src/app/overlays/search.ts';
import { createSwitcher } from '../../src/app/overlays/switcher.ts';
import type { Key, Overlay } from '../../src/app/registry.ts';
import { createStage, type PorchStage } from '../../src/app/stage/stage.ts';
import { Grid } from '../../src/grid/grid.ts';
import { emote, GROUND, IdleSteps, message, Rig, summary } from './rig.ts';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'docs/captures' } } });
const out = values.out ?? 'docs/captures';
const SIZES = [
  [40, 52],
  [100, 32],
  [160, 44],
] as const;

const dir = mkdtempSync(join(tmpdir(), 'porch-capture-'));
const seen = join(dir, 'seen');
const fresh = join(dir, 'fresh');
mkdirSync(seen);
writeFileSync(join(seen, 'attract-seen'), 'capture\n');

const stageFor = (stateDir: string): PorchStage =>
  createStage({ stateDir: () => stateDir, timers: new IdleSteps() });

/** A busy channel: five agents and Trey, real-looking task lines, one silent agent. */
function crew(): Rig {
  const rig = new Rig();
  for (const who of ['bolt', 'wisp', 'mochi', 'ribbit', 'blob'] as const) rig.join(who);
  rig.channels = rig.channels.map((c) => ({
    ...c,
    unread: 4,
    messages: 1284,
    description: 'where the crew works',
  }));
  rig.channels.push(
    summary('ops', [], { messages: 312, unread: 0 }),
    summary('design-crit', [], { messages: 97, unread: 2 }),
    summary('launch-2026', [], { messages: 2040, archived: true }),
  );
  rig.load('commons', [
    message('bolt', 'rewriting the parser for nested quotes'),
    message('mochi', 'baking the release notes for 0.4'),
    message('trey', 'ship the parser today', { verdict: { state: 'verified', reason: 'cap' } }),
    message('ribbit', 'triaging the flaky pty test'),
  ]);
  return rig;
}

const shots: string[] = [];
async function shoot(name: string, g: Grid, cols: number, rows: number, noColor = false) {
  const png = join(out, `stage-${name}-${cols}x${rows}${noColor ? '-nocolor' : ''}.png`);
  shots.push(await captureGrid(g, png, { noColor }));
}

/** Step the rig's clock until `t` ms into the first burst (or it ends); the frame there. */
function frameAt(
  rig: Rig,
  stage: PorchStage,
  cols: number,
  rows: number,
  ms: number,
  fit: 'bodies' | 'heads' = 'bodies',
) {
  let start: number | undefined;
  for (let t = rig.tick(); t !== undefined; t = rig.tick()) {
    start ??= t;
    if (t - start >= ms) break;
  }
  return rig.draw(stage, cols, rows, { fit });
}

function overlayShot(o: Overlay, rig: Rig, cols: number, rows: number, keys: Key[] = []) {
  const s = rig.state(cols, rows);
  const g = new Grid(cols, rows, GROUND);
  o.draw(g, { x: 0, y: 0, w: cols, h: rows }, s);
  for (const k of keys) o.key(k, s);
  const g2 = new Grid(cols, rows, GROUND);
  o.draw(g2, { x: 0, y: 0, w: cols, h: rows }, s);
  return g2;
}
const ch = (c: string): Key => ({ name: c, ctrl: false, alt: false, shift: false, text: c });

try {
  for (const [cols, rows] of SIZES) {
    // The strip at rest, with read marks for two agents.
    {
      const rig = crew();
      const stage = stageFor(seen);
      rig.draw(stage, cols, rows);
      stage.event({ kind: 'sent', channel: 'commons', id: 'cap-1', mode: 'casual' }, rig.state());
      rig.motion = 'reduced'; // the marks without the hops, for the still capture
      for (const p of ['p-bolt', 'p-mochi'])
        stage.event({ kind: 'seen', channel: 'commons', id: 'cap-1', participant: p }, rig.state());
      rig.motion = 'full';
      await shoot('bodies', rig.draw(stage, cols, rows), cols, rows);
      await shoot('heads', rig.draw(stage, cols, rows, { fit: 'heads' }), cols, rows);
      if (cols === 100) await shoot('bodies', rig.draw(stage, cols, rows), cols, rows, true);
    }
    // Mid-emote (Bolt's beep-boop, 375 ms in) and a READY! hop on its first frame.
    {
      const rig = crew();
      const stage = stageFor(seen);
      rig.draw(stage, cols, rows);
      stage.event(
        {
          kind: 'arrival',
          channel: 'commons',
          // At phone width only Trey, Bolt and Wisp fit, so Wisp takes the READY! hop there.
          records:
            cols === 40
              ? [emote('bolt', 'beep-boop')]
              : [emote('bolt', 'beep-boop'), emote('wisp', 'celebrate')],
        },
        rig.state(),
      );
      stage.event({ kind: 'sent', channel: 'commons', id: 'cap-2', mode: 'casual' }, rig.state());
      stage.event(
        {
          kind: 'seen',
          channel: 'commons',
          id: 'cap-2',
          participant: cols === 40 ? 'p-wisp' : 'p-mochi',
        },
        rig.state(),
      );
      // Phone width shows heads (T6 picks heads there), so the motion reads at 40 columns.
      const fit = cols === 40 ? 'heads' : 'bodies';
      await shoot(
        'motion',
        frameAt(rig, stage, cols, rows, cols === 40 ? 125 : 375, fit),
        cols,
        rows,
      );
    }
    // The power-up, held gold.
    {
      const rig = crew();
      const stage = stageFor(seen);
      rig.draw(stage, cols, rows);
      stage.event({ kind: 'sent', channel: 'commons', id: 'cap-3', mode: 'signed' }, rig.state());
      await shoot('power-up', frameAt(rig, stage, cols, rows, 375), cols, rows);
    }
    // The attract screen's still frame.
    {
      const rig = crew();
      const stage = stageFor(fresh);
      rmSync(join(fresh, 'attract-seen'), { force: true });
      rig.draw(stage, cols, rows);
      while (rig.tick() !== undefined) rig.draw(stage, cols, rows);
      const g = rig.draw(stage, cols, rows);
      await shoot('attract', g, cols, rows);
      if (cols === 100) await shoot('attract', g, cols, rows, true);
    }
    // The overlays.
    {
      const rig = crew();
      rig.views.set('ops', {
        ...(rig.views.get('commons') ?? ({} as never)),
        name: 'ops',
        records: [],
        needsYou: true,
      });
      await shoot('help', overlayShot(createHelp(), rig, cols, rows), cols, rows);
      await shoot(
        'switcher',
        overlayShot(createSwitcher(), rig, cols, rows, [ch('o')]),
        cols,
        rows,
      );
      const presence: Presence = {
        who: [
          { id: 'p-bolt', liveWatch: true },
          { id: 'p-mochi', liveWatch: true },
          { id: 'p-wisp', liveWatch: false },
        ] as Presence['who'],
        profiles: new Map(),
        skipped: [],
      };
      const browser = createBrowser({
        presence: async () => ({ ok: true, value: presence }),
        archive: async () => ({ ok: true, value: undefined }),
        unarchive: async () => ({ ok: true, value: undefined }),
      });
      overlayShot(browser, rig, cols, rows);
      await new Promise((r) => setTimeout(r, 0));
      await shoot('browser', overlayShot(browser, rig, cols, rows), cols, rows);
      const records = rig.views.get('commons')?.records ?? [];
      const search = createSearch(async () => ({
        ok: true,
        value: {
          hits: records.filter((r) => r.text.includes('parser')).reverse(),
          truncated: false,
          limit: 1000,
        },
      }));
      overlayShot(search, rig, cols, rows, [...'parser'].map(ch));
      search.key({ name: 'return', ctrl: false, alt: false, shift: false }, rig.state(cols, rows));
      await new Promise((r) => setTimeout(r, 0));
      await shoot('search', overlayShot(search, rig, cols, rows), cols, rows);
    }
  }
  for (const s of shots) console.log(s);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
