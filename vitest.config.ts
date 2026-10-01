import { defineConfig } from 'vitest/config';

// A run started inside a herdr pane inherits the pane's variables; no test may reach that pane.
const herdrNames = new Set([
  'HERDR_ENV',
  'HERDR_SOCKET_PATH',
  'HERDR_PANE_ID',
  'HERDR_BIN_PATH',
  'HERDR_TAB_ID',
  'HERDR_WORKSPACE_ID',
  ...Object.keys(process.env).filter((name) => name.startsWith('HERDR_')),
]);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    globalSetup: [
      // A throwaway post store for the whole run; never ~/.claude-mail.
      'test/setup/post-isolation.ts',
      // Last, so the setup above ran programs by its own PATH: tripwire stand-ins for `post` and
      // `herdr` go in front of it, and a run in which a test reached one fails.
      'test/setup/tripwire.ts',
    ],
    // The FFI silencer first, before a test file loads OpenTUI, as `src/main.ts` does.
    setupFiles: ['src/host/ffi-warning.ts', 'test/setup/tripwire-context.ts'],
    // Porch shows times in Trey's local zone; fixtures pin the zone so a run reads the same on any
    // machine. A test about another zone sets process.env.TZ itself and restores it.
    env: { ...Object.fromEntries([...herdrNames].map((name) => [name, ''])), TZ: 'UTC' },
  },
});
