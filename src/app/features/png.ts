import { crc32, inflateSync } from 'node:zlib';

/** Bound decompression before the JS decoder allocates, and omit ancillary metadata it need not inflate. */
export function boundedPng(bytes: Buffer): Buffer {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depth = bytes[24] ?? 0;
  const color = bytes[25] ?? 255;
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
  ]).get(color);
  if (
    !channels ||
    ![1, 2, 4, 8, 16].includes(depth) ||
    (color !== 0 && color !== 3 && depth < 8) ||
    (color === 3 && depth === 16)
  )
    throw new Error('invalid PNG depth or colour type');
  const interlace = bytes[28];
  if (interlace !== 0 && interlace !== 1) throw new Error('invalid PNG interlace');
  const scanSize = (w: number, h: number) =>
    w > 0 && h > 0 ? (Math.ceil((w * channels * depth) / 8) + 1) * h : 0;
  let inflatedBytes = scanSize(width, height);
  if (interlace === 1) {
    const passes = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ];
    inflatedBytes = passes.reduce(
      (sum, [x, y, dx, dy]) =>
        sum +
        scanSize(
          Math.max(0, Math.ceil((width - (x ?? 0)) / (dx ?? 1))),
          Math.max(0, Math.ceil((height - (y ?? 0)) / (dy ?? 1))),
        ),
      0,
    );
  }
  const kept = [bytes.subarray(0, 8)];
  // Typed-array storage is outside V8's resourceLimits: cap this second budget too.
  // Large valid PNGs may be sent, but receive a labelled limited preview.
  if (inflatedBytes > 32 * 1024 * 1024) throw new Error('PNG exceeds decode budget');
  const data: Buffer[] = [];
  let header = false;
  let end = false;
  for (let offset = 8; offset < bytes.length; ) {
    if (offset + 12 > bytes.length) throw new Error('truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const next = offset + 12 + length;
    if (next > bytes.length) throw new Error('truncated PNG chunk');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4))
      throw new Error('invalid PNG checksum');
    if (kind === 'IHDR') {
      if (header || offset !== 8 || length !== 13)
        throw new Error('duplicate or invalid PNG header');
      header = true;
    }
    if (kind === 'PLTE' && (length > 768 || length % 3 !== 0))
      throw new Error('invalid PNG palette');
    if (kind === 'tRNS' && length > 256) throw new Error('invalid PNG transparency');
    if (kind === 'IDAT') data.push(bytes.subarray(offset + 8, next - 4));
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(kind))
      kept.push(bytes.subarray(offset, next));
    else if (kind[0] && kind[0] === kind[0].toUpperCase())
      throw new Error('unsupported critical PNG chunk');
    offset = next;
    if (kind === 'IEND') {
      if (length !== 0 || offset !== bytes.length) throw new Error('invalid PNG end');
      end = true;
      break;
    }
  }
  if (!header || !end || !data.length) throw new Error('incomplete PNG');
  const inflated = inflateSync(Buffer.concat(data), { maxOutputLength: inflatedBytes });
  if (inflated.length !== inflatedBytes) throw new Error('PNG data does not match dimensions');
  return Buffer.concat(kept);
}
