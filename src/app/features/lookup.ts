import { closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  boundedRead,
  parseRaw,
  type RawRecord,
  SafeDirectory,
  safeArgument,
} from '@estate/post-kit';

const RESERVED = new Set([
  'archive',
  'rooms.json',
  'rules.json',
  'profiles.json',
  'owner.json',
  '.rooms.lock',
]);
/** Exact actor lookup includes archived and unlisted channels, with unique ids and held bytes. */
export async function decisionActor(mailRoot: string, id: string): Promise<RawRecord | undefined> {
  safeArgument(id);
  const channels = await SafeDirectory.open(join(mailRoot, 'channels'));
  try {
    const names = channels.names().filter((name) => !RESERVED.has(name));
    if (names.length > 4096) throw new Error('too many channels for decision verification');
    let found: RawRecord | undefined;
    for (const name of names) {
      const entry = channels.open(name);
      let directory: boolean;
      try {
        directory = fstatSync(entry).isDirectory();
      } finally {
        closeSync(entry);
      }
      if (!directory) continue;
      let messages: SafeDirectory;
      try {
        messages = await SafeDirectory.open(join(mailRoot, 'channels', name, 'messages'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      try {
        let fd: number;
        try {
          fd = messages.open(`${id}.msg`);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        let bytes: Buffer;
        try {
          bytes = boundedRead(fd, 4 * 1024 * 1024);
        } finally {
          closeSync(fd);
        }
        if (found) throw new Error('duplicate decision actor id');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        const split = text.indexOf('\n---\n');
        if (split < 0) throw new Error('invalid decision actor');
        const raw = parseRaw(JSON.parse(text.slice(0, split)), name, {
          file: 'msg',
          body: text.slice(split + 5),
          bodyComplete: true,
        });
        if (!raw || raw.id !== id) throw new Error('invalid decision actor');
        found = raw;
      } finally {
        messages.close();
      }
    }
    return found;
  } finally {
    channels.close();
  }
}
