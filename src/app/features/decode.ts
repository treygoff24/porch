import { Worker } from 'node:worker_threads';
import type { Raster } from './images.ts';

export const DECODE_TIMEOUT_MS = 3000;
let active = 0;
const waiting: Array<() => void> = [];
/** Only bounded, downsized pixels cross back into the UI process. */
export async function decodeInWorker(bytes: Buffer, format: string): Promise<Raster | string> {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    const input = Uint8Array.from(bytes);
    const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), {
      workerData: { bytes: input, format },
      transferList: [input.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    try {
      return await new Promise<Raster | string>((resolve, reject) => {
        const placeholder = `${format.toUpperCase()} preview unavailable · decode limit`;
        const timer = setTimeout(() => resolve(placeholder), DECODE_TIMEOUT_MS);
        const finish = () => clearTimeout(timer);
        worker.once('message', (result: { raster?: Raster; error?: string; limit?: boolean }) => {
          finish();
          if (result.raster) resolve(result.raster);
          else if (result.limit) resolve(placeholder);
          else reject(new Error(result.error ?? 'image decoder failed'));
        });
        worker.once('error', (err: NodeJS.ErrnoException) => {
          finish();
          if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') resolve(placeholder);
          else reject(err);
        });
        worker.once('exit', (code) => {
          finish();
          if (code !== 0) resolve(placeholder);
          else reject(new Error('image decoder exited without pixels'));
        });
      });
    } finally {
      await worker.terminate();
    }
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
