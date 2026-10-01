// Ported from ~/Code/loom/src/tui/node-env.ts (c0c4b75); the mark is renamed for Porch.
/**
 * What the terminal clients do about NODE_ENV (`production-env.ts` makes the change; this is the
 * part with no side effects, so anything may import it). A client that defaults NODE_ENV to
 * production so React loads its production build marks that it did, and a child process it starts
 * (serve, and through serve the agent's shell) gets the environment without the made-up value: a
 * test runner or build tool under `production` would behave differently from the person's shell.
 */

/** Set beside a NODE_ENV the client defaulted itself. */
export const DEFAULTED = 'PORCH_NODE_ENV_DEFAULTED';

/** `env` with NODE_ENV defaulted to production when the person set none, and the mark that says so. */
export function productionDefault(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NODE_ENV !== undefined) return env;
  return { ...env, NODE_ENV: 'production', [DEFAULTED]: '1' };
}

/** The environment for a child process: without a NODE_ENV the client made up, and without the mark. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env[DEFAULTED] === undefined) return env;
  const { NODE_ENV: _made, [DEFAULTED]: _mark, ...rest } = env;
  return rest;
}
