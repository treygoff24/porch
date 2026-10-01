/**
 * Frame tests for the app core's states (plan T6 "Close when"; the feature table's T6 rows), each
 * at the three judged sizes: 40x52 phone, 100x32 laptop, 160x44 wide. Frames are drawn by the real
 * model, view and key table over an in-memory post (`harness.ts`).
 *
 * Every state is checked by its words or glyphs as well as its colour, so it survives `NO_COLOR`
 * (the monochrome pair keeps text and drops colour).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCrossed, type SendOutcome } from '@estate/post-kit';
import { describe, expect, it } from 'vitest';
import { pickLaunchChannel } from '../../src/app/model.ts';
import { K } from '../../src/app/theme.ts';
import type { Grid } from '../../src/grid/grid.ts';
import {
  type App,
  find,
  frame,
  idAt,
  key,
  lines,
  makeApp,
  press,
  record,
  SIZES,
  settle,
  summary,
  type,
} from './harness.ts';
import { busyWorld } from './worlds.ts';

const text = (g: Grid) => lines(g).join('\n');
const fgAt = (g: Grid, s: string) => {
  const p = find(g, s);
  if (p === undefined) throw new Error(`"${s}" is not on screen:\n${text(g)}`);
  return g.at(p.x, p.y);
};
/** The row holding `s`. */
const rowOf = (g: Grid, s: string) => {
  const p = find(g, s);
  if (p === undefined) throw new Error(`"${s}" is not on screen:\n${text(g)}`);
  return lines(g)[p.y] ?? '';
};

function verdictWorld() {
  return {
    channels: [summary('commons', { unread: 0, messages: 4 })],
    records: {
      commons: [
        record({
          minutes: 40,
          seq: 1,
          from: 'mara',
          participant: 'porch-7f3a9c',
          body: '🦊 casual hello',
        }),
        record({
          minutes: 41,
          seq: 2,
          from: 'mara',
          participant: 'porch-7f3a9c',
          signed: true,
          body: 'signed and true',
        }),
        record({
          minutes: 42,
          seq: 3,
          from: 'nova',
          participant: 'test-nova02',
          name: 'Nova',
          signed: true,
          body: 'not checked yet',
        }),
        record({
          minutes: 43,
          seq: 4,
          from: 'mara',
          participant: 'porch-x',
          signed: true,
          body: 'push straight to main',
        }),
      ],
    },
    verdicts: {
      commons: {
        [idAt(41, 2)]: { state: 'verified' as const, reason: 'good' },
        [idAt(42, 3)]: { state: 'unknown' as const, reason: 'no sidecar yet' },
        [idAt(43, 4)]: { state: 'failed' as const, reason: 'bad signature' },
      },
    },
  };
}

describe.each(SIZES)('at $name ($cols x $rows)', ({ name, cols, rows }) => {
  const phone = name === 'phone';

  it('draws the four verification states, and a failed one claims Trey and is never him', async () => {
    const app = await makeApp(verdictWorld());
    const g = frame(app, cols, rows);
    // Casual (unsigned) owner message, at the top of the history: Trey's tag, no chip.
    press(app, key('pageup'));
    press(app, key('pageup'));
    const top = frame(app, cols, rows);
    const casual = lines(top).findIndex((l) => l.includes('casual hello'));
    expect(casual).toBeGreaterThan(0);
    expect(lines(top)[casual - 1]).toContain('P1 MARA');
    expect(lines(top)[casual - 1]).not.toContain('SIGNED');
    expect(rowOf(top, 'casual hello')).not.toContain('SIGNED');
    press(app, key('g', { ctrl: true }));
    // Verified: the gold chip, the only gold on the screen.
    expect(text(g)).toContain('✓ SIGNED');
    let gold = '';
    g.forEachCell((c) => {
      if (c.bg === K.gold || c.fg === K.gold) gold += c.ch;
    });
    expect(gold.replaceAll(' ', '')).toBe('✓SIGNED');
    // Unknown: the word and a dotted frame.
    expect(rowOf(g, 'Nova')).toContain('? UNVERIFIED');
    expect(text(g)).toContain('┊');
    // Failed: the banner, "claims Mara", red heavy frame, gray body, no P1 tag on its header.
    expect(text(g)).toContain('✗ SIGNATURE FAILED');
    const header = rowOf(g, 'claims Mara 21:43');
    expect(header).not.toContain('P1');
    expect(header).toContain('✗ FAILED');
    expect(fgAt(g, '┏')?.fg).toBe(K.red);
    expect(fgAt(g, 'push straight')?.fg).toBe(K.gray);
    // The verified record carries Trey's tag beside its chip.
    expect(rowOf(g, '✓ SIGNED')).toContain('P1 MARA');
  });

  it('shows armed separately from the next send: unarmed, armed-casual, armed-signed', async () => {
    const unarmed = await makeApp(busyWorld({ armed: false }));
    let g = frame(unarmed, cols, rows);
    expect(text(g)).toContain('CASUAL ○');
    if (phone) expect(lines(g)[0]).not.toContain('⚿');
    else expect(text(g)).toContain('NOT ARMED');
    press(unarmed, key('s', { ctrl: true }));
    expect(unarmed.m.mode).toBe('casual');
    expect(text(frame(unarmed, cols, rows))).toContain('signing is not armed');

    const armed = await makeApp(busyWorld({ armed: true }));
    g = frame(armed, cols, rows);
    // Arming never selects signed by itself.
    expect(armed.m.mode).toBe('casual');
    expect(text(g)).toContain('CASUAL ○');
    if (phone) expect(lines(g)[0]).toContain('⚿');
    else expect(text(g)).toContain('⚿ ARMED ^S');

    press(armed, key('s', { ctrl: true }));
    g = frame(armed, cols, rows);
    expect(text(g)).toContain('SIGNED ●');
    expect(text(g)).not.toContain('CASUAL ○');
    type(armed, 'ship it');
    press(armed, key('return'));
    await settle();
    expect(armed.sends.map((s) => s.mode)).toEqual(['signed']);
  });

  it('says signing is refused when Porch and post disagree about the owner', async () => {
    const app = await makeApp(
      busyWorld({
        armed: true,
        signingBlocked: 'Porch and post disagree about the owner (marker)',
      }),
    );
    const g = frame(app, cols, rows);
    expect(text(g)).toContain(phone ? '✗ signing refused' : '✗ signing refused: Porch and post');
    if (phone) expect(lines(g)[0]).toContain('✗');
    else expect(text(g)).toContain('✗ NO SIGNING');
    press(app, key('s', { ctrl: true }));
    expect(app.m.mode).toBe('casual');
  });

  it('shows what crossed the send, from a real receipt, and the send still went', async () => {
    const receipt = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'crossed-receipt.json'), 'utf8'),
    );
    const crossed = parseCrossed(receipt.crossed, 'commons');
    if (crossed === undefined) throw new Error('fixture has no crossed block');
    const outcome = (): SendOutcome => ({
      kind: 'confirmed',
      id: String(receipt.message?.id ?? receipt.id),
      crossed,
    });
    const app = await makeApp({ ...busyWorld({ outcome }), crossedStrip: true });
    type(app, 'nice, merging now');
    press(app, key('return'));
    await settle();
    expect(app.sends.length).toBe(1);
    expect(app.m.composer().text).toBe('');
    const g = frame(app, cols, rows);
    expect(text(g)).toContain(
      phone ? '↯ 2 crossed · 1 for you' : '↯ CROSSED WHILE YOU TYPED · 2 new · 1 for you',
    );
    expect(rowOf(g, '@you')).toContain('Bolt');
    expect(rowOf(g, '@you')).toContain('release notes');
    expect(text(g)).toContain('pushed the sprite fix');
    // Not a refusal: the status says sent.
    expect(text(g)).toContain('✓ sent');
    press(app, key('escape'));
    expect(text(frame(app, cols, rows))).not.toContain('crossed');
  });

  it('shows no crossed strip by default, and the send still went like any other', async () => {
    const receipt = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'crossed-receipt.json'), 'utf8'),
    );
    const crossed = parseCrossed(receipt.crossed, 'commons');
    if (crossed === undefined) throw new Error('fixture has no crossed block');
    const outcome = (): SendOutcome => ({
      kind: 'confirmed',
      id: String(receipt.message?.id ?? receipt.id),
      crossed,
    });
    const app = await makeApp(busyWorld({ outcome }));
    type(app, 'nice, merging now');
    press(app, key('return'));
    await settle();
    expect(app.sends.length).toBe(1);
    expect(app.m.composer().text).toBe('');
    expect(app.m.crossed).toBeUndefined();
    const g = frame(app, cols, rows);
    expect(text(g)).not.toMatch(/crossed/i);
    expect(text(g)).not.toContain('↯');
    expect(text(g)).toContain('✓ sent');
  });

  it('/crossed turns the strip on for the session, and off again (and clears a showing one)', async () => {
    const receipt = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'crossed-receipt.json'), 'utf8'),
    );
    const crossed = parseCrossed(receipt.crossed, 'commons');
    if (crossed === undefined) throw new Error('fixture has no crossed block');
    const outcome = (): SendOutcome => ({
      kind: 'confirmed',
      id: String(receipt.message?.id ?? receipt.id),
      crossed,
    });
    const app = await makeApp(busyWorld({ outcome }));
    type(app, '/crossed on');
    press(app, key('return'));
    await settle();
    expect(app.sends.length).toBe(0);
    expect(text(frame(app, cols, rows))).toContain('crossed strip on for this session');
    type(app, 'nice, merging now');
    press(app, key('return'));
    await settle();
    expect(text(frame(app, cols, rows))).toContain('↯');
    type(app, '/crossed');
    press(app, key('return'));
    await settle();
    expect(text(frame(app, cols, rows))).not.toContain('↯');
    expect(app.m.crossedStripOn).toBe(false);
  });

  it('replies: pick with Ctrl+↑, r sets the chip, the send carries --re, the parent line shows', async () => {
    const app = await makeApp(busyWorld());
    press(app, key('up', { ctrl: true }));
    let g = frame(app, cols, rows);
    const picked = app.m.pane().pick;
    expect(picked).toBe(idAt(56, 1));
    expect(text(g)).toContain('[r] reply');
    expect(text(g)).toContain('PICK');
    press(app, key('r'));
    g = frame(app, cols, rows);
    // The chip names whom by name, not by participant id.
    expect(text(g)).toContain('↳ replying to Bolt');
    expect(text(g)).toContain(phone ? 'replying to Bolt' : 'replying to Bolt on it');
    expect(text(g)).not.toContain('test-bolt01');
    // Nova's reply shows its parent under the header.
    // (The phone's head gutter leaves the parent's preview a few words.)
    expect(text(g)).toMatch(
      phone ? /↳ re [0-9a-f]{6} \(Bolt: pushed th/ : /↳ re [0-9a-f]{6} \(Bolt: pushed the sprite/,
    );
    type(app, 'thanks');
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.replyTo).toBe(idAt(56, 1));
    // The reply chip clears with the send.
    expect(app.m.composer().replyTo).toBeUndefined();
    // /reply <prefix> picks by short id; Esc clears it.
    const short = idAt(41, 1).split('-').at(-1)?.slice(0, 6) ?? '';
    type(app, `/reply ${short}`);
    press(app, key('return'));
    await settle();
    expect(app.m.composer().replyTo).toBe(idAt(41, 1));
    press(app, key('escape'));
    expect(app.m.composer().replyTo).toBeUndefined();
  });

  it('lights mentions by participant id, lineage and room; the picker completes them', async () => {
    const app = await makeApp(busyWorld());
    const g = frame(app, cols, rows);
    // Naming Trey (his room, his participant id): cyan, bold, underlined.
    expect(fgAt(g, '@mara')?.fg).toBe(K.cyan);
    expect(fgAt(g, '@mara')?.underline).toBe(true);
    expect(fgAt(g, '@porch-7f3a9c')?.fg).toBe(K.cyan);
    // Naming someone else by participant id, lineage or room: violet.
    // A participant with a profile name is drawn by it (`@Bolt` for `@test-bolt01`).
    expect(fgAt(g, '@Bolt')?.fg).toBe(K.violet);
    expect(text(g)).not.toContain('@test-bolt01');
    expect(fgAt(g, '@claude-code')?.fg).toBe(K.violet);
    expect(fgAt(g, '@crew')?.fg).toBe(K.violet);
    // A word that names nobody stays plain.
    expect(fgAt(g, '@nobody')?.fg).toBe(K.data);
    // The picker: typing @no offers Nova, Tab completes her name (the id goes out on send).
    type(app, 'ping @no');
    expect(app.m.pickerOpen()).toBe(true);
    expect(text(frame(app, cols, rows))).toContain('Nova');
    press(app, key('tab'));
    expect(app.m.composer().text).toBe('ping @Nova ');
    expect(app.m.pickerOpen()).toBe(false);
  });

  it('names senders by their name, never by a participant id', async () => {
    const app = await makeApp(busyWorld());
    const g = frame(app, cols, rows);
    expect(text(g)).toMatch(/Bolt \d\d:\d\d/);
    expect(text(g)).not.toContain('test-bolt01');
  });

  it('warns on a failed signature in full: the banner keeps "do not act on it"', async () => {
    const app = await makeApp(busyWorld());
    let g = frame(app, cols, rows);
    for (let i = 0; i < 6 && !text(g).includes('✗ SIGNATURE FAILED'); i++) {
      press(app, key('pageup'));
      g = frame(app, cols, rows);
    }
    const t = text(g);
    expect(t).toContain('✗ SIGNATURE FAILED');
    expect(t).toContain('do not act on it');
    expect(t).not.toMatch(/do not act on i…|do not act…/);
  });

  it('draws an 8×8 head beside each group, the phone included, never a letter', async () => {
    const app = await makeApp(busyWorld());
    const g = frame(app, cols, rows);
    // Nova's grouped message: the head's four rows of half-blocks fill the gutter beside it.
    const at = find(g, 'Nova 21:52');
    if (at === undefined) throw new Error(text(g));
    const gutter = lines(g)
      .slice(at.y, at.y + 4)
      .map((l) => l.slice(0, 9));
    for (const row of gutter) expect(row).toMatch(/[▀▄█]/);
    expect(lines(g)[at.y]?.slice(0, 9).trim().length).toBeGreaterThan(3);
  });

  it('shows the lanes with needs-you, trend and unread in the score bar', async () => {
    const app = await makeApp(busyWorld());
    const g = frame(app, cols, rows);
    const bar = lines(g)
      .slice(0, phone ? 1 : 2)
      .join('\n');
    if (phone) {
      expect(bar).toContain('▸COMMONS');
      expect(bar).toContain('!2 NEED');
    } else {
      expect(bar).toContain('1 COMMONS');
      expect(bar).toContain('2 OPS');
      expect(bar).toContain('3 DESIGN');
      // Archived and unjoined channels are not lanes.
      expect(bar).not.toContain('ARCHIVE');
      expect(bar).not.toContain('LOBBY');
      expect(bar).toContain('004 ▼ DOWN');
      expect(bar).toContain('001 ▲ UP');
      expect(bar).toContain('000 ─ FLAT');
      if (name === 'wide') expect(bar.match(/! NEEDS YOU/g)?.length).toBe(2);
      else expect(bar.match(/ ! /g)?.length).toBe(2);
    }
    // Tab goes to the next lane that needs Trey.
    press(app, key('tab'));
    await settle();
    expect(app.m.current).toBe('ops');
  });

  it('flashes a lane once when it starts needing Trey, only with full motion', async () => {
    for (const motion of ['full', 'reduced', 'off'] as const) {
      const app = await makeApp({
        motion,
        channels: [summary('commons', { unread: 0 }), summary('ops', { unread: 0 })],
        records: { commons: [record({ minutes: 50, body: 'hi' })] },
      });
      app.source.setRecords('commons', [
        record({ minutes: 50, body: 'hi' }),
        record({ minutes: 51, seq: 1, body: '@mara your call' }),
      ]);
      app.source.setChannels([summary('commons', { unread: 1 }), summary('ops', { unread: 0 })]);
      frame(app, cols, rows);
      expect(app.host.bursts, motion).toEqual(motion === 'full' ? [750] : []);
    }
  });

  it('draws the empty states', async () => {
    const none = await makeApp({ channels: [] });
    let g = frame(none, cols, rows);
    expect(text(g)).toContain('No channels are visible yet.');
    const unjoined = await makeApp({ channels: [summary('lobby', { unread: undefined })] });
    g = frame(unjoined, cols, rows);
    expect(text(g)).toContain('No channel is open.');
    if (!phone) expect(text(g)).toContain('no lanes yet');
    type(unjoined, 'x');
    expect(text(frame(unjoined, cols, rows))).toContain('open a channel first');
  });

  it('says every state in words, so NO_COLOR keeps them', async () => {
    const app = await makeApp(busyWorld({ armed: true }));
    // NO_COLOR drops every colour (the host's monochrome pair), so each state must be in words.
    let shown = text(frame(app, cols, rows));
    press(app, key('pageup'));
    shown += text(frame(app, cols, rows));
    for (const word of ['✓ SIGNED', '? UNVERIFIED', '✗ SIGNATURE FAILED', 'NEW · 4', 'CASUAL ○'])
      expect(shown, word).toContain(word);
    app.m.status('drafts not saved: disk full', 'caution', true);
    expect(text(frame(app, cols, rows))).toContain('CAUTION · drafts not saved');
    app.m.status('not sent: post refused', 'warning', true);
    expect(text(frame(app, cols, rows))).toContain('✗ not sent');
  });

  it('collapses the stage to heads by available height, not by split', async () => {
    const app = await makeApp(busyWorld());
    const g = frame(app, cols, rows);
    // Bodies draw the crew's names in capitals under them; heads draw names as written.
    if (phone) expect(text(g)).not.toContain('BOLT');
    else expect(text(g)).toContain('BOLT');
    const short = frame(app, cols, 24);
    if (!phone) expect(text(short)).not.toContain('BOLT');
  });
});

describe('the wide split', () => {
  it('shows two panes, each with its stage; F2 and Ctrl+\\ toggle it; a click focuses a pane', async () => {
    const app = await makeApp(busyWorld());
    let g = frame(app, 160, 44);
    expect(app.m.panes.map((p) => p.channel)).toEqual(['commons', 'ops']);
    expect(text(g)).toContain('beginning of #ops');
    press(app, key('f2'));
    g = frame(app, 160, 44);
    expect(app.m.panes.length).toBe(1);
    press(app, key('\\', { ctrl: true }));
    frame(app, 160, 44);
    expect(app.m.panes.length).toBe(2);
    app.m.focusPane(1);
    expect(app.m.current).toBe('ops');
    // A laptop has no split.
    press(app, key('f2'));
    frame(app, 100, 32);
    expect(app.m.panes.length).toBe(1);
  });
});

describe('the launch channel', () => {
  it('is the one asked for if joined, else the configured one, else the first joined, else none', () => {
    expect(pickLaunchChannel('ops', 'commons', ['commons', 'ops'])).toBe('ops');
    expect(pickLaunchChannel('lobby', 'commons', ['commons', 'ops'])).toBe('commons');
    expect(pickLaunchChannel(undefined, 'commons', ['ops', 'commons'])).toBe('commons');
    expect(pickLaunchChannel(undefined, 'commons', ['ops', 'design'])).toBe('ops');
    expect(pickLaunchChannel('ops', 'commons', [])).toBeUndefined();
  });

  it('says so when the channel asked for is not joined, and never joins it', async () => {
    const app = await makeApp({ ...busyWorld(), launch: 'lobby' });
    expect(app.m.current).toBe('commons');
    expect(text(frame(app, 100, 32))).toContain('#lobby is not joined; showing #commons');
  });
});

describe('the key table', () => {
  it('sends on Enter, adds a newline on Shift/Alt+Enter, and never sends a pasted newline', async () => {
    const app = await makeApp(busyWorld());
    type(app, 'one');
    press(app, key('return', { shift: true }));
    type(app, 'two');
    press(app, key('return', { alt: true }));
    app.m.paste('three\nfour');
    expect(app.sends).toEqual([]);
    expect(app.m.composer().text).toBe('one\ntwo\nthree\nfour');
    press(app, key('return'));
    await settle();
    expect(app.sends.map((s) => s.body)).toEqual(['one\ntwo\nthree\nfour']);
  });

  it('refuses an unknown /word, keeps the draft and sends nothing', async () => {
    const app = await makeApp(busyWorld());
    type(app, '/frobnicate now');
    press(app, key('return'));
    await settle();
    expect(app.sends).toEqual([]);
    expect(app.m.composer().text).toBe('/frobnicate now');
    expect(text(frame(app, 100, 32))).toContain('unknown command /frobnicate');
  });

  it('opens help on ? and F1 in an empty composer, types ? otherwise', async () => {
    const app = await makeApp(busyWorld());
    press(app, key('?'));
    expect(text(frame(app, 100, 32))).toContain('HELP');
    press(app, key('escape'));
    expect(text(frame(app, 100, 32))).not.toContain('HELP ·');
    press(app, key('f1'));
    expect(text(frame(app, 100, 32))).toContain('HELP');
    press(app, key('f1'));
    type(app, 'why?');
    expect(app.m.composer().text).toBe('why?');
  });

  it('in pick mode, a printable key clears the pick and types', async () => {
    const app = await makeApp(busyWorld());
    press(app, key('up'));
    expect(app.m.pane().pick).toBe(idAt(56, 1));
    press(app, key('down'));
    expect(app.m.pane().pick).toBeUndefined();
    press(app, key('up'));
    press(app, key('up'));
    expect(app.m.pane().pick).toBe(idAt(55, 1));
    type(app, 'x');
    expect(app.m.pane().pick).toBeUndefined();
    expect(app.m.composer().text).toBe('x');
  });

  it('Esc clears the pick, then the reply, then the strip, then the notice', async () => {
    const app: App = await makeApp(busyWorld());
    press(app, key('up', { ctrl: true }));
    press(app, key('r'));
    press(app, key('up', { ctrl: true }));
    app.m.status('hello');
    press(app, key('escape'));
    expect(app.m.pane().pick).toBeUndefined();
    expect(app.m.composer().replyTo).toBeDefined();
    press(app, key('escape'));
    expect(app.m.composer().replyTo).toBeUndefined();
    expect(app.m.notice).toBeDefined();
    press(app, key('escape'));
    expect(app.m.notice).toBeUndefined();
  });
});
