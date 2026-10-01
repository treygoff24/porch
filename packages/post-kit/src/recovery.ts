import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, type Stats } from 'node:fs';
import { boundedRead, component, privateFile } from './safe-fs.ts';
import { bodyBytes } from './signing.ts';
import { type DirHandle, isCode } from './stores/dirfd.ts';
import { type DraftIdentity, DraftSpace, writeAll } from './stores/drafts.ts';

export const MAX_RECOVERY_TEXT_BYTES = 1048576;
export const MAX_RECOVERY_RECORD_BYTES = 6 * MAX_RECOVERY_TEXT_BYTES + 16384;
export const MAX_RECOVERY_RECORDS = 256;
export const MAX_RECOVERY_LIST_BYTES = 32 * 1024 * 1024;
export type RecoveryRecord = { id: string; channel: string; text: string; reply_to: string | null };

/** safe-fs's `privateFile`, with the link count allowed to be any of `links`, from one fstat. */
function privateLinks(fd: number, links: readonly number[]): Stats {
  const st = fstatSync(fd);
  if (
    !st.isFile() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o077) !== 0 ||
    !links.includes(st.nlink)
  )
    throw new Error('state must be an owner-only regular file with safe links');
  return st;
}

/** Python json.dumps separators and ASCII escaping, including UTF-16 surrogate pairs. */
export function pythonJson(value: unknown, ascii = false): string {
  function serialize(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(serialize).join(', ')}]`;
    if (typeof v === 'object' && v !== null)
      return `{${Object.entries(v)
        .map(([k, val]) => `${JSON.stringify(k)}: ${serialize(val)}`)
        .join(', ')}}`;
    return JSON.stringify(v) as string;
  }
  const text = serialize(value);
  return ascii
    ? text.replace(
        /[\u007f-\uffff]/g,
        (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
    : text;
}

/**
 * Recovery evidence is immutable; restore returns words and never invokes Post.
 *
 * Records live in the drafts directory under the drafts lock, as porch-tui keeps them, and go
 * through a {@link DraftSpace}: its in-process queue, its read-only refusal (no `flock`, or no
 * `/proc/self/fd`), and its held-directory operations. Give it the same `DraftSpace` the drafts
 * store uses, so a send never waits on a lock this process already holds; built from an identity
 * it gets a space of its own, which still excludes other processes but not this one's drafts store.
 * Read-only, it lists and restores without the lock (records are published whole by link) and
 * refuses to record or remove.
 */
export class SendRecord {
  readonly space: DraftSpace;
  readonly directory: string;
  readonly namespace: string;
  private readonly prefix: string;
  constructor(
    space: DraftSpace | DraftIdentity,
    private readonly makeId = () =>
      `${(BigInt(Date.now()) * 1000000n + (process.hrtime.bigint() % 1000000n)).toString().padStart(20, '0')}-${randomBytes(16).toString('hex')}`,
  ) {
    this.space = space instanceof DraftSpace ? space : new DraftSpace(space);
    this.namespace = this.space.namespace;
    this.directory = this.space.directory;
    this.prefix = `${this.namespace}.recovery.`;
  }
  /** Why records cannot be written or removed, or `null` when they can. */
  get readOnlyReason(): string | null {
    return this.space.readOnlyReason;
  }
  private name(id: string): string {
    if (!/^[0-9]{20}-[0-9a-f]{32}$/.test(id)) throw new Error('invalid recovery record ID');
    return `${this.prefix}${id}.json`;
  }
  private validate(v: unknown, id: string): RecoveryRecord {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      throw new Error('invalid recovery record; existing file kept');
    const r = v as Record<string, unknown>;
    if (
      Object.keys(r).sort().join(',') !== 'channel,id,reply_to,text' ||
      r.id !== id ||
      typeof r.channel !== 'string' ||
      typeof r.text !== 'string'
    )
      throw new Error('invalid recovery record; existing file kept');
    component(r.channel);
    if (r.reply_to !== null) {
      if (typeof r.reply_to !== 'string') throw new Error('invalid recovery reply');
      component(r.reply_to);
    }
    if (bodyBytes(r.text).length > MAX_RECOVERY_TEXT_BYTES)
      throw new Error('recovery text exceeds 1 MiB limit');
    return { id, channel: r.channel, text: r.text, reply_to: r.reply_to as string | null };
  }
  private read(
    dir: DirHandle,
    id: string,
  ): { record: RecoveryRecord; size: number; staged: boolean } {
    const name = this.name(id);
    const fd = dir.open(name, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      // One link, or two while the staging sibling (the same inode) still exists. Read without the
      // lock, a writer may unlink staging at any moment, taking two links to one; that transition is
      // accepted, and a link staging does not explain never is.
      const info = privateLinks(fd, [1, 2]);
      let staged = false;
      if (info.nlink === 2) {
        let sibling: number | null = null;
        try {
          sibling = dir.open(`.${name}.tmp`, constants.O_RDONLY | constants.O_NONBLOCK);
        } catch (err) {
          if (!isCode(err, 'ENOENT')) throw err;
        }
        if (sibling === null) privateLinks(fd, [1]);
        else {
          try {
            const st = privateLinks(sibling, [1, 2]);
            if (st.ino !== info.ino || st.dev !== info.dev)
              throw new Error('recovery staging file does not match record');
            staged = privateLinks(fd, [1, 2]).nlink === 2;
          } finally {
            closeSync(sibling);
          }
        }
      }
      const raw = boundedRead(fd, MAX_RECOVERY_RECORD_BYTES);
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw),
      );
      return { record: this.validate(value, id), size: raw.length, staged };
    } finally {
      closeSync(fd);
    }
  }
  private listHeld(dir: DirHandle): { records: RecoveryRecord[]; size: number } {
    const names = dir
      .list()
      .filter((name) => name.startsWith(this.prefix) && name.endsWith('.json'))
      .sort()
      .reverse();
    if (names.length > MAX_RECOVERY_RECORDS)
      throw new Error('too many recovery records; existing records kept');
    let size = 0;
    const records: RecoveryRecord[] = [];
    for (const name of names) {
      let item: ReturnType<SendRecord['read']>;
      try {
        item = this.read(dir, name.slice(this.prefix.length, -5));
      } catch (err) {
        // Only an unlocked (read-only) listing can see a record removed after the directory read.
        if (isCode(err, 'ENOENT')) continue;
        throw err;
      }
      size += item.size;
      if (size > MAX_RECOVERY_LIST_BYTES)
        throw new Error('recovery list exceeds memory limit; existing records kept');
      records.push(item.record);
    }
    return { records, size };
  }
  /**
   * Run a read under the drafts lock, or, when the space is read-only, against the held directory
   * without it (creating nothing; a missing directory is `missing()`).
   */
  private async reading<T>(action: (dir: DirHandle) => T, missing: () => T): Promise<T> {
    if (this.space.readOnlyReason === null) return this.space.locked(action);
    let dir: DirHandle;
    try {
      dir = this.space.openDirectory(false);
    } catch (err) {
      if (isCode(err, 'ENOENT')) return missing();
      throw err;
    }
    try {
      return action(dir);
    } finally {
      dir.close();
    }
  }
  async record(
    channel: string,
    text: string,
    opts: { replyTo?: string; reply_to?: string | null } = {},
  ): Promise<string> {
    const id = this.makeId();
    const value = this.validate(
      { id, channel, text, reply_to: opts.replyTo ?? opts.reply_to ?? null },
      id,
    );
    const payload = Buffer.from(`${pythonJson(value)}\n`);
    if (payload.length > MAX_RECOVERY_RECORD_BYTES)
      throw new Error('recovery record exceeds size limit');
    const name = this.name(id);
    await this.space.locked((dir) => {
      const existing = this.listHeld(dir);
      if (
        existing.records.length + 1 > MAX_RECOVERY_RECORDS ||
        existing.size + payload.length > MAX_RECOVERY_LIST_BYTES
      )
        throw new Error('recovery capacity reached; existing records kept');
      const temporary = `.${name}.tmp`;
      const fd = dir.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK,
        0o600,
      );
      try {
        try {
          privateFile(fd);
          writeAll(fd, payload);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        dir.link(temporary, name);
      } finally {
        dir.unlink(temporary);
      }
      dir.fsync();
    });
    return id;
  }
  async list(channel?: string): Promise<RecoveryRecord[]> {
    if (channel !== undefined) component(channel);
    return this.reading(
      (dir) =>
        this.listHeld(dir).records.filter((r) => channel === undefined || r.channel === channel),
      () => [],
    );
  }
  async restore(id: string): Promise<RecoveryRecord> {
    return this.reading(
      (dir) => this.read(dir, id).record,
      () => {
        throw Object.assign(new Error('no such recovery record'), { code: 'ENOENT' });
      },
    );
  }
  async remove(id: string): Promise<void> {
    await this.space.locked((dir) => {
      let read: ReturnType<SendRecord['read']>;
      try {
        read = this.read(dir, id);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      const name = this.name(id);
      if (read.staged) dir.unlink(`.${name}.tmp`);
      dir.unlink(name);
      dir.fsync();
    });
  }
}
export { SendRecord as RecoveryStore };
