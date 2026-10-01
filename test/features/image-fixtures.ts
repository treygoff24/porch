import { once } from 'node:events';
import { crc32, createDeflate } from 'node:zlib';

export function chunk(kind: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(kind, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
/** Compress zeros incrementally: the fixture builder never allocates the expanded bomb. */
export async function compressedPng(
  width: number,
  height: number,
  expanded?: number,
): Promise<Buffer> {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const deflater = createDeflate({ level: 9 });
  const pieces: Buffer[] = [];
  deflater.on('data', (data: Buffer) => pieces.push(data));
  const done = once(deflater, 'end');
  const block = Buffer.alloc(64 * 1024);
  for (let left = expanded ?? (width * 4 + 1) * height; left > 0; left -= block.length)
    if (!deflater.write(block.subarray(0, Math.min(left, block.length))))
      await once(deflater, 'drain');
  deflater.end();
  await done;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.concat(pieces)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
