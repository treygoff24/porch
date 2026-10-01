/**
 * Imported first by `src/main.ts` (ported from `~/Code/loom/src/tui/production-env.ts`). Run from
 * source, nothing sets NODE_ENV, and a library that picks its build by it loads the development
 * one; in Loom that was React, whose development build leaked a `performance.measure` entry per
 * render until the heap ran out. Porch has no React, but OpenTUI and anything it loads read
 * NODE_ENV too, so the terminal client runs as production unless the person set a value.
 *
 * What this sets is not passed on to child processes (`childEnv` in `node-env.ts`).
 */
import { DEFAULTED, productionDefault } from './node-env.ts';

const env = productionDefault(process.env);
if (env[DEFAULTED] !== undefined) {
  process.env.NODE_ENV = 'production';
  process.env[DEFAULTED] = '1';
}
