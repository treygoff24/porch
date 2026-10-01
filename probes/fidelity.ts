import { readFileSync, writeFileSync } from 'node:fs';
import xterm from '@xterm/headless';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node --import tsx probes/fidelity.ts RUN_DIR');
const result = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8')) as {
  sheet: {
    cols: number;
    rows: number;
    cells: { x: number; y: number; ch: string; fg: string; bg: string }[];
  };
  sheetAnsi: string;
};
// A few extra rows prevent the snapshot's last newline from scrolling the sheet.
const terminal = new xterm.Terminal({
  cols: result.sheet.cols,
  rows: result.sheet.rows + 5,
  allowProposedApi: true,
});
await new Promise<void>((resolve) =>
  terminal.write(result.sheetAnsi.replace(/\r?\n/g, '\r\n'), resolve),
);
const mismatches = [];
for (const expected of result.sheet.cells) {
  const cell = terminal.buffer.active.getLine(expected.y)?.getCell(expected.x);
  const actual = {
    ch: cell?.getChars(),
    fg: cell?.getFgColor(),
    bg: cell?.getBgColor(),
    fgRGB: cell?.isFgRGB(),
    bgRGB: cell?.isBgRGB(),
  };
  if (
    actual.ch !== expected.ch ||
    actual.fg !== Number.parseInt(expected.fg.slice(1), 16) ||
    actual.bg !== Number.parseInt(expected.bg.slice(1), 16) ||
    !actual.fgRGB ||
    !actual.bgRGB
  ) {
    mismatches.push({ expected, actual });
  }
}
terminal.dispose();
const checked = {
  sampled: result.sheet.cells.length,
  matched: result.sheet.cells.length - mismatches.length,
  mismatches,
};
writeFileSync(`${dir}/fidelity.json`, JSON.stringify(checked, null, 2));
console.log(JSON.stringify({ sampled: checked.sampled, matched: checked.matched }));
if (mismatches.length > 0 || checked.sampled !== 256) process.exitCode = 1;
