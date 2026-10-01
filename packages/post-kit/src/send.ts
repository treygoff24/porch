import type { OwnerIdentity } from './owner.ts';
import { displayText, isRecord, safeArgument } from './records.ts';
import type { SendRecord } from './recovery.ts';
import { decodeJson, type Outcome } from './run.ts';
import {
  bodyBytes,
  DEFAULT_BODY_BYTES,
  type PrivateAgent,
  type SignedSidecar,
  signV2,
} from './signing.ts';
import { type Crossed, parseCrossed } from './wire.ts';

export type SendRequest = {
  channel: string;
  body: string;
  replyTo?: string;
  mode: 'casual' | 'signed';
  draftRevision: number;
};
export type SendOutcome =
  | { kind: 'confirmed'; id: string; crossed?: Crossed }
  | { kind: 'committed'; code: string }
  | { kind: 'uncertain'; reason: string; recordId: string }
  | { kind: 'refused'; code: string; message: string };
export type Recovery = Pick<SendRecord, 'record' | 'remove'>;

export function classifySend(
  out: Outcome,
  channel: string,
  ownerRoom: string,
  recordId: string,
  emote = false,
): SendOutcome {
  if (out.failed === 'missing' || out.failed === 'spawn')
    return {
      kind: 'refused',
      code: 'send_failed',
      message: emote
        ? 'Post could not start; emote was not sent.'
        : 'Post could not start; draft kept.',
    };
  if (out.failed !== undefined)
    return {
      kind: 'uncertain',
      reason: emote
        ? `Emote delivery unknown (${out.failed}); check history before retrying.`
        : out.failed,
      recordId,
    };
  const data = decodeJson(out.stdout, out.stderr);
  if (
    out.code !== 0 &&
    out.code !== null &&
    data?.ok === false &&
    isRecord(data.error) &&
    typeof data.error.code === 'string'
  ) {
    const code = data.error.code;
    if (code === 'delivered_output_failure' || code === 'delivered_unarchived')
      return { kind: 'committed', code };
    return {
      kind: 'refused',
      code,
      message:
        typeof data.error.message === 'string'
          ? displayText(data.error.message)
          : 'Post refused the send.',
    };
  }
  const receipt = data?.message;
  if (
    out.code === 0 &&
    data?.ok === true &&
    isRecord(receipt) &&
    typeof receipt.id === 'string' &&
    receipt.id.length > 0 &&
    receipt.channel === channel &&
    (receipt.from === ownerRoom || (emote && receipt.from === undefined)) &&
    (!emote || receipt.event === 'emote')
  ) {
    const crossed = emote ? undefined : parseCrossed(data.crossed, channel);
    return { kind: 'confirmed', id: receipt.id, ...(crossed === undefined ? {} : { crossed }) };
  }
  return {
    kind: 'uncertain',
    reason: emote
      ? 'Post gave no valid emote receipt; check history before retrying.'
      : 'Post gave no valid receipt; check history before retrying.',
    recordId,
  };
}

export class SendTransaction {
  private inFlight = false;
  readonly ownMessageIds = new Set<string>();
  readonly notices: string[] = [];
  constructor(
    private readonly opts: {
      owner: OwnerIdentity;
      recovery: Recovery;
      post: (args: string[], input?: string) => Promise<Outcome>;
      agent?: PrivateAgent;
      sign?: (request: Readonly<SendRequest>) => Promise<SignedSidecar>;
      onConfirmed?: (channel: string, id: string) => void;
    },
  ) {}
  async send(request: SendRequest): Promise<SendOutcome> {
    if (this.inFlight)
      return {
        kind: 'refused',
        code: 'in_flight',
        message: 'a send is already in flight — wait for it',
      };
    const snapshot = Object.freeze({ ...request });
    try {
      safeArgument(snapshot.channel);
      if (snapshot.replyTo !== undefined) safeArgument(snapshot.replyTo);
      if (!snapshot.body.trim()) throw new Error('There is nothing to send.');
      bodyBytes(snapshot.body);
      if (!Number.isSafeInteger(snapshot.draftRevision) || snapshot.draftRevision < 0)
        throw new Error('invalid draft revision');
      if (snapshot.mode !== 'casual' && snapshot.mode !== 'signed')
        throw new Error('invalid send mode');
    } catch (err) {
      return { kind: 'refused', code: 'invalid_argument', message: (err as Error).message };
    }
    this.inFlight = true;
    let recordId: string | undefined;
    let signed: SignedSidecar | undefined;
    let outcome: SendOutcome;
    try {
      try {
        recordId = await this.opts.recovery.record(
          snapshot.channel,
          snapshot.body,
          snapshot.replyTo === undefined ? {} : { replyTo: snapshot.replyTo },
        );
      } catch (err) {
        return {
          kind: 'refused',
          code: 'recovery_failed',
          message: `could not save a recovery copy (${(err as Error).message}) — send refused, your text is kept`,
        };
      }
      const wire =
        snapshot.mode === 'casual' ? `${this.opts.owner.marker} ${snapshot.body}` : snapshot.body;
      const args = ['chat', snapshot.channel, '--send', '--json', '--body-file', '-'];
      if (snapshot.replyTo !== undefined) args.push('--re', snapshot.replyTo);
      try {
        if (snapshot.mode === 'signed') {
          if (this.opts.owner.signingBlocked) throw new Error(this.opts.owner.signingBlocked);
          if (this.opts.sign !== undefined) signed = await this.opts.sign(snapshot);
          else {
            if (!this.opts.agent?.armed) throw new Error('private signing agent is not armed');
            signed = await signV2({
              channel: snapshot.channel,
              body: snapshot.body,
              anchor: this.opts.owner,
              keyFile: this.opts.owner.keyFile,
              agent: this.opts.agent,
            });
          }
          args.push('--signature-ref', signed.signature_ref.tag);
          if (bodyBytes(wire).length > DEFAULT_BODY_BYTES) args.push('--oversize');
        } else if (bodyBytes(wire).length > DEFAULT_BODY_BYTES)
          throw new Error('casual body exceeds post’s 32 KiB limit');
      } catch (err) {
        outcome = { kind: 'refused', code: 'sign_failed', message: (err as Error).message };
        return await this.apply(outcome, recordId, signed);
      }
      // Calls never retry an ambiguous send. A rejected promise before dispatch is a spawn failure.
      try {
        outcome = classifySend(
          await this.opts.post(args, wire),
          snapshot.channel,
          this.opts.owner.ownerRoom,
          recordId,
        );
      } catch {
        outcome = {
          kind: 'uncertain',
          reason: 'send dispatch threw; delivery is unknown',
          recordId,
        };
      }
      if (outcome.kind === 'confirmed') {
        this.ownMessageIds.add(outcome.id);
        try {
          this.opts.onConfirmed?.(snapshot.channel, outcome.id);
        } catch {
          this.notices.push('Delivered; a confirmation observer failed.');
        }
      }
      return await this.apply(outcome, recordId, signed);
    } finally {
      this.inFlight = false;
    }
  }
  private async apply(
    outcome: SendOutcome,
    recordId: string,
    signed: SignedSidecar | undefined,
  ): Promise<SendOutcome> {
    if (outcome.kind === 'uncertain')
      this.notices.push(
        `Delivery unknown; recovery ${recordId} kept. Do not retry before checking history.`,
      );
    else {
      try {
        await this.opts.recovery.remove(recordId);
      } catch {
        this.notices.push(`Recovery ${recordId} could not be removed; evidence kept.`);
      }
    }
    if (outcome.kind === 'refused' && signed !== undefined) {
      try {
        await signed.discard();
      } catch {
        this.notices.push('Unused signature sidecars could not be removed.');
      }
    }
    if (outcome.kind === 'committed') this.notices.push('delivered — do not retry');
    return outcome;
  }
}

/** The caller owns drafts. Frozen revision prevents a confirmed old send clearing new typing. */
export function shouldClearDraft(
  outcome: SendOutcome,
  sentRevision: number,
  currentRevision: number,
): boolean {
  return (
    outcome.kind === 'committed' ||
    outcome.kind === 'uncertain' ||
    (outcome.kind === 'confirmed' && sentRevision === currentRevision)
  );
}
