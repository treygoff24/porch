import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { encode as png } from 'fast-png';
import jpeg from 'jpeg-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeImage,
  Images,
  imageInfo,
  imagePath,
  imagePaths,
  MAX_IMAGE_BYTES,
  rasterCells,
  spoolImage,
} from '../../src/app/features/images.ts';
import { FeatureRuntime } from '../../src/app/features/runtime.ts';
import { Grid } from '../../src/grid/grid.ts';
import { context, offTheme, record, state } from './helpers.ts';
import { compressedPng } from './image-fixtures.ts';

const roots: string[] = [];
const root = () => {
  const p = mkdtempSync(join(tmpdir(), 'porch-images-'));
  roots.push(p);
  return p;
};
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const pixels = {
  width: 2,
  height: 2,
  data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]),
  channels: 4,
};
const pngBytes = () => Buffer.from(png(pixels));
const runtime = (dir = root()) =>
  new FeatureRuntime({
    spool: join(dir, 'spool'),
    env: { HOME: dir },
    execute: vi.fn(async () => {
      throw new Error('missing');
    }),
    osc52: vi.fn(),
  });
describe('image admission and display', () => {
  it('checks extension, magic, byte budget, dimensions and corrupt PNG before spooling', async () => {
    expect(imagePath('"~/a.PNG"', '/temp')).toBe('/temp/a.PNG');
    expect(imagePaths('https://host/a.png file:///tmp/b.png https://host//tmp/c.png')).toEqual([]);
    expect(imagePaths('text /tmp/a.png and "~/b.jpeg"')).toEqual(['/tmp/a.png', '~/b.jpeg']);
    expect(() => imagePath('~other/a.png')).toThrow();
    expect(() => imagePath('/tmp/a.txt')).toThrow();
    expect(() => imageInfo(Buffer.alloc(0), '.png')).toThrow('1 B');
    expect(() => imageInfo(Buffer.alloc(MAX_IMAGE_BYTES + 1), '.png')).toThrow('5 MiB');
    expect(() => imageInfo(pngBytes(), '.jpg')).toThrow('magic');
    const huge = pngBytes();
    huge.writeUInt32BE(40000001, 16);
    expect(() => imageInfo(huge, '.png')).toThrow('40 MP');
    const zero = pngBytes();
    zero.writeUInt32BE(0, 16);
    expect(() => imageInfo(zero, '.png')).toThrow('dimensions');
    const corrupt = pngBytes();
    corrupt[corrupt.length - 1] = 9;
    await expect(decodeImage(corrupt, '.png', runtime())).rejects.toThrow();
    const dir = root();
    const path = join(dir, 'source.png');
    writeFileSync(path, pngBytes());
    const spooled = await spoolImage(path, runtime(dir));
    expect(readFileSync(spooled)).toEqual(pngBytes());
    expect(statSync(spooled).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'spool')).mode & 0o777).toBe(0o700);
    const link = join(dir, 'link.png');
    symlinkSync(path, link);
    await expect(spoolImage(link, runtime(dir))).rejects.toThrow();
    await expect(spoolImage(dir, runtime(dir))).rejects.toThrow();
  });
  it('refuses duplicate PNG headers before decoder allocation', async () => {
    const valid = pngBytes();
    const head = valid.subarray(8, 33);
    const dup = Buffer.concat([valid.subarray(0, 33), head, valid.subarray(33)]);
    await expect(decodeImage(dup, '.png', runtime())).rejects.toThrow('duplicate');
  });
  it('refuses a real 64 MiB PNG inflate bomb independently of the duplicate-header check', async () => {
    const bomb = await compressedPng(2, 2, 64 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(100000);
    await expect(decodeImage(bomb, '.png', runtime())).rejects.toThrow();
  });
  it('keeps the UI responsive for the 8000x5000 hostile PNG and labels its decode budget', async () => {
    const hostile = await compressedPng(8000, 5000);
    expect(hostile.length).toBeLessThan(200000);
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    const started = performance.now();
    try {
      expect(await decodeImage(hostile, '.png', runtime())).toContain(
        'PNG preview unavailable · decode limit',
      );
      expect(ticks).toBeGreaterThan(0);
      expect(performance.now() - started).toBeLessThan(4000);
    } finally {
      clearInterval(heartbeat);
    }
  });
  it('decodes PNG and JPEG in a worker into half-blocks without solid blocks', async () => {
    const r = await decodeImage(pngBytes(), '.png', runtime());
    expect(typeof r).not.toBe('string');
    if (typeof r === 'string') throw new Error(r);
    expect(rasterCells(r, 2)).toEqual([
      [
        { ch: '▀', fg: '#ff0000', bg: '#0000ff' },
        { ch: '▀', fg: '#00ff00', bg: null },
      ],
    ]);
    const jpg = jpeg.encode(pixels, 90).data;
    const j = await decodeImage(jpg, '.jpeg', runtime());
    expect(typeof j).not.toBe('string');
  });
  it('renders packed greyscale, indexed alpha and 16-bit PNG pixels faithfully', async () => {
    const chunk = (kind: string, data: Buffer) => {
      const output = Buffer.alloc(data.length + 12);
      output.writeUInt32BE(data.length);
      output.write(kind, 4);
      data.copy(output, 8);
      output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4);
      return output;
    };
    const make = (
      width: number,
      depth: number,
      color: number,
      raw: number[],
      extra: Buffer[] = [],
    ) => {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(width);
      header.writeUInt32BE(1, 4);
      header[8] = depth;
      header[9] = color;
      return Buffer.concat([
        pngBytes().subarray(0, 8),
        chunk('IHDR', header),
        ...extra,
        chunk('IDAT', deflateSync(Buffer.from(raw))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    };
    const gray = await decodeImage(make(2, 1, 0, [0, 128]), '.png', runtime());
    if (typeof gray === 'string') throw new Error(gray);
    expect([...gray.data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
    const indexed = await decodeImage(
      make(
        2,
        1,
        3,
        [0, 64],
        [chunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0])), chunk('tRNS', Buffer.from([255, 0]))],
      ),
      '.png',
      runtime(),
    );
    if (typeof indexed === 'string') throw new Error(indexed);
    expect([...indexed.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 0]);
    const deep = await decodeImage(make(1, 16, 2, [0, 255, 255, 0, 0, 0, 0]), '.png', runtime());
    if (typeof deep === 'string') throw new Error(deep);
    expect([...deep.data]).toEqual([255, 0, 0, 255]);
  });
  it('decodes a real GIF through installed ffmpeg or labels its absence without skips', async () => {
    const gif = Buffer.from(
      '47494638396101000100800000000000ffffff2c00000000010001000002024401003b',
      'hex',
    );
    const rt = new FeatureRuntime({ osc52: vi.fn() });
    const available = await rt.ffmpegAvailable();
    const result = await decodeImage(gif, '.gif', rt);
    expect(typeof result === 'string').toBe(!available);
    if (typeof result !== 'string') expect(result.data.length).toBe(4);
  });
  it.each(['.gif', '.webp'])('uses ffmpeg or a labelled placeholder for %s', async (ext) => {
    const bytes =
      ext === '.gif'
        ? Buffer.from(
            '47494638396101000100800000000000ffffff2c00000000010001000002024401003b',
            'hex',
          )
        : Buffer.from('524946462200000057454250565038580a00000000000000000000000000', 'hex');
    const missing = await decodeImage(bytes, ext, runtime());
    expect(missing).toContain('ffmpeg required');
    const present = runtime();
    vi.spyOn(present, 'execute').mockResolvedValue(pngBytes());
    const result = await decodeImage(bytes, ext, present);
    expect(typeof result).not.toBe('string');
    expect(present.execute).toHaveBeenCalledWith(
      'ffmpeg',
      expect.arrayContaining(['pipe:0']),
      bytes,
    );
  });
  it('never touches deferred paths, reveals one newest record, and auto-renders receipt/verified only', async () => {
    const dir = root();
    const path = join(dir, 'proof.png');
    writeFileSync(path, pngBytes());
    const foreign = record(join(dir, 'a-deliberately-long-deferred-proof.png'));
    const newer = record(path, { id: '20260930-230001-000001-abcdef' });
    const s = state([foreign, newer]);
    const images = new Images(runtime(dir));
    await images.load(foreign, s);
    expect(s.actions.requestFrame).not.toHaveBeenCalled();
    expect(images.trusted(foreign, s)).toBe(false);
    images.reveal(s);
    expect(images.trusted(newer, s)).toBe(true);
    expect(images.trusted(foreign, s)).toBe(false);
    const failed = { ...foreign, verdict: { state: 'failed' as const, reason: 'bad' } };
    expect(images.trusted(failed, s)).toBe(false);
    const unknown = { ...foreign, verdict: { state: 'unknown' as const, reason: 'missing' } };
    expect(images.trusted(unknown, s)).toBe(false);
    expect(images.trusted({ ...foreign, verdict: { state: 'verified', reason: 'ok' } }, s)).toBe(
      true,
    );
    expect(images.trusted(foreign, { ...s, ownMessageIds: new Set([foreign.raw.id]) })).toBe(true);
    await images.load(newer, s);
    for (const [cols, rows] of [
      [40, 52],
      [100, 32],
      [160, 44],
    ]) {
      const g = new Grid(cols ?? 40, rows ?? 52, () => ({
        ch: ' ',
        fg: '#c8d8e0',
        bg: '#05080b',
        w: 1,
      }));
      images.renderer().draw(g, { x: 0, y: 0, w: cols ?? 40, h: rows ?? 52 }, foreign, s);
      expect(g.toText()).toContain('Ctrl+R');
      if (cols === 40) expect(g.toText()).toContain('…');
      expect(g.toText()).not.toContain('▀');
      images.renderer().draw(g, { x: 0, y: 5, w: cols ?? 40, h: 20 }, newer, s);
      expect(g.toText()).toContain('▀');
    }
    // Feature ink is theme ink: the caption in `data`, the Ctrl+R hint in `gray`.
    const captioned = { ...foreign, text: `deferred proof: ${foreign.text}` };
    const ink = new Grid(120, 6, () => ({ ch: ' ', fg: '#c8d8e0', bg: '#05080b', w: 1 }));
    images.renderer().draw(ink, { x: 0, y: 0, w: 120, h: 6 }, captioned, s);
    expect(ink.toText()).toContain('deferred proof:');
    expect(ink.toText()).toContain('Ctrl+R');
    expect(offTheme(ink)).toEqual([]);
  });
  it('spools img and pasted paths, and sends only through the command transaction', async () => {
    const dir = root();
    const path = join(dir, 'source.png');
    writeFileSync(path, pngBytes());
    const images = new Images(runtime(dir));
    const ctx = context();
    const append = vi.fn();
    Object.assign(ctx.state.actions, { appendImagePath: append });
    await images.command().run(path, ctx);
    expect(ctx.send).toHaveBeenCalledOnce();
    expect(await images.paste(path, ctx.state)).toBe(true);
    expect(append).toHaveBeenCalledWith('commons', expect.stringContaining('/spool/'));
    expect(ctx.state.actions.insert).not.toHaveBeenCalled();
    expect(imagePaths('look /tmp/a.png; evil')).toEqual(['/tmp/a.png']);
    expect(await images.paste('text before /tmp/a.png', ctx.state)).toBe(false);
  });
  it('Mac paste captures its channel and appends through the draft-preserving adapter', async () => {
    const images = new Images(
      new FeatureRuntime({ platform: 'darwin', execute: vi.fn(), osc52: vi.fn() }),
    );
    const s = state();
    const append = vi.fn();
    Object.assign(s.actions, { appendImagePath: append });
    vi.spyOn(images, 'clipboard').mockResolvedValue('/private/spool/clipboard.png');
    images.key().key({ name: 'v', ctrl: true, alt: false, shift: false }, s);
    s.actions.openChannel('elsewhere');
    await vi.waitFor(() =>
      expect(append).toHaveBeenCalledWith('commons', '/private/spool/clipboard.png'),
    );
    expect(s.actions.insert).not.toHaveBeenCalled();
  });
  it('Mac clipboard PNGf and TIFF fallback are spooled; Linux Ctrl+V passes to text paste', async () => {
    for (const [fallback, oversize] of [
      [false, false],
      [true, false],
      [false, true],
    ]) {
      const rt = runtime();
      const calls: string[] = [];
      vi.spyOn(rt, 'execute').mockImplementation(async (file, args) => {
        calls.push(file);
        const script = args[1] ?? '';
        if (file === 'osascript') {
          if (fallback && script.includes('PNGf')) throw new Error('no PNG');
          const match = /POSIX file ("[^"]+")/.exec(script);
          if (!match) throw new Error('missing output path');
          writeFileSync(
            JSON.parse(match[1] ?? '""'),
            oversize ? Buffer.concat([pngBytes(), Buffer.alloc(MAX_IMAGE_BYTES)]) : pngBytes(),
          );
        } else if (file === 'sips') writeFileSync(args.at(-1) ?? '', pngBytes());
        return Buffer.alloc(0);
      });
      const path = await new Images(rt).clipboard();
      expect(readFileSync(path)).toEqual(pngBytes());
      expect(calls).toEqual(
        fallback
          ? ['osascript', 'osascript', 'sips']
          : oversize
            ? ['osascript', 'sips']
            : ['osascript'],
      );
    }
    expect(
      new Images(new FeatureRuntime({ platform: 'linux', execute: vi.fn(), osc52: vi.fn() }))
        .key()
        .key({ name: 'v', ctrl: true, alt: false, shift: false }, state()),
    ).toBe('pass');
  });
});
