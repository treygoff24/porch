import '../src/host/production-env.ts';
import '../src/host/ffi-warning.ts';
import { writeFileSync } from 'node:fs';

const { runScene } = await import('../src/host/run.ts');
const { probeScene } = await import('./scene.ts');
const probe = probeScene({
  blinks: !process.argv.includes('--no-blinks'),
  ...(process.env.PORCH_PROBE_FRAME_MS
    ? { frameMs: Number(process.env.PORCH_PROBE_FRAME_MS) }
    : {}),
  ...(process.env.PORCH_PROBE_SHEET ? { sheet: process.env.PORCH_PROBE_SHEET } : {}),
  ...(process.env.PORCH_MOTION ? { motion: process.env.PORCH_MOTION } : {}),
});
const status = () => {
  if (process.env.PORCH_GRID_DUMP)
    writeFileSync(`${process.env.PORCH_GRID_DUMP}.state`, JSON.stringify(probe.status()));
};
process.on('SIGUSR2', status);
try {
  process.exitCode = await runScene(probe.scene);
} finally {
  process.off('SIGUSR2', status);
  probe.dispose();
}
