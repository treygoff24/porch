/** Loom's typing-jank analysis: timestamp inputs, replay captured VT output,
 * and time the first frame showing each prefix. For mosh, use the client pty
 * after UDP transport, with prediction disabled. Pane-read RPCs are separate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import xterm from '@xterm/headless';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node --import tsx probes/typing.ts RUN_DIR');
const file = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return gunzipSync(readFileSync(`${path}.gz`)).toString('utf8');
  }
};
const percentile = (ms: number[], p: number) =>
  [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(ms.length * p))];
const results = JSON.parse(file(`${dir}/results.json`)) as { transport: string };
const mosh = results.transport.includes('mosh');
const out: Record<string, unknown> = {};
for (const [name, folder, timing] of [
  ['cat', 'cat', 'typing'],
  ['typing', 'scene', 'typing'],
  ['typingEmote', 'scene', 'typing-emote'],
]) {
  if (!name || !folder || !timing) continue;
  const metadata = JSON.parse(file(`${dir}/${folder}/pid.json`)) as { cols: number; rows: number };
  const capture = JSON.parse(file(`${dir}/${folder}/${timing}.json`)) as {
    sends: [number, string, number][];
    markers?: Record<string, string>;
  };
  const chunks = file(`${dir}/${folder}/${mosh ? 'client-chunks' : 'chunks'}.jsonl`)
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { at: number; data: string });
  const term = new xterm.Terminal({
    cols: metadata.cols,
    rows: metadata.rows,
    allowProposedApi: true,
  });
  const ms: number[] = [];
  const shown = new Set<number>();
  const prefixes = new Map<number, string>();
  const expected = capture.sends.map(([_, ch, repeat]) => {
    const text = (prefixes.get(repeat) ?? '') + ch;
    prefixes.set(repeat, text);
    return (
      (name === 'cat' ? (capture.markers?.[String(repeat)] ?? `BASE${repeat}: `) : 'ECHO: ') + text
    );
  });
  for (const chunk of chunks) {
    await new Promise<void>((resolve) => term.write(Buffer.from(chunk.data, 'base64'), resolve));
    const lines = Array.from(
      { length: term.rows },
      (_, y) =>
        term.buffer.active
          .getLine(term.buffer.active.viewportY + y)
          ?.translateToString(true)
          .trimStart() ?? '',
    );
    capture.sends.forEach(([at, _, repeat], i) => {
      if (shown.has(i) || chunk.at < at) return;
      const next = capture.sends.find(([__, ___, r]) => r > repeat)?.[0] ?? Infinity;
      if (chunk.at >= next) return;
      if (lines.some((line) => line.startsWith(expected[i] ?? '\0'))) {
        shown.add(i);
        ms.push((chunk.at - at) * 1000);
      }
    });
  }
  term.dispose();
  if (ms.length === 0 || ms.length !== capture.sends.length) process.exitCode = 1;
  out[name] = {
    n: ms.length,
    missed: capture.sends.length - ms.length,
    p50: percentile(ms, 0.5),
    p95: percentile(ms, 0.95),
    max: Math.max(...ms),
    ms,
  };
}
writeFileSync(`${dir}/typing-vt.json`, JSON.stringify(out, null, 2));
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(out).map(([k, v]) => {
        const { ms: _, ...stats } = v as Record<string, unknown>;
        return [k, stats];
      }),
    ),
    null,
    2,
  ),
);
