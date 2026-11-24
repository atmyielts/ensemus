import { createHash } from 'node:crypto';
import {
  federationOutboundItems,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  FEDERATION_MAX_FILE_BYTES,
  outboundObjectKey,
  type FederationRefuseCode,
} from '@ensemus/domain/federation';
import { and, eq, sql } from 'drizzle-orm';
import { objectKey, type ObjectStore } from './artifacts';

type Outbound = typeof federationOutboundItems.$inferSelect;
type Scope = { itemId: string; grantId: string };
export type SenderFilePreparation = 'ready' | 'closed' | { refusal: FederationRefuseCode };

/** Publication and source deletion both take this lock before looking at the artifact or its copies. */
export async function lockFederationFileSource(tx: Tx, organizationId: string, artifactId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${organizationId}::uuid::text || ':' || ${artifactId}::uuid::text, 7236074))`);
}

const itemScope = (context: TenantContext, scope: Scope) =>
  and(
    eq(federationOutboundItems.organizationId, context.organizationId),
    eq(federationOutboundItems.id, scope.itemId),
    eq(federationOutboundItems.grantId, scope.grantId),
  );

async function readSourceState(tx: Tx, context: TenantContext, scope: Scope, lock = false) {
  const q = tx.select().from(federationOutboundItems).where(itemScope(context, scope));
  const [row] = await (lock ? q.for('no key update') : q);
  if (!row || row.state !== 'queued') return null;
  const open = await tx.execute<{ allowed: boolean }>(sql`
    select federation.grant_is_open(${scope.grantId}::uuid)
      and exists(select 1 from federation.grants g where g.id=${scope.grantId}::uuid and g.expires_at>clock_timestamp()) as allowed
  `);
  return open.rows[0]?.allowed === true ? row : null;
}

/** The worker rechecks the exact human publisher against the ordinary artifact authority. */
async function sourceIsReadable(tx: Tx, item: Outbound) {
  const result = await tx.execute<{ allowed: boolean }>(sql`
    select exists(
      select 1 from org.memberships member
      join knowledge.artifact_acl_catalog artifact on artifact.organization_id=member.organization_id
      where member.organization_id=${item.organizationId}::uuid and member.id=${item.createdByMembershipId}::uuid
        and member.role in ('owner','admin') and member.status='active'
        and artifact.artifact_id=${item.sourceId}::uuid and artifact.alive
        and artifact.sha256=${item.fileSha256} and artifact.classification=${item.classification}
        and knowledge.artifact_readable(artifact.artifact_id, member.id)
    ) as allowed
  `);
  return result.rows[0]?.allowed === true;
}

function matches(item: Outbound, bytes: Buffer) {
  return (
    bytes.length === item.fileSizeBytes &&
    createHash('sha256').update(bytes).digest('hex') === item.fileSha256
  );
}

/** A positive read of the unique key settles an admitted write even if the grant ended meanwhile. */
export async function verifyFederationSenderFile(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  item: Outbound,
) {
  if (item.sourceUploadState !== 'admitted') return;
  const destination = outboundObjectKey(context.organizationId, item.id);
  let bytes: Buffer;
  try {
    bytes = await store.get(destination, FEDERATION_MAX_FILE_BYTES);
  } catch {
    throw new Error('FEDERATION_SOURCE_UPLOAD_UNCONFIRMED');
  }
  if (!matches(item, bytes)) throw new Error('FEDERATION_SOURCE_UPLOAD_UNCONFIRMED');
  const scope = itemScope(context, { itemId: item.id, grantId: item.grantId });
  await withTenantTx(database, context, async (tx) => {
    const [verified] = await tx
      .update(federationOutboundItems)
      .set({ sourceUploadState: 'verified' })
      .where(and(scope, eq(federationOutboundItems.sourceUploadState, 'admitted')))
      .returning({ id: federationOutboundItems.id });
    if (verified) return;
    const [current] = await tx
      .select({ state: federationOutboundItems.sourceUploadState })
      .from(federationOutboundItems)
      .where(scope);
    // A concurrent observer may have settled it and cleanup may already have removed the row.
    if (current && current.state !== 'verified')
      throw new Error('FEDERATION_SOURCE_UPLOAD_UNCONFIRMED');
  });
}

async function admitSenderUpload(database: AppDatabase, context: TenantContext, scope: Scope) {
  return withTenantTx(database, context, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(federation.grant_lock_key(${scope.grantId}::uuid))`,
    );
    const current = await readSourceState(tx, context, scope, true);
    if (!current) return { kind: 'closed' as const };
    if (current.sourceUploadState !== 'pending') return { kind: 'already' as const, item: current };
    if (!(await sourceIsReadable(tx, current))) return { kind: 'missing' as const };
    const [item] = await tx
      .update(federationOutboundItems)
      .set({ sourceUploadState: 'admitted' })
      .where(itemScope(context, scope))
      .returning();
    if (!item) throw new Error('FEDERATION_SOURCE_UPLOAD_UNCONFIRMED');
    return { kind: 'admitted' as const, item };
  });
}

/** The activity calls this before opening any receiving-side object mutation. */
export async function prepareFederationSenderFile(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  scope: Scope,
): Promise<SenderFilePreparation> {
  if (context.actorType !== 'service') throw new Error('FEDERATION_SOURCE_WORKER_REQUIRED');
  const original = await withTenantTx(database, context, async (tx) => {
    const row = await readSourceState(tx, context, scope);
    return {
      row,
      readable: row?.sourceUploadState === 'pending' && (await sourceIsReadable(tx, row)),
    };
  });
  let item = original.row;
  if (!item) return 'closed';
  if (item.sourceUploadState === null || item.sourceUploadState === 'verified') return 'ready';

  if (item.sourceUploadState === 'pending') {
    if (!original.readable || !item.sourceId || !item.fileMimeType)
      return { refusal: 'FILE_MISSING' };
    if (!store.putSingleAttempt || !store.isPhysicallyAbsent)
      throw new Error('FEDERATION_SOURCE_STORE_CAPABILITY_REQUIRED');
    let bytes: Buffer;
    try {
      bytes = await store.get(
        objectKey(context.organizationId, item.sourceId),
        FEDERATION_MAX_FILE_BYTES,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return { refusal: 'FILE_MISSING' };
      if (error instanceof Error && error.message === 'OBJECT_TOO_LARGE')
        return { refusal: 'FILE_TOO_LARGE' };
      // eslint-disable-next-line preserve-caught-error -- The underlying provider error may contain request data.
      throw new Error('FEDERATION_SOURCE_UNAVAILABLE');
    }
    if (bytes.length > FEDERATION_MAX_FILE_BYTES) return { refusal: 'FILE_TOO_LARGE' };
    if (!matches(item, bytes)) return { refusal: 'FILE_HASH_MISMATCH' };

    const destination = outboundObjectKey(context.organizationId, item.id);
    const mimeType = item.fileMimeType;
    if (await store.isPhysicallyAbsent(destination)) {
      const claim = await admitSenderUpload(database, context, scope);
      if (claim.kind === 'closed') return 'closed';
      if (claim.kind === 'missing') return { refusal: 'FILE_MISSING' };
      item = claim.item;
      if (claim.kind === 'admitted') {
        try {
          await store.putSingleAttempt(destination, bytes, mimeType);
        } catch {
          // The request may have arrived. Only a read may follow this admission.
        }
      }
    } else {
      const current = await withTenantTx(database, context, (tx) =>
        readSourceState(tx, context, scope),
      );
      if (!current) return 'closed';
      if (current.sourceUploadState === 'pending')
        throw new Error('FEDERATION_SOURCE_DESTINATION_IN_USE');
      item = current;
    }
  }
  await verifyFederationSenderFile(database, store, context, item);
  return 'ready';
}
