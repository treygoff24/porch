/**
 * Line prompts on the terminal before the screen starts: the arm question and the passphrase
 * (hidden), and `porch-next init`'s questions. Each prompt can be cancelled (a signal arriving while
 * it waits), which answers null, and each leaves stdin paused and out of raw mode. A paused stream
 * stays paused when a new reader is added, so whoever reads stdin next must resume it (boot does,
 * just before the screen starts).
 */

export type Prompter = {
  /** Ask one question; the answer without its newline, or null when cancelled or at EOF. */
  ask(question: string): Promise<string | null>;
  /** The same without echoing what is typed. */
  askHidden(question: string): Promise<string | null>;
  /** Answer whatever prompt is waiting with null. */
  cancel(): void;
};

export function terminalPrompter(
  stdin: NodeJS.ReadStream = process.stdin,
  out: NodeJS.WritableStream = process.stderr,
): Prompter {
  let pending: ((answer: string | null) => void) | undefined;
  const read = (question: string, hidden: boolean) =>
    new Promise<string | null>((resolve) => {
      out.write(question);
      const raw = stdin.isTTY === true;
      if (raw) stdin.setRawMode(true);
      let line = '';
      const done = (answer: string | null) => {
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        if (raw) stdin.setRawMode(false);
        stdin.pause();
        pending = undefined;
        out.write('\n');
        resolve(answer);
      };
      const onEnd = () => done(null);
      const onData = (chunk: Buffer | string) => {
        for (const ch of String(chunk)) {
          if (ch === '\r' || ch === '\n') return done(line);
          if (ch === '\x03' || ch === '\x04') return done(null);
          if (ch === '\x7f' || ch === '\b') {
            if (line.length > 0) {
              line = [...line].slice(0, -1).join('');
              if (!hidden) out.write('\b \b');
            }
            continue;
          }
          // biome-ignore lint/suspicious/noControlCharactersInRegex: controls are not typed text
          if (/[\u0000-\u001f\u007f]/.test(ch)) continue;
          line += ch;
          if (!hidden) out.write(ch);
        }
      };
      pending = done;
      stdin.on('data', onData);
      stdin.once('end', onEnd);
      stdin.resume();
    });
  return {
    ask: (q) => read(q, false),
    askHidden: (q) => read(q, true),
    cancel: () => pending?.(null),
  };
}
