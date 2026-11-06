// Artifacts and the deletion sequence (WORK-04, LIFE-01). A tombstone blocks access immediately, in
// the same transaction, before any stored bytes are removed.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendAudit,
  artifacts,
  blobLifecycle,
  tombstones,
  withTenantTx,
  workArtifacts,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { canChangeContent, canDeleteFile, type WorkState } from '@ensemus/domain/work-unit';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import { closeOutdatedReviews, loadChangeable, loadReadable, type WorkRow } from './work';

/** Where bytes live. An S3 adapter implements this, and tests can check calls against it. */
export interface ObjectStore {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const MAX_BYTES = 25 * 1024 * 1024;
/** Far longer than any upload can take, so a sweep never takes bytes a request is about to attach. */
const UPLOAD_GRACE_MS = 60 * 60 * 1000;
/** A row that failed waits before its next try, so it stops taking a place in the next sweep's batch. */
const PURGE_BACKOFF_BASE_MS = 15 * 60 * 1000;
const PURGE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** How long one sweep keeps trying, so a store that hangs cannot use up the whole upkeep Activity. */
const PURGE_BUDGET_MS = 30 * 1000;

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
  input: {
    workUnitId: string;
    name: string;
    mimeType: string;
    body: Buffer;
    /**
     * Keeps one file of this name on the work, decided under the row lock when the file is attached. A
     * repeat that lost the race gets the existing file, and the sweep removes the bytes it uploaded.
     */
    onlyOnce?: boolean;
    /** Checked at both ends of the upload, for a caller whose right to add this can lapse meanwhile. */
    stillAllowed?: (work: WorkRow) => void;
  },
) {
  if (input.body.length === 0 || input.body.length > MAX_BYTES) {
    throw new AppError('INVALID_INPUT');
  }
  const name = input.name.trim().slice(0, 255);
  if (!name) throw new AppError('INVALID_INPUT');
  const id = randomUUID();
  const key = objectKey(context.organizationId, id);
  const work = await withTenantTx(database, context, async (tx) => {
    const current = await loadChangeable(tx, context, input.workUnitId);
    if (!canChangeContent(current.status as WorkState)) throw new AppError('INVALID_STATE');
    input.stillAllowed?.(current);
    // Written before the bytes exist. If anything stops the row arriving, a crash included, the sweep
    // finds this and removes what was uploaded.
    await tx.insert(blobLifecycle).values({
      organizationId: context.organizationId,
      artifactId: id,
      objectKey: key,
      state: 'uploading',
      purgeAfter: new Date(Date.now() + UPLOAD_GRACE_MS),
    });
    return current;
  });
  await store.put(key, input.body, input.mimeType);
  return withTenantTx(database, context, async (tx) => {
    // Checked again: the work may have been paused or finished while the bytes were on their way.
    const current = await loadChangeable(tx, context, input.workUnitId);
    if (!canChangeContent(current.status as WorkState)) throw new AppError('INVALID_STATE');
    input.stillAllowed?.(current);
    if (input.onlyOnce) {
      const [existing] = await tx
        .select({ id: artifacts.id })
        .from(workArtifacts)
        .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
        .where(and(eq(workArtifacts.workUnitId, input.workUnitId), eq(artifacts.name, name)));
      if (existing) return { id: existing.id };
    }
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
    await tx.delete(blobLifecycle).where(eq(blobLifecycle.artifactId, id));
    await emit(tx, context, {
      eventType: 'work.artifact_added',
      aggregateType: 'work_unit',
      aggregateId: input.workUnitId,
      aggregateVersion: work.version,
      classification: work.classification,
      payload: { work_unit_id: input.workUnitId, artifact_id: id },
    });
    await closeOutdatedReviews(tx, context, current);
    return { id };
  });
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
 * Deletes an artifact (docs/04-security/05-data-lifecycle.md). The tombstone commits first, with a
 * record that the bytes have to go, which blocks access at once. Removing the bytes follows, and the
 * person is done once access is blocked: if the store is down now, the sweep finishes it later.
 */
export async function deleteArtifact(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  input: { workUnitId: string; artifactId: string },
) {
  const key = await withTenantTx(database, context, async (tx) => {
    const work = await loadChangeable(tx, context, input.workUnitId);
    if (!canDeleteFile(work.status as WorkState)) throw new AppError('INVALID_STATE');
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
    await tx.insert(blobLifecycle).values({
      organizationId: context.organizationId,
      artifactId: input.artifactId,
      objectKey: found.key,
      state: 'deleting',
      purgeAfter: new Date(),
    });
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
    await closeOutdatedReviews(tx, context, work);
    return found.key;
  });
  await purgeOne(database, store, context, { artifactId: input.artifactId, objectKey: key }).catch(
    // Already recorded as still to do. Access is blocked, so nothing here is the person's problem.
    () => undefined,
  );
}

/** Removes one object and confirms it has gone (LIFE-01, steps 5 and 7). */
async function purgeOne(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  row: { artifactId: string; objectKey: string },
) {
  await store.delete(row.objectKey);
  if (await store.exists(row.objectKey)) throw new Error('Object still present after delete');
  await withTenantTx(database, context, (tx) =>
    tx
      .update(blobLifecycle)
      .set({ state: 'purged', purgedAt: new Date() })
      .where(eq(blobLifecycle.artifactId, row.artifactId)),
  );
}

/**
 * Finishes what deleting and uploading could not: bytes that failed to delete, and uploads whose row
 * never arrived. Each failure is counted and waits longer before its next try, so rows that keep
 * failing cannot fill the batch and keep the others waiting. Returns what happened.
 */
export async function purgeDueBlobs(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  now = new Date(),
  limit = 50,
) {
  const due = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        artifactId: blobLifecycle.artifactId,
        objectKey: blobLifecycle.objectKey,
        attempts: blobLifecycle.attempts,
      })
      .from(blobLifecycle)
      .where(
        and(
          inArray(blobLifecycle.state, ['uploading', 'deleting']),
          lte(blobLifecycle.purgeAfter, now),
        ),
      )
      .orderBy(asc(blobLifecycle.purgeAfter))
      .limit(limit),
  );
  const stopAt = Date.now() + PURGE_BUDGET_MS;
  let purged = 0;
  let failed = 0;
  for (const row of due) {
    if (Date.now() > stopAt) break;
    try {
      await purgeOne(database, store, context, row);
      purged += 1;
    } catch {
      failed += 1;
      await withTenantTx(database, context, (tx) =>
        tx
          .update(blobLifecycle)
          .set({
            attempts: sql`${blobLifecycle.attempts} + 1`,
            purgeAfter: new Date(
              now.getTime() +
                Math.min(PURGE_BACKOFF_BASE_MS * 2 ** row.attempts, PURGE_BACKOFF_MAX_MS),
            ),
          })
          .where(eq(blobLifecycle.artifactId, row.artifactId)),
      );
    }
  }
  return { purged, failed };
}
