// Artifacts and the deletion sequence (WORK-04, LIFE-01). A tombstone blocks access immediately, in
// the same transaction, before any stored bytes are removed.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendAudit,
  artifacts,
  tombstones,
  withTenantTx,
  workArtifacts,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { and, eq } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import { loadChangeable, loadReadable } from './work';

/** Where bytes live. An S3 adapter implements this, and tests can check calls against it. */
export interface ObjectStore {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const MAX_BYTES = 25 * 1024 * 1024;

/** Object keys start with the tenant and contain no names, so they reveal nothing and never clash. */
const objectKey = (organizationId: string, id: string) => `${organizationId}/artifacts/${id}`;

async function isTombstoned(tx: Tx, id: string) {
  const rows = await tx
    .select({ id: tombstones.targetId })
    .from(tombstones)
    .where(and(eq(tombstones.targetType, 'artifact'), eq(tombstones.targetId, id)));
  return rows.length > 0;
}

export async function addArtifact(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { workUnitId: string; name: string; mimeType: string; body: Buffer },
) {
  if (input.body.length === 0 || input.body.length > MAX_BYTES) {
    throw new AppError('INVALID_INPUT');
  }
  const name = input.name.trim().slice(0, 255);
  if (!name) throw new AppError('INVALID_INPUT');
  const id = randomUUID();
  const key = objectKey(context.organizationId, id);
  const work = await withTenantTx(database, context, (tx) =>
    loadChangeable(tx, context, input.workUnitId),
  );
  // Bytes go first. If the transaction then fails, an unreferenced object is harmless and
  // collectable, while a row pointing at nothing would be a broken promise.
  await store.put(key, input.body, input.mimeType);
  await withTenantTx(database, context, async (tx) => {
    await tx.insert(artifacts).values({
      organizationId: context.organizationId,
      id,
      name,
      objectKey: key,
      sha256: createHash('sha256').update(input.body).digest('hex'),
      mimeType: input.mimeType,
      sizeBytes: input.body.length,
      // An artifact inherits its Work Unit's classification (secrets doc, section 6).
      classification: work.classification,
      createdByMembershipId: context.actorType === 'service' ? null : context.membershipId,
    });
    await tx.insert(workArtifacts).values({
      organizationId: context.organizationId,
      workUnitId: input.workUnitId,
      artifactId: id,
    });
    await emit(tx, context, {
      eventType: 'work.artifact_added',
      aggregateType: 'work_unit',
      aggregateId: input.workUnitId,
      aggregateVersion: work.version,
      classification: work.classification,
      payload: { work_unit_id: input.workUnitId, artifact_id: id },
    });
  });
  return { id };
}

/** Reads bytes only after checking both the Work Unit's permission and the tombstone. */
export async function readArtifact(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { workUnitId: string; artifactId: string },
) {
  const row = await withTenantTx(database, context, async (tx) => {
    await loadReadable(tx, context, input.workUnitId);
    if (await isTombstoned(tx, input.artifactId)) throw new AppError('NOT_FOUND');
    const [found] = await tx
      .select({ artifact: artifacts })
      .from(workArtifacts)
      .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
      .where(
        and(
          eq(workArtifacts.workUnitId, input.workUnitId),
          eq(workArtifacts.artifactId, input.artifactId),
        ),
      );
    return found?.artifact;
  });
  if (!row) throw new AppError('NOT_FOUND');
  const body = await store.get(row.objectKey);
  if (createHash('sha256').update(body).digest('hex') !== row.sha256) {
    // Serving altered bytes as if they were the original would be worse than failing.
    throw new AppError('NOT_FOUND');
  }
  return { name: row.name, mimeType: row.mimeType, body };
}

/**
 * Deletes an artifact (docs/04-security/05-data-lifecycle.md). The tombstone commits first, which
 * blocks access at once. Removing the bytes follows, and a failure there leaves it blocked.
 */
export async function deleteArtifact(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { workUnitId: string; artifactId: string },
) {
  const key = await withTenantTx(database, context, async (tx) => {
    const work = await loadChangeable(tx, context, input.workUnitId);
    const [found] = await tx
      .select({ key: artifacts.objectKey })
      .from(workArtifacts)
      .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
      .where(
        and(
          eq(workArtifacts.workUnitId, input.workUnitId),
          eq(workArtifacts.artifactId, input.artifactId),
        ),
      );
    if (!found) throw new AppError('NOT_FOUND');
    await tx
      .insert(tombstones)
      .values({
        organizationId: context.organizationId,
        targetType: 'artifact',
        targetId: input.artifactId,
        reasonCode: 'USER_DELETED',
      })
      .onConflictDoNothing();
    await tx.delete(artifacts).where(eq(artifacts.id, input.artifactId));
    await emit(tx, context, {
      eventType: 'work.artifact_deleted',
      aggregateType: 'work_unit',
      aggregateId: input.workUnitId,
      aggregateVersion: work.version,
      classification: work.classification,
      payload: { work_unit_id: input.workUnitId, artifact_id: input.artifactId },
    });
    await appendAudit(tx, {
      organizationId: context.organizationId,
      actorType: 'user',
      actorId: context.membershipId,
      action: 'artifact.deleted',
      targetRef: `artifact:${input.artifactId}`,
      decision: 'allow',
    });
    return found.key;
  });
  await store.delete(key);
}
