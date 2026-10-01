import { parentPort, workerData } from 'node:worker_threads';
import { decode as pngDecode } from 'fast-png';
import jpeg from 'jpeg-js';
import type { Raster } from './images.ts';
import { boundedPng } from './png.ts';

const { bytes: input, format } = workerData as { bytes: Uint8Array; format: string };
const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
try {
  let decoded: Raster;
  if (format === 'png') {
    const png = pngDecode(boundedPng(bytes), { checkCrc: true });
    const data = png;
    const ratio = Math.min(1, 640 / data.width, 480 / data.height);
    const width = Math.max(1, Math.floor(data.width * ratio));
    const height = Math.max(1, Math.floor(data.height * ratio));
    const rgba = new Uint8Array(width * height * 4);
    const scale = data.depth === 16 ? 257 : data.depth === 8 ? 1 : ((1 << data.depth) - 1) / 255;
    for (let i = 0; i < width * height; i++) {
      const x = Math.floor((i % width) / ratio);
      const y = Math.floor(Math.floor(i / width) / ratio);
      const at = (y * data.width + x) * data.channels;
      const gray = data.channels <= 2;
      const sample = (channel: number) => {
        if (data.depth >= 8) return data.data[at + channel] ?? 0;
        const stride = Math.ceil((data.width * data.depth) / 8);
        const byte = data.data[y * stride + Math.floor((x * data.depth) / 8)] ?? 0;
        return (byte >>> (8 - data.depth - ((x * data.depth) % 8))) & ((1 << data.depth) - 1);
      };
      if (png.palette) {
        const colour = png.palette[sample(0)];
        if (!colour) throw new Error('invalid PNG palette index');
        rgba.set([colour[0] ?? 0, colour[1] ?? 0, colour[2] ?? 0, colour[3] ?? 255], i * 4);
        continue;
      }
      rgba[i * 4] = Math.round(sample(0) / scale);
      rgba[i * 4 + 1] = Math.round(sample(gray ? 0 : 1) / scale);
      rgba[i * 4 + 2] = Math.round(sample(gray ? 0 : 2) / scale);
      rgba[i * 4 + 3] =
        data.channels === 2 || data.channels === 4
          ? Math.round((data.data[at + data.channels - 1] ?? 0) / scale)
          : 255;
      if (
        data.transparency &&
        !png.palette &&
        (gray
          ? sample(0) === data.transparency[0]
          : sample(0) === data.transparency[0] &&
            sample(1) === data.transparency[1] &&
            sample(2) === data.transparency[2])
      )
        rgba[i * 4 + 3] = 0;
    }
    decoded = { width, height, data: rgba };
  } else
    decoded = jpeg.decode(bytes, {
      useTArray: true,
      maxResolutionInMP: 40,
      maxMemoryUsageInMB: 64,
      tolerantDecoding: false,
    });
  const scale = Math.min(1, 640 / decoded.width, 480 / decoded.height);
  const width = Math.max(1, Math.floor(decoded.width * scale));
  const height = Math.max(1, Math.floor(decoded.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (Math.floor(y / scale) * decoded.width + Math.floor(x / scale)) * 4;
      data.set(decoded.data.subarray(at, at + 4), (y * width + x) * 4);
    }
  parentPort?.postMessage({ raster: { width, height, data } }, [data.buffer]);
} catch (err) {
  const error = err as Error;
  parentPort?.postMessage({
    error: error.message,
    limit: error.message.includes('decode budget') || error.message.includes('maxMemoryUsage'),
  });
}
