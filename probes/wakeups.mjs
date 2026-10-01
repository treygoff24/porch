// Diagnostic observer: counts real JS timer callbacks without scheduling a sampler.
// Native terminal output is captured at the pty, since FFI bypasses stdout.write.
import { createHook } from 'node:async_hooks';
import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const timers = new Map();
const sources = new Map();
let wakeups = 0;
// Observe the existing production render-pass dump, including passes with no bytes.
// The wrapper delegates the original write unchanged and only retains timestamps.
const passes = [];
const write = fs.writeFileSync;
fs.writeFileSync = function (file, data, ...options) {
  if (file === `${process.env.PORCH_GRID_DUMP}.tmp`) {
    passes.push({ at: Date.now() / 1000, pass: JSON.parse(String(data)).passes });
  }
  return write.call(this, file, data, ...options);
};
syncBuiltinESMExports();
createHook({
  init(id, type) {
    if (type === 'Timeout')
      timers.set(id, new Error().stack?.split('\n').slice(2, 9).join('\n') ?? type);
  },
  before(id) {
    const source = timers.get(id);
    if (source !== undefined) {
      wakeups++;
      sources.set(source, (sources.get(source) ?? 0) + 1);
    }
  },
  destroy(id) {
    timers.delete(id);
  },
}).enable();
process.on('SIGUSR2', () => {
  appendFileSync(
    process.env.PORCH_PROBE_WAKEUPS,
    `${JSON.stringify({ at: Date.now(), wakeups, liveTimers: timers.size, sources: Object.fromEntries(sources), passes })}\n`,
  );
});
