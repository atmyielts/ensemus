// Owned by the restore slice (OPS-02). See docs/06-delivery/m6-slices.md and ADR-030 D11. What a backup set
// is, as data, so the operator's script and the drill check the same thing. A backup is split into sealed
// parts with a sealed manifest, so a customer's private key is all it takes to open one, on any machine.
import { z } from 'zod';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const BACKUP_COMPONENTS = [
  'postgres_ensemus',
  'postgres_temporal',
  'postgres_temporal_visibility',
  'object_manifest',
  'objects',
  'license_documents',
  'configuration_hashes',
] as const;
export type BackupComponent = (typeof BACKUP_COMPONENTS)[number];

export const backupManifestSchema = z.strictObject({
  format: z.literal('ensemus.backup'),
  format_version: z.literal(1),
  backup_id: z.uuid(),
  taken_at: z.iso.datetime({ offset: true }),
  release_version: z.string().min(1).max(32),
  database_schema_version: z.string().min(1).max(128),
  /** Sealed to this key. The private key is the customer's, and is never in a backup. */
  recipient_key_id: z.string().regex(/^[0-9a-f]{32}$/),
  components: z.array(
    z.strictObject({
      component: z.enum(BACKUP_COMPONENTS),
      /** Parts in order. Their position is part of what is checked, so they cannot be shuffled. */
      parts: z.array(
        z.strictObject({
          file: z.string().regex(/^[a-z0-9_-]+\/[0-9]{6}\.sealed$/),
          plaintext_sha256: sha256,
          sealed_sha256: sha256,
          sealed_bytes: z.int().min(0),
        }),
      ),
    }),
  ),
  /**
   * The ledger stays out, always (ADR-026). A backup that held it could roll it back on restore, which
   * would forget deletions, so a manifest saying otherwise is refused by the schema.
   */
  excludes_tombstone_ledger: z.literal(true),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const OBJECT_PREFIXES_NEVER_RESTORED = [
  'tombstone-ledger/',
  'tombstone-ledger-quarantine/',
] as const;

/** Whether a restore may write this key. Anything under the ledger is refused, whatever the backup holds. */
export function mayRestoreObject(_key: string): boolean {
  throw new Error('NOT_IMPLEMENTED');
}
