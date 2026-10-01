/**
 * porch-tui's config, read by porch-next: a differential against porch-tui's own loader, validators
 * and emitter (run from its virtualenv with `HOME` at a temporary directory, so neither side can see
 * Trey's real config), plus the TOML subset reader against Python's `tomllib`.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigError,
  configPath,
  emitToml,
  loadConfigBytes,
  loadPorchConfig,
  type PorchConfig,
  validateLabel,
  validateMarker,
} from '../../src/config/porch-config.ts';
import { pyAbspath, pyExpandUser, pyJoin, pyPath } from '../../src/config/pypath.ts';
import { loadSettings } from '../../src/config/settings.ts';
import { parseFlatToml, TomlError, TomlSubsetError } from '../../src/config/toml.ts';
import { cleanTemps, porchPython, pyJson, tempDir } from '../stores/pyharness.ts';

afterAll(cleanTemps);
const needsPorch = describe.skipIf(porchPython === null);

let home: string;
beforeEach(() => {
  home = tempDir('porch-t3b-home-');
});

/** The resolved identity as porch-tui's field names, for comparison with Python. */
function fields(c: PorchConfig) {
  return {
    owner_room: c.ownerRoom,
    owner_room_dir: c.ownerRoomDir,
    mail_root: c.mailRoot,
    sidecar_dir: c.sidecarDir,
    allowed_signers: c.allowedSigners,
    key_file: c.keyFile,
    signing_namespace: c.signingNamespace,
    principal: c.principal,
    marker: c.marker,
    label: c.label,
    initial_channel: c.initialChannel,
    owner_accent: c.ownerAccent,
    crossed_send_guard: c.crossedSendGuard,
  };
}

const PY_LOAD = `
from porch3.config import load_config_bytes, emit_toml, ConfigError
out = []
for doc in INPUT['docs']:
    try:
        c = load_config_bytes(doc.encode('utf-8', 'surrogatepass'), env=INPUT['env'])
        out.append({'ok': {
            'owner_room': c.owner_room, 'owner_room_dir': str(c.owner_room_dir),
            'mail_root': str(c.mail_root), 'sidecar_dir': str(c.sidecar_dir),
            'allowed_signers': str(c.allowed_signers), 'key_file': str(c.key_file),
            'signing_namespace': c.signing_namespace, 'principal': c.principal,
            'marker': c.marker, 'label': c.label, 'initial_channel': c.initial_channel,
            'owner_accent': c.owner_accent, 'crossed_send_guard': c.crossed_send_guard,
        }, 'emit': emit_toml(c)})
    except ConfigError as exc:
        out.append({'error': str(exc), 'field': exc.field})
    except Exception as exc:
        # porch-tui crashes on some documents (a missing owner_room_dir is a bare KeyError); a crash
        # refuses the config too, so porch-next must refuse it.
        out.append({'error': f'porch-tui crashed: {type(exc).__name__}: {exc}', 'crash': True})
print(json.dumps(out))
`;

const DOCS = [
  'owner_room = "mara"\nowner_room_dir = "/r/mara"\n',
  'owner_room = "mara"\nowner_room_dir = "/r//mara/./x/"\nmail_root = "/m"\n',
  'owner_room = "mara"\nowner_room_dir = "~/room"\nsidecar_dir = "~/side"\n',
  'owner_room = "mara"\nowner_room_dir = "/r/../mara"\n',
  'owner_room = "mara"\nowner_room_dir = "//r/mara"\n',
  'owner_room = "mara"\nowner_room_dir = "relative"\n',
  'owner_room = "mara"\n',
  'owner_room = ""\nowner_room_dir = "/r"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nextra = "nope"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nzzz = 1\naaa = 2\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nmarker = "🧔"\nlabel = "Trey"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nmarker = "A"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nmarker = "🦊🐉"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nlabel = "   "\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nlabel = "x\\ny"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nprincipal = "mara@porch"\nsigning_namespace = "ns.1"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nprincipal = "bad principal"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nsigning_namespace = ""\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\ncrossed_send_guard = false\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\ncrossed_send_guard = "yes"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nowner_accent = "#00FF00"\ninitial_channel = "work"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nowner_accent = "green"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\ninitial_channel = "../x"\n',
  'owner_room = "mara"\nowner_room_dir = "/r\\u0001x"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nkey_file = "/k/key"\nallowed_signers = "/s/as"\n',
  "owner_room = 'mara'\r\nowner_room_dir = '''/r'''\r\n# comment\r\n",
  'owner_room = "mara"\nowner_room_dir = "/r"\nowner_room = "dup"\n',
  '[table]\nowner_room = "mara"\n',
  'owner_room = "mara"\nowner_room_dir = "/r"\nmail_root = 5\n',
  'owner_room = "mara\\u202e"\nowner_room_dir = "/r"\n',
  'not toml at all',
];

needsPorch('against porch-tui', () => {
  it('loads, resolves and refuses exactly like porch-tui', () => {
    const envs: Record<string, string>[] = [
      {},
      { POST_MAIL_ROOT: '/env/mail' },
      { POST_MAIL_ROOT: '' },
    ];
    for (const env of envs) {
      const py = pyJson<{ ok?: object; emit?: string; error?: string; field?: string }[]>(
        PY_LOAD,
        { docs: DOCS, env },
        { porch: true, env: { HOME: home } },
      );
      DOCS.forEach((doc, k) => {
        const want = py[k];
        let got: { ok?: object; emit?: string; error?: string };
        try {
          const c = loadConfigBytes(Buffer.from(doc, 'utf8'), { env, home });
          got = { ok: fields(c), emit: emitToml(c) };
        } catch (err) {
          if (!(err instanceof ConfigError)) throw err;
          got = { error: err.message };
        }
        const label = `${JSON.stringify(env)} ${JSON.stringify(doc)}`;
        if (want?.ok !== undefined) {
          expect(got, label).toEqual({ ok: want.ok, emit: want.emit });
        } else {
          expect(got.error, `${label}: porch-tui refused with ${want?.error}`).toBeDefined();
        }
      });
      // Both outcomes are exercised. A present-but-empty POST_MAIL_ROOT is refused by design, so
      // there only the one document with its own mail_root loads.
      const accepted = py.filter((r) => r.ok !== undefined).length;
      expect(accepted).toBeGreaterThan(env.POST_MAIL_ROOT === '' ? 0 : 8);
      expect(py.filter((r) => r.error !== undefined).length).toBeGreaterThan(8);
    }
  });

  it('agrees on the marker and label corpus', () => {
    const markers = [
      '🦊',
      '👩‍🚀',
      '⚖️',
      '🇺🇸',
      '👋🏻',
      '👨🏻‍💻',
      '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
      '가',
      'é',
      '🧔',
      'é‍b',
      '🚀‍x',
      'A',
      '🦊🐉',
      '🇺🇸🇺🇸',
      '‍🚀',
      '🚀‍',
      '‮',
      '⚖️x',
      '',
      ' ',
      'é',
      '\u0085',
      '🦊\n',
      ' ',
      '️',
      '中',
    ];
    const labels = [
      'Mara',
      '',
      '   ',
      'x'.repeat(32),
      'x'.repeat(33),
      'bad\nlabel',
      ' pad ',
      '🦊'.repeat(32),
      'a‮b',
      'tab\there',
    ];
    const py = pyJson<{ m: boolean[]; l: boolean[] }>(
      `from porch3.config import validate_marker, validate_label, ConfigError
def ok(f, v):
    try:
        f(v); return True
    except ConfigError:
        return False
print(json.dumps({'m': [ok(validate_marker, m) for m in INPUT['m']], 'l': [ok(validate_label, l) for l in INPUT['l']]}))`,
      { m: markers, l: labels },
      { porch: true, env: { HOME: home } },
    );
    const ok = (f: (v: string) => unknown, v: string) => {
      try {
        f(v);
        return true;
      } catch (err) {
        if (err instanceof ConfigError) return false;
        throw err;
      }
    };
    expect(markers.map((m) => ok(validateMarker, m))).toEqual(py.m);
    expect(labels.map((l) => ok(validateLabel, l))).toEqual(py.l);
  });

  it('resolves the documented defaults for mara', () => {
    const c = buildConfig({ ownerRoom: 'mara', ownerRoomDir: '/r/mara' }, { env: {}, home });
    expect(fields(c)).toEqual({
      owner_room: 'mara',
      owner_room_dir: '/r/mara',
      mail_root: `${home}/.claude-mail`,
      sidecar_dir: '/r/mara',
      allowed_signers: '/r/mara/allowed_signers',
      key_file: '/r/mara/mara_porch_key',
      signing_namespace: 'mara-porch',
      principal: 'mara@porch',
      marker: '🦊',
      label: 'Mara',
      initial_channel: 'commons',
      owner_accent: '#FFD700',
      crossed_send_guard: false,
    });
  });
});

needsPorch('pathlib strings', () => {
  it('match Python for normalisation, joins, ~ and abspath', () => {
    const raws = [
      '/a//b/./c/',
      '//a/b',
      '///a',
      'a/../b',
      '.',
      '',
      './x/',
      '~',
      '~/x//y',
      '~root',
      '/..',
      'a/b/..',
    ];
    const py = pyJson<{ p: string[]; e: (string | null)[]; a: string[]; j: string }>(
      `import os
from pathlib import Path
def eu(r):
    try:
        return str(Path(r).expanduser())
    except RuntimeError:
        return None
print(json.dumps({'p': [str(Path(r)) for r in INPUT], 'e': [eu(r) for r in INPUT if not r.startswith('~root')], 'a': [os.path.abspath(r) for r in INPUT if r], 'j': str(Path('/a/') / 'b//c/')}))`,
      raws,
      { env: { HOME: `${home}//` } },
    );
    expect(raws.map(pyPath)).toEqual(py.p);
    expect(
      raws.filter((r) => !r.startsWith('~root')).map((r) => pyExpandUser(r, `${home}//`)),
    ).toEqual(py.e);
    expect(pyJoin('/a/', 'b//c/')).toBe(py.j);
    // A known difference: Python looks up another user's home; this refuses, naming the form.
    expect(() => pyExpandUser('~root/porch', home)).toThrow(
      /cannot expand ~root: porch-next expands only ~ and ~\S+ \(your own home\)/,
    );
    // abspath depends on the working directory: Python ran in this process's cwd.
    expect(raws.filter((r) => r !== '').map((r) => pyAbspath(r))).toEqual(py.a);
  });
});

describe('the TOML subset reader', () => {
  const corpus = [
    'a = "x"',
    "a = 'x'",
    'a = """\nline1\nline2"""',
    "a = '''\nraw \\n'''",
    'a = """x \\\n    y"""',
    'a = """a""""',
    'a = """a"""""',
    'a = """a""""""',
    'a = "\\u00e9\\U0001F98A\\t\\"\\\\"',
    'a = "\\x41"',
    'a = "\\ud800"',
    'a = "\\uD83E"',
    'a = "tab\tok"',
    'a = "bell\u0007"',
    'a = "del\u007f"',
    '"quoted key" = true',
    "'lit key' = false",
    'a = true # comment',
    'a = truex',
    'a = "x" b = "y"',
    'a = "x"\na = "y"',
    'a.b = "x"',
    '[t]\na = "x"',
    '[[t]]',
    'a = 1',
    'a = 1979-05-27',
    'a = inf',
    'a = [1]',
    'a = {b = 1}',
    'a = "x"\r\nb = "y"\r\n',
    'a = "x"\rb = "y"',
    '# only a comment\u0001',
    'a = ',
    '= "x"',
    'a = "unterminated',
    'a = """unterminated',
    ' \t a\t=\t"spaced" \t',
    'ключ = "x"',
    '"" = "empty key"',
  ];
  it('matches tomllib on everything it accepts, and refuses what tomllib refuses', () => {
    const py = pyJson<({ ok: Record<string, unknown>; flat: boolean } | { error: string })[]>(
      `import tomllib
out = []
for doc in INPUT:
    try:
        d = tomllib.loads(doc)
        flat = all(isinstance(v, (str, bool)) for v in d.values())
        out.append({'ok': d if flat else {}, 'flat': flat})
    except tomllib.TOMLDecodeError as exc:
        out.append({'error': str(exc)})
print(json.dumps(out))`,
      corpus,
    );
    let accepted = 0;
    let refused = 0;
    corpus.forEach((doc, k) => {
      const want = py[k] as { ok?: Record<string, unknown>; flat?: boolean; error?: string };
      let got: Map<string, unknown> | Error;
      try {
        got = parseFlatToml(doc);
      } catch (err) {
        if (!(err instanceof TomlError)) throw err;
        got = err;
      }
      const label = JSON.stringify(doc);
      if (want.error !== undefined) {
        expect(got, `${label}: tomllib refused (${want.error})`).toBeInstanceOf(TomlError);
        expect(got, label).not.toBeInstanceOf(TomlSubsetError);
        refused++;
      } else if (want.flat === false) {
        expect(got, `${label} is valid but not flat`).toBeInstanceOf(TomlSubsetError);
      } else {
        expect(got instanceof Map ? Object.fromEntries(got) : got, label).toEqual(want.ok);
        accepted++;
      }
    });
    expect(accepted).toBeGreaterThan(10);
    expect(refused).toBeGreaterThan(10);
  });
});

describe('loading from disk', () => {
  it('reads $PORCH_CONFIG or ~/.config/porch/config.toml, and names porch-next init when missing', () => {
    expect(configPath({}, home)).toBe(join(home, '.config/porch/config.toml'));
    expect(configPath({ PORCH_CONFIG: '/x//c.toml' }, home)).toBe('/x/c.toml');
    expect(() => loadPorchConfig({ env: {}, home })).toThrow(/porch-next init/);

    const path = join(home, 'c.toml');
    writeFileSync(path, 'owner_room = "mara"\nowner_room_dir = "/r/mara"\n');
    const c = loadPorchConfig({ env: { PORCH_CONFIG: path }, home });
    expect(c.ownerRoom).toBe('mara');
    expect(c.sourcePath).toBe(path);
  });

  it('refuses a symlinked or oversized config', () => {
    const real = join(home, 'real.toml');
    writeFileSync(real, 'owner_room = "mara"\nowner_room_dir = "/r/mara"\n');
    const link = join(home, 'link.toml');
    symlinkSync(real, link);
    expect(() => loadPorchConfig({ path: link, env: {}, home })).toThrow(ConfigError);
    const big = join(home, 'big.toml');
    writeFileSync(big, `# ${'x'.repeat(1 << 20)}\n`);
    expect(() => loadPorchConfig({ path: big, env: {}, home })).toThrow(ConfigError);
  });
});

describe('porch-next settings', () => {
  it('defaults to full motion and lets PORCH_MOTION win', () => {
    expect(loadSettings({ env: {}, home })).toEqual({
      settings: { motion: 'full', crossedStrip: false },
      warnings: [],
    });
    const dir = join(home, '.config', 'porch-next');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.toml'), 'motion = "reduced"\n');
    expect(loadSettings({ env: {}, home }).settings.motion).toBe('reduced');
    expect(loadSettings({ env: { PORCH_MOTION: 'off' }, home }).settings.motion).toBe('off');
  });

  it('warns and keeps the default on bad values, unknown keys and broken files', () => {
    const dir = join(home, '.config', 'porch-next');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.toml'), 'motion = "wild"\ncolour = "red"\n');
    const r = loadSettings({ env: { PORCH_MOTION: 'fast' }, home });
    expect(r.settings.motion).toBe('full');
    expect(r.warnings).toHaveLength(3);
    writeFileSync(join(dir, 'settings.toml'), 'motion = \n');
    expect(loadSettings({ env: {}, home }).warnings[0]).toMatch(/ignored/);
  });

  it('crossed_strip is off by default, a toml boolean turns it on, and the environment wins', () => {
    expect(loadSettings({ env: {}, home }).settings.crossedStrip).toBe(false);
    const dir = join(home, '.config', 'porch-next');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.toml'), 'crossed_strip = true\n');
    const on = loadSettings({ env: {}, home });
    expect(on.settings.crossedStrip).toBe(true);
    expect(on.warnings).toEqual([]);
    expect(
      loadSettings({ env: { PORCH_CROSSED_STRIP: 'false' }, home }).settings.crossedStrip,
    ).toBe(false);
    rmSync(join(dir, 'settings.toml'));
    expect(loadSettings({ env: { PORCH_CROSSED_STRIP: '1' }, home }).settings.crossedStrip).toBe(
      true,
    );
  });

  it('a bad crossed_strip value warns and the strip stays off', () => {
    const dir = join(home, '.config', 'porch-next');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.toml'), 'crossed_strip = "yes please"\n');
    const fromFile = loadSettings({ env: {}, home });
    expect(fromFile.settings.crossedStrip).toBe(false);
    expect(fromFile.warnings).toHaveLength(1);
    expect(fromFile.warnings[0]).toMatch(/crossed_strip must be true or false/);
    rmSync(join(dir, 'settings.toml'));
    const fromEnv = loadSettings({ env: { PORCH_CROSSED_STRIP: 'maybe' }, home });
    expect(fromEnv.settings.crossedStrip).toBe(false);
    expect(fromEnv.warnings[0]).toMatch(/PORCH_CROSSED_STRIP must be true or false/);
  });
});
