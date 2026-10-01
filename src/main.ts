/**
 * Porch's entry point, run from source by `bin/porch-next` through the tsx loader. The first two
 * imports are side effects that must happen before anything loads OpenTUI: NODE_ENV defaults to
 * production, and Node's FFI warning is silenced (Loom recon §1, "How Node runs with FFI"). The
 * rest is imported dynamically after them.
 *
 *   porch-next [channel] [--no-sign]   the app, on `channel` if Trey has joined it
 *   porch-next init [flags]            write Porch's config and set post's owner (post-kit's init)
 *   porch-next avatar <list|preview|set>   pick an avatar from premade characters (one command)
 *   porch-next --demo                  the renderer demo
 */
import './host/production-env.ts';
import './host/ffi-warning.ts';
import type { CliRendererConfig } from '@opentui/core';

const USAGE = `usage: porch-next [channel] [--no-sign]
       porch-next init [--help]
       porch-next avatar [list|preview|set] [--help]
       porch-next --demo
`;

/** Tests only: a renderer that takes this long to start, for the late-start pty check. */
function delayedRenderer() {
  const delay = Number(process.env.PORCH_START_DELAY_MS ?? 0);
  if (!(delay > 0)) return undefined;
  return async (config: CliRendererConfig) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const { createCliRenderer } = await import('@opentui/core');
    return createCliRenderer(config);
  };
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'init') return init(argv.slice(1));
  if (argv[0] === 'avatar') return avatar(argv.slice(1));
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const createRenderer = delayedRenderer();
  if (argv.includes('--demo')) {
    const { runScene } = await import('./host/run.ts');
    const { demoScene } = await import('./demo/demo-scene.ts');
    return runScene(
      demoScene({ motion: process.env.PORCH_MOTION }),
      createRenderer === undefined ? {} : { createRenderer },
    );
  }
  const positional = argv.filter((a) => !a.startsWith('-'));
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--no-sign');
  if (unknown.length > 0 || positional.length > 1) {
    process.stderr.write(
      `porch-next: unexpected ${[...unknown, ...positional.slice(1)].join(' ')}\n${USAGE}`,
    );
    return 2;
  }
  const channel = positional[0]?.replace(/^#/, '');
  const { boot } = await import('./app/boot.ts');
  return boot({
    channel,
    noSign: argv.includes('--no-sign'),
    ...(createRenderer === undefined ? {} : { createRenderer }),
  });
}

async function avatar(argv: string[]): Promise<number> {
  const { runAvatar } = await import('./app/avatar-cli.ts');
  return runAvatar(argv, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  });
}

async function init(argv: string[]): Promise<number> {
  const { runInit } = await import('@estate/post-kit');
  const { terminalPrompter } = await import('./app/tty.ts');
  const prompter = terminalPrompter(process.stdin, process.stdout);
  const answer = (a: string | null) => {
    if (a === null) throw new Error('cancelled');
    return a;
  };
  return runInit(argv, {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    isTty: process.stdin.isTTY === true,
    prompt: async (q) => answer(await prompter.ask(q)),
    promptHidden: async (q) => answer(await prompter.askHidden(q)),
    ...(process.env.PORCH_POST_BIN === undefined ? {} : { post: process.env.PORCH_POST_BIN }),
  });
}

process.exitCode = await main(process.argv.slice(2));
