import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { type DisplayRecord, heldReadRegular, SafeDirectory } from '@estate/post-kit';
import type { HalfBlockCell } from '../../grid/grid.ts';
import { halfBlocks } from '../../grid/pixel.ts';
import { graphemes, textWidth, width, wrap } from '../../grid/text.ts';
import type { AppState, KeyBinding, MessageRenderer } from '../registry.ts';
import { K } from '../theme.ts';
import { decodeInWorker } from './decode.ts';
import {
  type FeatureActions,
  type FeatureRuntime,
  featureCommand,
  outcome,
  request,
} from './runtime.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40000000;
export type Raster = { width: number; height: number; data: Uint8Array };
const extensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
function ellipsize(text: string, columns: number): string {
  if (textWidth(text) <= columns) return text;
  if (columns < 1) return '';
  let out = '';
  let used = 0;
  for (const ch of graphemes(text)) {
    if (used + width(ch) > columns - 1) break;
    out += ch;
    used += width(ch);
  }
  return `${out}…`;
}
export function imagePaths(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s'"(<])((?:~\/|\/)[^\s'"<>|;]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((p) => extensions.has(extname(p).toLowerCase()))
    .slice(0, 4);
}
function imageCaption(text: string): string {
  for (const path of imagePaths(text)) text = text.replaceAll(path, `[image: ${basename(path)}]`);
  return text;
}
export function imagePath(text: string, home = homedir()): string {
  let p = text.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))
    p = p.slice(1, -1);
  if (p.startsWith('~/')) p = join(home, p.slice(2));
  if (p.startsWith('~')) throw new Error('only ~/ paths are supported');
  if (!p || [...p].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
    throw new Error('invalid image path');
  if (!extensions.has(extname(p).toLowerCase()))
    throw new Error('image must be PNG, JPEG, GIF or WebP');
  return resolve(p);
}
function pixelBudget(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new Error('image exceeds 40 MP or has invalid dimensions');
}
export function imageInfo(
  bytes: Buffer,
  extension: string,
): { width: number; height: number; format: string } {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('image must be 1 B to 5 MiB');
  let width = 0;
  let height = 0;
  let format = '';
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.length >= 33 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    format = 'png';
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    format = 'jpeg';
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i++] !== 255) throw new Error('invalid JPEG');
      while (bytes[i] === 255) i++;
      const marker = bytes[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker !== undefined && marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) throw new Error('invalid JPEG segment');
      if (
        marker !== undefined &&
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)
      ) {
        if (length < 8) throw new Error('invalid JPEG dimensions');
        height = bytes.readUInt16BE(i + 3);
        width = bytes.readUInt16BE(i + 5);
        break;
      }
      i += length;
    }
  } else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.length >= 13) {
    format = 'gif';
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.length >= 30
  ) {
    format = 'webp';
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (chunk === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 16383;
      height = bytes.readUInt16LE(28) & 16383;
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
  }
  const expected = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1);
  if (format !== expected) throw new Error('image extension does not match magic bytes');
  pixelBudget(width, height);
  return { width, height, format };
}
export async function decodeImage(
  bytes: Buffer,
  extension: string,
  runtime: FeatureRuntime,
): Promise<Raster | string> {
  const info = imageInfo(bytes, extension);
  if (info.format === 'png' || info.format === 'jpeg') return decodeInWorker(bytes, info.format);
  if (!(await runtime.ffmpegAvailable()))
    return `${info.format.toUpperCase()} preview unavailable · ffmpeg required`;
  try {
    const output = await runtime.execute(
      'ffmpeg',
      [
        '-v',
        'error',
        '-threads',
        '1',
        '-max_pixels',
        '40000000',
        '-max_alloc',
        '268435456',
        '-i',
        'pipe:0',
        '-frames:v',
        '1',
        '-vf',
        "scale='min(640,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
        '-f',
        'image2pipe',
        '-threads',
        '1',
        '-vcodec',
        'png',
        'pipe:1',
      ],
      bytes,
    );
    const png = await decodeImage(output, '.png', runtime);
    if (typeof png === 'string') throw new Error('decoder failed');
    return png;
  } catch {
    throw new Error(`invalid ${info.format.toUpperCase()} image or ffmpeg could not decode it`);
  }
}
/** Hold and bound the source; never follow its final symlink or reopen it while spooling. */
export async function spoolImage(source: string, runtime: FeatureRuntime): Promise<string> {
  const path = imagePath(source, runtime.env.HOME ?? homedir());
  const bytes = heldReadRegular(path, MAX_IMAGE_BYTES, 'image').data;
  const preview = await decodeImage(bytes, extname(path).toLowerCase(), runtime);
  if (typeof preview === 'string') imageInfo(bytes, extname(path).toLowerCase());
  const spool =
    runtime.spool ??
    join(
      runtime.env.XDG_CACHE_HOME ?? join(runtime.env.HOME ?? homedir(), '.cache'),
      'porch',
      'spool',
    );
  mkdirSync(dirname(spool), { recursive: true, mode: 0o700 });
  const dir = await SafeDirectory.open(spool, { create: true, private: true });
  try {
    const name = `${randomUUID()}${extname(path).toLowerCase()}`;
    const fd = dir.open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    dir.sync();
    return join(spool, name);
  } finally {
    dir.close();
  }
}
export function rasterCells(r: Raster, width: number, rows = 15): HalfBlockCell[][] {
  const scale = Math.min(1, Math.max(1, width) / r.width, (Math.max(1, rows) * 2) / r.height);
  const w = Math.max(1, Math.floor(r.width * scale));
  const h = Math.max(1, Math.floor(r.height * scale));
  const pixels = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const i = (Math.floor(y / scale) * r.width + Math.floor(x / scale)) * 4;
      if ((r.data[i + 3] ?? 0) < 128) return null;
      return `#${[r.data[i], r.data[i + 1], r.data[i + 2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
    }),
  );
  return halfBlocks(pixels);
}
export class Images {
  private readonly measurements = new Map<string, Raster | string>();
  private readonly sessions = new WeakMap<
    AppState['actions'],
    { revealed: Set<string>; cache: Map<string, Raster | string>; pending: Set<string> }
  >();
  constructor(readonly runtime: FeatureRuntime) {}
  private session(s: AppState) {
    let session = this.sessions.get(s.actions);
    if (!session) {
      session = { revealed: new Set(), cache: new Map(), pending: new Set() };
      this.sessions.set(s.actions, session);
    }
    return session;
  }
  trusted(r: DisplayRecord, s: AppState): boolean {
    return (
      s.ownMessageIds.has(r.raw.id) ||
      r.verdict.state === 'verified' ||
      this.session(s).revealed.has(r.raw.id)
    );
  }
  reveal(s: AppState): boolean {
    const r = [...(s.current ? (s.views.get(s.current)?.records ?? []) : [])]
      .reverse()
      .find((r) => imagePaths(r.text).length && !this.trusted(r, s));
    if (!r) {
      s.actions.status('no deferred images');
      return false;
    }
    this.session(s).revealed.add(r.raw.id);
    s.actions.requestFrame();
    return true;
  }
  async load(r: DisplayRecord, s: AppState): Promise<void> {
    if (!this.trusted(r, s)) return;
    const session = this.session(s);
    for (const path of imagePaths(r.text)) {
      const key = `${r.raw.id}\0${path}`;
      if (session.cache.has(key) || session.pending.has(key)) continue;
      session.pending.add(key);
      try {
        const absolute = imagePath(path, this.runtime.env.HOME ?? homedir());
        const bytes = heldReadRegular(absolute, MAX_IMAGE_BYTES, 'image').data;
        session.cache.set(key, await decodeImage(bytes, extname(path).toLowerCase(), this.runtime));
      } catch (err) {
        session.cache.set(key, `image unavailable: ${(err as Error).message}`);
      } finally {
        const loaded = session.cache.get(key);
        if (loaded !== undefined) this.measurements.set(key, loaded);
        session.pending.delete(key);
        s.actions.requestFrame();
      }
      while (session.cache.size > 64) {
        const oldest = session.cache.keys().next().value;
        if (oldest !== undefined) {
          session.cache.delete(oldest);
          this.measurements.delete(oldest);
        }
      }
    }
  }
  renderer(): MessageRenderer {
    return {
      kind: 'message',
      match: (r) => imagePaths(r.text).length > 0,
      measure: (r, w) =>
        wrap(imageCaption(r.text), w).length +
        imagePaths(r.text).reduce((n, path) => {
          const image = this.measurements.get(`${r.raw.id}\0${path}`);
          return n + (!image || typeof image === 'string' ? 1 : rasterCells(image, w).length);
        }, 0),
      draw: (g, area, r, s) => {
        let y = area.y;
        const session = this.session(s);
        g.withClip(area, () => {
          for (const line of wrap(imageCaption(r.text), area.w))
            g.text(area.x, y++, line, { fg: K.data }, area.w);
          for (const path of imagePaths(r.text)) {
            if (!this.trusted(r, s)) {
              g.text(
                area.x,
                y++,
                ellipsize(`image · Ctrl+R to render · ${basename(path)}`, area.w),
                { fg: K.gray },
                area.w,
              );
              continue;
            }
            const loaded = session.cache.get(`${r.raw.id}\0${path}`);
            if (!loaded) {
              g.text(area.x, y++, 'image loading…', { fg: K.gray }, area.w);
              void this.load(r, s);
            } else if (typeof loaded === 'string')
              g.text(area.x, y++, ellipsize(loaded, area.w), { fg: K.gray }, area.w);
            else {
              const cells = rasterCells(loaded, area.w);
              g.blit(area.x, y, cells);
              y += cells.length;
            }
          }
        });
      },
    };
  }
  key(): KeyBinding {
    return {
      id: 'features-images',
      layer: 'chord',
      key: (k, s) => {
        if (k.ctrl && k.name === 'r') {
          this.reveal(s);
          return 'handled';
        }
        if (k.ctrl && k.name === 'v' && this.runtime.platform === 'darwin') {
          const append = (s.actions as FeatureActions).appendImagePath;
          if (!append || !s.current) {
            s.actions.status('clipboard attachment route is unavailable');
            return 'handled';
          }
          const channel = s.current;
          void this.clipboard()
            .then((path) => append.call(s.actions, channel, path))
            .catch((err) => s.actions.status(`clipboard image: ${(err as Error).message}`));
          return 'handled';
        }
        return 'pass';
      },
    };
  }
  async clipboard(): Promise<string> {
    const dir = join(tmpdir(), `porch-clip-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    const png = join(dir, 'clipboard.png');
    const tiff = join(dir, 'clipboard.tiff');
    const script = (format: string, path: string) =>
      `set imageData to the clipboard as «class ${format}»\nset outputFile to open for access POSIX file ${JSON.stringify(path)} with write permission\ntry\nset eof outputFile to 0\nwrite imageData to outputFile\nclose access outputFile\non error errorText\nclose access outputFile\nerror errorText\nend try`;
    try {
      try {
        await this.runtime.execute('osascript', ['-e', script('PNGf', png)]);
      } catch {
        await this.runtime.execute('osascript', ['-e', script('TIFF', tiff)]);
        await this.runtime.execute('sips', ['-s', 'format', 'png', tiff, '--out', png]);
      }
      const fd = openSync(png, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let resample = false;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
          throw new Error('clipboard image exceeds its read budget');
        const head = Buffer.alloc(33);
        const read = readSync(fd, head, 0, 33, 0);
        if (
          read < 33 ||
          !head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error('clipboard did not contain PNG');
        resample =
          stat.size > MAX_IMAGE_BYTES ||
          head.readUInt32BE(16) > 2000 ||
          head.readUInt32BE(20) > 2000;
      } finally {
        closeSync(fd);
      }
      if (resample) await this.runtime.execute('sips', ['-Z', '2000', png]);
      return await spoolImage(png, this.runtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  command() {
    return featureCommand(
      'img',
      '/img <path> — send an image file to this channel',
      async (args, ctx) => {
        const path = await spoolImage(args, this.runtime);
        outcome(ctx, await ctx.send(request(ctx.state, path)));
      },
    );
  }
  /** T6 calls this for path-only pasted text before inserting it into the composer. */
  async paste(text: string, s: AppState): Promise<boolean> {
    if (imagePaths(text).length !== 1 || imagePaths(text)[0] !== text.trim()) return false;
    const append = (s.actions as FeatureActions).appendImagePath;
    if (!append || !s.current) throw new Error('image attachment route is unavailable');
    const path = await spoolImage(text, this.runtime);
    append.call(s.actions, s.current, path);
    return true;
  }
}
