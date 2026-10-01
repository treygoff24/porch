import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnerAnchor } from './owner.ts';
import { withoutCredentials } from './owner.ts';
import type { RawRecord, Verdict } from './records.ts';
import { hasSignatureClaim, isRecord } from './records.ts';
import { runProcess } from './run.ts';
import { readSafeFile } from './safe-fs.ts';
import {
  bodyBytes,
  MAX_SIGNED_BODY_BYTES,
  manifestBytes,
  type Runner,
  validateTag,
} from './signing.ts';

const failed = (reason: string): Verdict => ({ state: 'failed', reason });
const unknown = (reason: string): Verdict => ({ state: 'unknown', reason });

/** post's signed_verified is intentionally ignored. Only held raw bytes can carry authority. */
export async function verify(
  raw: RawRecord,
  anchor: OwnerAnchor,
  opts: { run?: Runner; env?: NodeJS.ProcessEnv } = {},
): Promise<Verdict> {
  if (!hasSignatureClaim(raw, anchor)) return { state: 'unsigned', reason: 'no signature claimed' };
  if (anchor.signingBlocked) return unknown(`owner-anchor disagreement: ${anchor.signingBlocked}`);
  if (raw.from !== anchor.ownerRoom) return failed('message sender is not the configured owner');
  if (raw.channel !== raw.storageChannel)
    return failed('envelope channel differs from storage channel');
  let tag: string;
  let v1Text: string | undefined;
  if (raw.signature.present) {
    const locator = raw.signature.raw;
    if (
      !isRecord(locator) ||
      Object.keys(locator).length !== 2 ||
      locator.version !== 2 ||
      typeof locator.tag !== 'string'
    )
      return failed('malformed signature_ref');
    tag = locator.tag;
    try {
      validateTag(tag);
    } catch {
      return failed('malformed signature_ref');
    }
  } else {
    if (!raw.bodyComplete) return unknown('body is incomplete');
    const line = raw.body.endsWith('\n') ? raw.body.slice(0, -1) : raw.body;
    const tags = [...line.matchAll(/\[signed:([0-9A-Za-z-]+)\]/g)];
    if (tags.length !== 1 || /[\r\n]/.test(line) || !line.startsWith(`${anchor.marker}🔏 `))
      return failed('malformed v1 wire');
    tag = tags[0]?.[1] ?? '';
    const suffix = ` [signed:${tag}]`;
    if (!line.endsWith(suffix) || line.split('[signed:').length !== 2)
      return failed('malformed v1 wire');
    v1Text = line.slice(`${anchor.marker}🔏 `.length, -suffix.length);
  }
  if (!raw.bodyComplete) return unknown('body is incomplete');
  let expected: Buffer;
  try {
    if (bodyBytes(raw.body).length > MAX_SIGNED_BODY_BYTES)
      return failed('body exceeds signed size limit');
    expected = manifestBytes(tag, raw.channel, raw.body);
  } catch {
    return failed('body or binding is invalid');
  }
  let payload: Buffer;
  let signature: Buffer;
  let signers: Buffer;
  try {
    payload = await readSafeFile(
      join(anchor.sidecarDir, 'sigs', `${tag}.txt`),
      MAX_SIGNED_BODY_BYTES,
    );
    signature = await readSafeFile(join(anchor.sidecarDir, 'sigs', `${tag}.txt.sig`), 65536);
    signers = await readSafeFile(anchor.allowedSigners, MAX_SIGNED_BODY_BYTES);
  } catch {
    return unknown('signature evidence is missing, unreadable or unsafe');
  }
  if (v1Text !== undefined) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
    } catch {
      return failed('v1 payload is not UTF-8');
    }
    const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
    if (text.includes('\r') || lines.length !== 2 || lines[0] !== tag || lines[1] !== v1Text)
      return failed('v1 payload differs from message');
  } else if (!payload.equals(expected)) return failed('signed v2 manifest differs from message');
  const temp = mkdtempSync(join(tmpdir(), 'porch-verify-'));
  try {
    const sig = join(temp, 'signature');
    const allowed = join(temp, 'allowed_signers');
    writeFileSync(sig, signature, { mode: 0o600 });
    writeFileSync(allowed, signers, { mode: 0o600 });
    const out = await (opts.run ?? runProcess)('ssh-keygen', {
      args: [
        '-Y',
        'verify',
        '-f',
        allowed,
        '-I',
        anchor.principal,
        '-n',
        anchor.namespace,
        '-s',
        sig,
      ],
      input: payload.toString('utf8'),
      env: withoutCredentials(opts.env ?? process.env),
      timeoutMs: 10000,
    });
    if (out.failed !== undefined || out.code === null)
      return unknown('ssh-keygen unavailable or did not finish');
    return out.code === 0
      ? { state: 'verified', reason: 'signature and body binding verify' }
      : failed('signature does not verify');
  } catch {
    return unknown('verification environment failed');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
