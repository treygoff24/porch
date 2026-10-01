/**
 * PNG captures of a scene for review, with no terminal and no renderer: the scene draws into a
 * `Grid`, `Grid.toHtml()` lays it out one fixed cell per grapheme, and headless Chromium screenshots
 * the page over the DevTools protocol. The page is injected with `Page.setDocumentContent` because a
 * managed browser's URL policy blocks `file://` and `--screenshot` then exits 0 having written
 * nothing (Loom's `scripts/cockpit-capture.ts:107-190`, which this follows).
 *
 *   node --import tsx scripts/capture.ts [--scene demo] [--size 40x52 ...] [--out docs/captures]
 *                                        [--prefix T1-demo] [--no-color] [--html]
 *
 * Sizes default to the three the design is judged at: 40x52 (phone), 100x32 (laptop), 160x44
 * (wide). Chromium is found on PATH; it is this script's own child, started in its own process
 * group and stopped by that group, never by name.
 *
 * From another script or a test (a package lane's sheet, for one), without editing this file:
 *
 *   import { captureGrid, captureScene } from '<repo>/scripts/capture.ts';
 *   await captureGrid(grid, 'docs/captures/T2-pixel-sheet.png');          // any Grid you drew
 *   await captureScene(scene, { cols: 100, rows: 32 }, 'out/scene.png');  // a Scene, at rest
 *
 * Both resolve to the PNG's absolute path, create its directory, take `{ noColor, html }` (html
 * also writes the page beside the PNG), and throw when no Chromium is on PATH. Importing this file
 * runs nothing; only running it as a script does.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { demoScene } from '../src/demo/demo-scene.ts';
import { Grid } from '../src/grid/grid.ts';
import type { HostApi, Scene } from '../src/host/grid-host.ts';

const SCENES: Record<string, () => Scene> = {
  demo: () => demoScene({ motion: 'off' }),
};
export const DEFAULT_SIZES = ['40x52', '100x32', '160x44'];
/** Pixels per column and per row in a capture. */
export const CELL_W = 9;
export const CELL_H = 18;

export type CaptureOptions = {
  /** Draw in the `NO_COLOR` monochrome pair. */
  noColor?: boolean;
  /** Also write the page as `<png without .png>.html`. */
  html?: boolean;
};

/** A scene drawn once, at rest, into a grid of `cols` by `rows`. */
export function sceneGrid(scene: Scene, cols: number, rows: number): Grid {
  const grid = new Grid(cols, rows, scene.ground);
  const still: HostApi = {
    requestFrame: () => {},
    // A capture is one frame at rest: an animation asked for here has already ended.
    animate: () => ({ start: 0, end: 0, cancel: () => {} }),
    now: () => 0,
    focused: () => true,
    quit: () => {},
  };
  scene.draw(grid, still);
  return grid;
}

/** Screenshot `grid` into the PNG at `png`; resolves to its absolute path. */
export async function captureGrid(
  grid: Grid,
  png: string,
  opts: CaptureOptions = {},
): Promise<string> {
  const bin = findChromium();
  if (bin === undefined) throw new Error('no chromium on PATH: cannot write PNG captures');
  const file = resolve(png);
  mkdirSync(dirname(file), { recursive: true });
  const html = grid.toHtml({
    cellWidth: CELL_W,
    cellHeight: CELL_H,
    noColor: opts.noColor ?? false,
  });
  if (opts.html === true) writeFileSync(`${file.replace(/\.png$/, '')}.html`, html);
  await screenshot(bin, html, file, grid.cols * CELL_W, grid.rows * CELL_H);
  return file;
}

/** `scene` drawn at rest at `size`, screenshot into `png`; resolves to its absolute path. */
export function captureScene(
  scene: Scene,
  size: { cols: number; rows: number },
  png: string,
  opts: CaptureOptions = {},
): Promise<string> {
  return captureGrid(sceneGrid(scene, size.cols, size.rows), png, opts);
}

let chromium: string | null | undefined;

/** The first Chromium on PATH, looked up once. */
export function findChromium(): string | undefined {
  if (chromium === undefined) {
    chromium =
      ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].find(
        (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0,
      ) ?? null;
  }
  return chromium ?? undefined;
}

/** Screenshot `html` at `w` by `h` CSS pixels into `png`. */
async function screenshot(bin: string, html: string, png: string, w: number, h: number) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-shot-'));
  const child = spawn(
    bin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  try {
    const portFile = join(dir, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !existsSync(portFile); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    const target = (await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
    ).json()) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => {
      ws.onopen = r;
    });
    let n = 0;
    const waiting = new Map<number, (m: { result: Record<string, unknown> }) => void>();
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; result: Record<string, unknown> };
      if (d.id !== undefined) waiting.get(d.id)?.(d);
    };
    const call = (method: string, params: object = {}) =>
      new Promise<{ result: Record<string, unknown> }>((done) => {
        n += 1;
        waiting.set(n, done);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    await call('Page.enable');
    const tree = (await call('Page.getFrameTree')).result as {
      frameTree: { frame: { id: string } };
    };
    await call('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html });
    await call('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((r) => setTimeout(r, 300));
    const shot = (await call('Page.captureScreenshot', { format: 'png' })).result as {
      data: string;
    };
    writeFileSync(png, Buffer.from(shot.data, 'base64'));
    ws.close();
  } finally {
    const gone = new Promise((r) => child.once('exit', r));
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scene: { type: 'string', default: 'demo' },
      size: { type: 'string', multiple: true },
      out: { type: 'string', default: 'docs/captures' },
      prefix: { type: 'string' },
      'no-color': { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
    },
  });
  const make = SCENES[values.scene];
  if (make === undefined) {
    process.stderr.write(
      `unknown --scene ${values.scene}; known: ${Object.keys(SCENES).join(', ')}\n`,
    );
    return 2;
  }
  const sizes = (values.size ?? DEFAULT_SIZES).map((s) => {
    const [c, r] = s.split('x').map(Number);
    if (c === undefined || r === undefined || !(c >= 20) || !(r >= 6)) {
      throw new Error(`bad --size ${s}: expected COLSxROWS`);
    }
    return { cols: c, rows: r, label: `${c}x${r}` };
  });
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const prefix = values.prefix ?? `T1-${values.scene}`;
  if (findChromium() === undefined) {
    process.stderr.write('no chromium on PATH: cannot write PNG captures\n');
    return 1;
  }
  for (const size of sizes) {
    const base = join(out, `${prefix}-${size.label}${values['no-color'] ? '-nocolor' : ''}`);
    const png = await captureScene(make(), size, `${base}.png`, {
      noColor: values['no-color'],
      html: values.html,
    });
    process.stdout.write(`${png}\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
