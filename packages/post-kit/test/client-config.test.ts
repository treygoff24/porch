/**
 * The seam between the two halves of post-kit: a config loaded by the stores half becomes the
 * client's config, and both halves name the same drafts namespace (so drafts and recovery records
 * share one lock file).
 */
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/porch-config.ts';
import { clientConfig } from '../src/owner.ts';
import { SendRecord } from '../src/recovery.ts';
import { DraftSpace } from '../src/stores/drafts.ts';

const loaded = buildConfig(
  { ownerRoom: 'mara', ownerRoomDir: '/r/mara', signingNamespace: 'ns.mara' },
  { env: {}, home: '/home/mara' },
);

describe('clientConfig', () => {
  it('carries every field the client reads, with the signing namespace as `namespace`', () => {
    expect(clientConfig(loaded)).toEqual({
      ownerRoom: 'mara',
      ownerRoomDir: '/r/mara',
      mailRoot: '/home/mara/.claude-mail',
      sidecarDir: '/r/mara',
      allowedSigners: '/r/mara/allowed_signers',
      keyFile: '/r/mara/mara_porch_key',
      namespace: 'ns.mara',
      principal: 'mara@porch',
      marker: '🦊',
      label: 'Mara',
    });
  });

  it('gives send recovery and drafts the same namespace and directory', () => {
    const recovery = new SendRecord(clientConfig(loaded));
    const drafts = new DraftSpace(loaded);
    expect(recovery.namespace).toBe(drafts.namespace);
    expect(recovery.directory).toBe(drafts.directory);
  });
});
