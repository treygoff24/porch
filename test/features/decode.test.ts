import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeInWorker } from '../../src/app/features/decode.ts';

const { workers, construct } = vi.hoisted(() => ({
  workers: [] as Array<{
    emit: (event: string, value: unknown) => boolean;
    terminate: ReturnType<typeof vi.fn>;
  }>,
  construct: vi.fn(),
}));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 1);
    constructor(...args: unknown[]) {
      super();
      construct(...args);
      workers.push(this);
    }
  },
}));
afterEach(() => {
  vi.useRealTimers();
  workers.length = 0;
  construct.mockClear();
});

it('terminates a stalled worker after three seconds and renders a labelled limit placeholder', async () => {
  vi.useFakeTimers();
  const decoded = decodeInWorker(Buffer.from('test'), 'png');
  expect(construct).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({
      resourceLimits: expect.objectContaining({ maxOldGenerationSizeMb: 64 }),
    }),
  );
  await vi.advanceTimersByTimeAsync(3000);
  expect(await decoded).toBe('PNG preview unavailable · decode limit');
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
});

it('turns worker heap exhaustion into a placeholder and terminates the worker', async () => {
  const decoded = decodeInWorker(Buffer.from('test'), 'jpeg');
  workers[0]?.emit(
    'error',
    Object.assign(new Error('worker heap exhausted'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }),
  );
  expect(await decoded).toBe('JPEG preview unavailable · decode limit');
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
});

it('admits at most two decoder workers and releases a queued preview after completion', async () => {
  const first = decodeInWorker(Buffer.from('one'), 'png');
  const second = decodeInWorker(Buffer.from('two'), 'png');
  const third = decodeInWorker(Buffer.from('three'), 'png');
  expect(construct).toHaveBeenCalledTimes(2);
  const pixels = { raster: { width: 1, height: 1, data: new Uint8Array(4) } };
  workers[0]?.emit('message', pixels);
  await first;
  await vi.waitFor(() => expect(construct).toHaveBeenCalledTimes(3));
  workers[1]?.emit('message', pixels);
  workers[2]?.emit('message', pixels);
  await Promise.all([second, third]);
  expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
});
