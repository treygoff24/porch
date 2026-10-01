/**
 * Vitest setup file (each test file, before its tests): name the running test in the environment,
 * so a tripwire stand-in (`tripwire.ts`) that a test reaches through PATH can say which test it was.
 * Ported from `~/Code/loom/test/setup/tripwire-context.ts`.
 */
import { relative } from 'node:path';
import { beforeEach, expect } from 'vitest';

beforeEach(() => {
  const { testPath, currentTestName } = expect.getState();
  const file = testPath === undefined ? 'unknown file' : relative(process.cwd(), testPath);
  process.env.PORCH_TEST_CONTEXT = `${file} > ${currentTestName ?? 'unknown test'}`;
});
