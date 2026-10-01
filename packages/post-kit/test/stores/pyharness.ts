/**
 * Run Python for the compatibility tests: plain `python3` for standard-library differentials, and
 * porch-tui's own virtualenv (`~/Code/porch-tui`, override with `PORCH_TUI_DIR`) for round trips
 * through its real stores. Every call gets its inputs through a JSON file or argv and its own
 * temporary directories; nothing here reads Trey's config, drafts, keys or mail.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const python3 = spawnSync('python3', ['--version']).status === 0;

export const porchTuiDir = process.env.PORCH_TUI_DIR ?? join(homedir(), 'Code', 'porch-tui');
const venvPython = join(porchTuiDir, '.venv', 'bin', 'python');
/** porch-tui's interpreter with its package importable, or null when porch-tui is absent. */
export const porchPython = existsSync(join(porchTuiDir, 'src', 'porch3', 'drafts.py'))
  ? existsSync(venvPython)
    ? venvPython
    : null
  : null;

const made: string[] = [];
export function tempDir(prefix = 'porch-t3b-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
export function cleanTemps(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export type PyRun = { status: number | null; stdout: string; stderr: string };

/** A Python environment that cannot see the caller's porch config or real mail root. */
function pyEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.PORCH_CONFIG;
  env.PYTHONPATH = join(porchTuiDir, 'src');
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONIOENCODING = 'utf-8';
  return { ...env, ...extra };
}

/** Run `code` with `input` (JSON) available as the variable `INPUT`; returns stdout. */
export function runPy(
  code: string,
  input: unknown = null,
  options: { porch?: boolean; env?: Record<string, string> } = {},
): PyRun {
  const dir = tempDir('porch-t3b-py-');
  const inputPath = join(dir, 'input.json');
  writeFileSync(inputPath, JSON.stringify(input));
  const prelude = `import json, sys\nINPUT = json.load(open(${JSON.stringify(inputPath)}, encoding='utf-8'))\n`;
  const program = options.porch ? (porchPython as string) : 'python3';
  const r = spawnSync(program, ['-c', prelude + code], {
    env: pyEnv(options.env ?? {}),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `runPy`, failing loudly on a nonzero exit, and parsing stdout as JSON. */
export function pyJson<T = unknown>(
  code: string,
  input: unknown = null,
  options: { porch?: boolean; env?: Record<string, string> } = {},
): T {
  const r = runPy(code, input, options);
  if (r.status !== 0) throw new Error(`python failed (${r.status}):\n${r.stderr}`);
  return JSON.parse(r.stdout) as T;
}

/**
 * Start a long-running Python process; resolves once it prints its first line (its "ready"
 * signal). The caller ends it by writing a line to stdin.
 */
export async function startPy(
  code: string,
  options: { porch?: boolean; env?: Record<string, string> } = {},
): Promise<{ ready: string; finish: () => Promise<PyRun> }> {
  const program = options.porch ? (porchPython as string) : 'python3';
  const child = spawn(program, ['-u', '-c', code], {
    env: pyEnv(options.env ?? {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (b: Buffer) => {
    stderr += b.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  const ready = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`python never became ready:\n${stderr}`)),
      30_000,
    );
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
      const nl = stdout.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        resolve(stdout.slice(0, nl));
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      reject(new Error(`python exited before ready:\n${stderr}`));
    });
  });
  return {
    ready,
    finish: async () => {
      child.stdin.end('go\n');
      const status = await exited;
      return { status, stdout, stderr };
    },
  };
}
