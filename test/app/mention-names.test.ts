/**
 * A mention in the composer is drawn as the participant's name and sent as the id post resolves
 * (Trey, 2026-10-01: pressing Tab on "Lantern" put `@loom-3e44517c` in the box; "it should just
 * render the name, the identity, everywhere"). The composer keeps each mention as a token over the
 * drawn text, and what is sent, saved or rescued is the wire form.
 */
import { describe, expect, it } from 'vitest';
import { nameSender } from '../../src/app/derive.ts';
import type { DraftStore, Roster } from '../../src/app/model.ts';
import { frame, key, lines, makeApp, press, record, settle, summary, type } from './harness.ts';

const FERN = 'loom-52b3dee9';
const FERN2 = 'loom-91c0aa17';
const LANTERN = 'loom-3e44517c';

const NAMES = new Map([
  [FERN, 'Fern'],
  [LANTERN, 'Lantern'],
]);

function world(extra: Parameters<typeof makeApp>[0] = {}): Parameters<typeof makeApp>[0] {
  return {
    channels: [summary('porch-testing', { members: ['mara'], participants: [LANTERN, FERN] })],
    records: { 'porch-testing': [] },
    launch: 'porch-testing',
    names: NAMES,
    ...extra,
  };
}

const screen = (app: Awaited<ReturnType<typeof makeApp>>) => lines(frame(app, 100, 32)).join('\n');

/** `@Fe` + Tab: the mention of Fern, as the picker puts it in. */
function mentionFern(app: Awaited<ReturnType<typeof makeApp>>) {
  type(app, '@Fe');
  press(app, key('tab'));
}

describe('picking a mention', () => {
  it('puts the name in the composer, not the id', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    expect(app.m.composer().text).toBe('@Fern ');
    expect(app.m.composer().mentions).toEqual([{ start: 0, end: 5, id: FERN }]);
    expect(screen(app)).toContain('@Fern');
    expect(screen(app)).not.toContain(FERN);
  });

  it('sends the id post resolves, with the words around it untouched', async () => {
    const app = await makeApp(world());
    type(app, 'hey ');
    mentionFern(app);
    type(app, 'take this');
    press(app, key('return'));
    await settle();
    expect(app.sends.map((s) => s.body)).toEqual([`hey @${FERN} take this`]);
  });

  it('keeps a lineage or a participant with no name as the plain word it inserts', async () => {
    const app = await makeApp(world({ names: new Map(), lineages: new Map() }));
    type(app, '@loom-5');
    press(app, key('tab'));
    expect(app.m.composer().text).toBe(`@${FERN} `);
    expect(app.m.composer().mentions).toEqual([]);
  });

  it('does not offer the picker again right after a finished mention', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    press(app, key('backspace')); // the space: the caret is now at the end of the token
    expect(app.m.composer().text).toBe('@Fern');
    expect(app.m.pickerOpen()).toBe(false);
  });
});

describe('a mention is one piece', () => {
  it('Backspace removes all of it', async () => {
    const app = await makeApp(world());
    type(app, 'hi ');
    mentionFern(app);
    press(app, key('backspace')); // the trailing space
    press(app, key('backspace')); // the mention
    expect(app.m.composer().text).toBe('hi ');
    expect(app.m.composer().mentions).toEqual([]);
  });

  it('Delete removes all of it from its start', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    press(app, key('home'));
    press(app, key('delete'));
    expect(app.m.composer().text).toBe(' ');
    expect(app.m.composer().mentions).toEqual([]);
  });

  it('Ctrl+W removes all of it, from its end or from inside', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    type(app, 'x');
    press(app, key('left'));
    press(app, key('left'));
    press(app, key('w', { ctrl: true }));
    expect(app.m.composer().text).toBe(' x');
    expect(app.m.composer().mentions).toEqual([]);
    mentionFern(app);
    press(app, key('home'));
    press(app, key('right'));
    press(app, key('right'));
    press(app, key('w', { ctrl: true }));
    expect(app.m.composer().text).toBe('  x');
  });

  it('Ctrl+W that would stop in the middle of a two-word name takes the whole name', async () => {
    const app = await makeApp(world({ names: new Map([[FERN, 'Fern Bell']]) }));
    type(app, 'hi @be');
    press(app, key('tab'));
    expect(app.m.composer().text).toBe('hi @Fern Bell ');
    press(app, key('w', { ctrl: true }));
    expect(app.m.composer().text).toBe('hi ');
    expect(app.m.composer().mentions).toEqual([]);
  });

  it('typing inside it leaves plain words, not a mention', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    press(app, key('home'));
    press(app, key('right'));
    press(app, key('right'));
    type(app, 'x');
    expect(app.m.composer().text).toBe('@Fxern ');
    expect(app.m.composer().mentions).toEqual([]);
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe('@Fxern ');
  });

  it('follows the text when words are typed before it', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    press(app, key('home'));
    type(app, 'ok ');
    expect(app.m.composer().mentions).toEqual([{ start: 3, end: 8, id: FERN }]);
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`ok @${FERN} `);
  });

  it('a letter typed straight after it is the user’s own word', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    press(app, key('backspace')); // the space
    type(app, 's');
    expect(app.m.composer().text).toBe('@Ferns');
    expect(app.m.composer().mentions).toEqual([]);
  });

  it('a word that meets it after the space is deleted does not run into the id', async () => {
    const app = await makeApp(world());
    mentionFern(app);
    type(app, 'hello');
    press(app, key('home'));
    for (let i = 0; i < 5; i++) press(app, key('right'));
    press(app, key('delete')); // the space between them
    expect(app.m.composer().text).toBe('@Fernhello');
    expect(app.m.composer().mentions).toEqual([{ start: 0, end: 5, id: FERN }]);
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`@${FERN} hello`);
  });
});

describe('drafts keep mentions working', () => {
  function store(initial = new Map<string, string>()) {
    const saved: Map<string, string>[] = [];
    const drafts: DraftStore = {
      load: async () => new Map(initial),
      save: async (d) => {
        saved.push(new Map(d));
      },
    };
    return { drafts, saved };
  }

  it('saves the draft as post reads it', async () => {
    const s = store();
    const app = await makeApp(world({ drafts: s.drafts }));
    type(app, 'hey ');
    mentionFern(app);
    await app.m.saveDrafts();
    expect(s.saved.at(-1)?.get('porch-testing')).toBe(`hey @${FERN} `);
  });

  it('brings a saved draft back drawn as names, with the mention still one piece', async () => {
    const s = store(new Map([['porch-testing', `hey @${FERN} and @${LANTERN} ok`]]));
    const app = await makeApp(world({ drafts: s.drafts }));
    expect(app.m.composer().text).toBe('hey @Fern and @Lantern ok');
    expect(screen(app)).not.toContain(FERN);
    // Backspace at the end of `@Fern` takes all of it.
    press(app, key('home'));
    for (let i = 0; i < 9; i++) press(app, key('right'));
    press(app, key('backspace'));
    expect(app.m.composer().text).toBe('hey  and @Lantern ok');
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`hey  and @${LANTERN} ok`);
  });

  it('a rescued draft is written with ids and restored as names', async () => {
    const rescued: { channel: string; text: string }[] = [];
    const drafts: DraftStore = {
      load: async () => new Map(),
      save: async () => {
        throw new Error('disk full');
      },
    };
    const app = await makeApp(
      world({
        drafts,
        rescue: {
          record: async (channel, text) => {
            rescued.push({ channel, text });
            return 'rec-1';
          },
        },
      }),
    );
    mentionFern(app);
    expect(await app.m.rescueUnsaved()).toBe(true);
    expect(rescued).toEqual([{ channel: 'porch-testing', text: `@${FERN} ` }]);
    // /restore hands the rescued text to the composer through setDraft.
    const again = await makeApp(world());
    again.m.actions.setDraft(rescued[0]?.text ?? '');
    expect(again.m.composer().text).toBe('@Fern ');
    expect(again.m.composer().mentions).toEqual([{ start: 0, end: 5, id: FERN }]);
  });

  it('an unsent draft is not lost when the send is refused: the mention is still there', async () => {
    const app = await makeApp(
      world({ outcome: () => ({ kind: 'refused', code: 'x', message: 'post is down' }) }),
    );
    mentionFern(app);
    type(app, 'hi');
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`@${FERN} hi`);
    expect(app.m.composer().text).toBe('@Fern hi');
    expect(app.m.composer().mentions).toEqual([{ start: 0, end: 5, id: FERN }]);
  });
});

describe('names that collide or carry spaces', () => {
  const two = (extra: Parameters<typeof makeApp>[0] = {}) =>
    world({
      channels: [
        summary('porch-testing', { members: ['mara'], participants: [LANTERN, FERN, FERN2] }),
      ],
      names: new Map([
        [FERN, 'Fern'],
        [FERN2, 'Fern'],
        [LANTERN, 'Lantern'],
      ]),
      places: new Map([
        [FERN, '/home/x/a'],
        [FERN2, '/home/x/b'],
      ]),
      home: '/home/x',
      ...extra,
    });

  it('two agents called Fern are two mentions with their own ids', async () => {
    const app = await makeApp(two());
    type(app, '@Fe');
    expect(app.m.mentionCandidates().map((c) => c.insert)).toEqual([FERN, FERN2]);
    press(app, key('down'));
    press(app, key('tab'));
    type(app, '@Fe');
    press(app, key('tab'));
    expect(app.m.composer().text).toBe('@Fern @Fern ');
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`@${FERN2} @${FERN} `);
  });

  it('a hand-typed @Fern that could be either is left alone, not guessed', async () => {
    const app = await makeApp(two());
    type(app, 'hi @Fern');
    press(app, key('escape'));
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe('hi @Fern');
  });

  it('a hand-typed @Name that names exactly one participant is converted on send', async () => {
    const app = await makeApp(two());
    type(app, 'hi @lantern, and @Lantern.');
    press(app, key('escape'));
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`hi @${LANTERN}, and @${LANTERN}.`);
  });

  it('a name with a space is one token, and a hand-typed full name converts', async () => {
    const app = await makeApp(world({ names: new Map([[FERN, 'Fern Bell']]) }));
    type(app, '@be');
    press(app, key('tab'));
    expect(app.m.composer().text).toBe('@Fern Bell ');
    press(app, key('backspace'));
    press(app, key('backspace'));
    expect(app.m.composer().text).toBe('');
    type(app, 'x @fern bell y');
    press(app, key('escape'));
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`x @${FERN} y`);
  });

  it('does not convert a name that is only the start of a longer word', async () => {
    const app = await makeApp(world());
    type(app, '@Fernando and @Lanterns');
    press(app, key('escape'));
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe('@Fernando and @Lanterns');
  });
});

describe('names stay current', () => {
  it('redraws a mention in the draft when its participant takes a new name', async () => {
    const roster: Roster = {
      names: new Map([
        [FERN, 'Fern Bell'],
        [LANTERN, 'Lantern'],
      ]),
      places: new Map(),
      lineages: new Map(),
    };
    const app = await makeApp(world({ loadRoster: async () => roster }));
    mentionFern(app);
    type(app, 'hi');
    const before = app.m.composer().revision;
    await app.m.refreshRoster();
    expect(app.m.composer().text).toBe('@Fern Bell hi');
    expect(app.m.composer().mentions).toEqual([{ start: 0, end: 10, id: FERN }]);
    // The same words go out, so a send in flight still clears its draft.
    expect(app.m.composer().revision).toBe(before);
    press(app, key('return'));
    await settle();
    expect(app.sends[0]?.body).toBe(`@${FERN} hi`);
  });
});

describe('names everywhere, not ids', () => {
  const rec = record({
    minutes: 50,
    from: 'lantern',
    participant: LANTERN,
    lineage: 'Lantern',
    name: 'lantern',
    body: 'hello there',
    channel: 'porch-testing',
  });

  it('a byline shows the name, not `Lineage [participant-id]`', async () => {
    const app = await makeApp(
      world({ names: new Map([[LANTERN, 'Lantern']]), records: { 'porch-testing': [rec] } }),
    );
    const t = screen(app);
    expect(t).toContain('Lantern');
    expect(t).not.toContain(LANTERN);
  });

  it('a participant with only a lineage shows the lineage', async () => {
    const app = await makeApp(
      world({
        names: new Map(),
        lineages: new Map([[LANTERN, 'fable']]),
        records: { 'porch-testing': [rec] },
      }),
    );
    expect(screen(app)).not.toContain(LANTERN);
    expect(app.m.state().names.get(LANTERN)).toBe('fable');
    expect(app.m.display(rec, 'porch-testing').sender.text).toBe('fable');
  });

  it('the profile name beats the lineage in names the stream, seen-by and member lists read', async () => {
    const app = await makeApp(
      world({
        names: new Map([[LANTERN, 'Lantern']]),
        lineages: new Map([[LANTERN, 'fable']]),
      }),
    );
    expect(app.m.state().names.get(LANTERN)).toBe('Lantern');
  });

  it('a byline follows a name change after the roster is read again', async () => {
    const renamed: Roster = {
      names: new Map([[LANTERN, 'Beacon']]),
      places: new Map(),
      lineages: new Map(),
    };
    const app = await makeApp(
      world({
        names: new Map(),
        records: { 'porch-testing': [rec] },
        loadRoster: async () => renamed,
      }),
    );
    expect(screen(app)).toContain(LANTERN);
    await app.m.refreshRoster();
    expect(screen(app)).toContain('Beacon');
    expect(screen(app)).not.toContain(LANTERN);
  });

  it('a search hit shows the name too, and Trey’s own records are left as they are', () => {
    const names = new Map([[LANTERN, 'Lantern']]);
    const app = rec;
    const display = {
      raw: app,
      kind: 'message',
      text: 'x',
      sender: { text: 'lantern [loom-3e44517c]', room: 'lantern', isOwner: false },
      verdict: { state: 'unsigned', reason: 'search hit' },
    } as const;
    expect(nameSender(display, names, 'mara').sender.text).toBe('Lantern');
    const mine = { ...display, raw: { ...app, from: 'mara' } };
    expect(nameSender(mine, names, 'mara')).toBe(mine);
    expect(nameSender(display, new Map(), 'mara')).toBe(display);
  });
});
