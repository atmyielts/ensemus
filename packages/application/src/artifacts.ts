// Artifacts and the deletion sequence (WORK-04, LIFE-01). A tombstone blocks access immediately, in
// the same transaction, before any stored bytes are removed.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendAudit,
  artifacts,
  blobLifecycle,
  domainEvents,
  tombstones,
  withTenantTx,
  workArtifacts,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import {
  canChangeContent,
  canDeleteFile,
  MAX_FILE_BYTES,
  type WorkState,
} from '@ensemus/domain/work-unit';
import { and, asc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import { AppError } from './errors';
import { eraseTombstonedArtifact } from './saas/object-deletion';
import { emit } from './events';
import { idFromRequest } from './request-id';
import { closeOutdatedReviews, loadChangeable, loadReadable, type WorkRow } from './work';
import {
  assertArtifactRetentionInTx,
  type ArtifactRetentionAuthority,
} from './saas/retention-authority';

/** Where bytes live. An S3 adapter implements this, and tests can check calls against it. */
export interface ObjectStore {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Far longer than any upload can take, so a sweep never takes bytes a request is about to attach. */
const UPLOAD_GRACE_MS = 60 * 60 * 1000;
/** A row that failed waits before its next try, so it stops taking a place in the next sweep's batch. */
const PURGE_BACKOFF_BASE_MS = 15 * 60 * 1000;
const PURGE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** How long one sweep keeps trying, so a store that hangs cannot use up the whole upkeep Activity. */
const PURGE_BUDGET_MS = 30 * 1000;

/** Object keys start with the tenant and contain no names, so they reveal nothing and never clash. */
export const objectKey = (organizationId: string, id: string) =>
  `${organizationId}/artifacts/${id}`;

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
    /**
     * From one rendered form. The same file sent again from it attaches once, so a double-click or a
     * resent page gets the first one back. A different file, or one sent after this one was deleted,
     * is attached as a new one.
     */
    requestKey?: string;
    /** Checked at both ends of the upload, for a caller whose right to add this can lapse meanwhile. */
    stillAllowed?: (work: WorkRow) => void;
  },
) {
  // Deterministic/agent writers must register their complete inputs before any bytes can be put.
  // addGeneratedArtifact owns that protocol; a missing provenance port is never an empty inventory.
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
  if (input.body.length === 0) throw new AppError('INVALID_INPUT');
  if (input.body.length > MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE');
  const name = input.name.trim().slice(0, 255);
  if (!name) throw new AppError('INVALID_INPUT');
  const sha256 = createHash('sha256').update(input.body).digest('hex');
  let id = input.requestKey
    ? idFromRequest('artifact', context.membershipId, input.requestKey, [
        input.workUnitId,
        name,
        sha256,
      ])
    : randomUUID();
  const attached = (tx: Tx) =>
    tx
      .select({ id: workArtifacts.artifactId })
      .from(workArtifacts)
      .where(and(eq(workArtifacts.workUnitId, input.workUnitId), eq(workArtifacts.artifactId, id)));
  const first = await withTenantTx(database, context, async (tx) => {
    const current = await loadChangeable(tx, context, input.workUnitId);
    if (!canChangeContent(current.status as WorkState)) throw new AppError('INVALID_STATE');
    input.stillAllowed?.(current);
    if (input.requestKey) {
      const [repeat] = await attached(tx);
      if (repeat) return { repeat };
      // Deleted for good, and a tombstone stays on its ID, so what is sent now needs one of its own.
      if (await isTombstoned(tx, id)) id = randomUUID();
    }
    // Written before the bytes exist. If anything stops the row arriving, a crash included, the sweep
    // finds this and removes what was uploaded. A repeat racing this one shares its row and its bytes.
    await tx
      .insert(blobLifecycle)
      .values({
        organizationId: context.organizationId,
        artifactId: id,
        objectKey: objectKey(context.organizationId, id),
        state: 'uploading',
        purgeAfter: new Date(Date.now() + UPLOAD_GRACE_MS),
      })
      .onConflictDoNothing();
    return { work: current };
  });
  if (first.repeat) return { id: first.repeat.id };
  const { work } = first;
  const key = objectKey(context.organizationId, id);
  await store.put(key, input.body, input.mimeType);
  return withTenantTx(database, context, async (tx) => {
    // Checked again: the work may have been paused or finished while the bytes were on their way.
    const current = await loadChangeable(tx, context, input.workUnitId);
    if (!canChangeContent(current.status as WorkState)) throw new AppError('INVALID_STATE');
    input.stillAllowed?.(current);
    if (input.requestKey) {
      // The row lock above puts two racing repeats in order, and the second finds the first's file.
      const [repeat] = await attached(tx);
      if (repeat) return { id: repeat.id };
    }
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
      sha256,
      mimeType: input.mimeType,
      sizeBytes: input.body.length,
      // An artifact inherits its Work Unit's classification (secrets doc, section 6).
      classification: current.classification,
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
      // What it is now. The work may have moved on while the bytes were uploading.
      aggregateVersion: current.version,
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
  // Object reads do not hold SQL locks. Recheck the source/work/tombstone fence after I/O so an ACL
  // or source closure committed while the bytes were read cannot return the old authorization.
  await withTenantTx(database, context, async (tx) => {
    await loadReadable(tx, context, input.workUnitId);
    const [current] = await tx
      .select({ sha256: artifacts.sha256, key: artifacts.objectKey })
      .from(workArtifacts)
      .innerJoin(artifacts, eq(artifacts.id, workArtifacts.artifactId))
      .where(
        and(eq(workArtifacts.workUnitId, input.workUnitId), eq(artifacts.id, input.artifactId)),
      );
    if (
      !current ||
      current.sha256 !== row.sha256 ||
      current.key !== row.objectKey ||
      (await isTombstoned(tx, input.artifactId))
    )
      throw new AppError('NOT_FOUND');
  });
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
  const key = await withTenantTx(database, context, (tx) => deleteArtifactInTx(tx, context, input));
  await purgeOne(database, store, context, { artifactId: input.artifactId, objectKey: key }).catch(
    // Already recorded as still to do. Access is blocked, so nothing here is the person's problem.
    () => undefined,
  );
}

/** Keeps retention's per-record savepoint on the normal tombstone, ledger and review invalidation path. */
export async function deleteArtifactInTx(
  tx: Tx,
  context: TenantContext,
  input: { workUnitId: string; artifactId: string; retention?: ArtifactRetentionAuthority },
): Promise<string> {
  const work = await loadChangeable(tx, context, input.workUnitId);
  if (input.retention)
    await assertArtifactRetentionInTx(tx, context, input.artifactId, input.retention);
  if (!canDeleteFile(work.status as WorkState) && !input.retention)
    throw new AppError('INVALID_STATE');
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
  await recordArtifactTombstoneInTx(
    tx,
    context,
    {
      artifactId: input.artifactId,
      workUnitId: input.workUnitId,
      ...(input.retention ? { retention: input.retention } : {}),
    },
    async () => {
      await tx.delete(artifacts).where(eq(artifacts.id, input.artifactId));
      await emit(tx, context, {
        eventType: 'work.artifact_deleted',
        aggregateType: 'work_unit',
        aggregateId: input.workUnitId,
        aggregateVersion: work.version,
        classification: work.classification,
        payload: { work_unit_id: input.workUnitId, artifact_id: input.artifactId },
      });
    },
  );
  await appendAudit(tx, {
    organizationId: context.organizationId,
    actorType: context.actorType === 'service' ? 'service' : 'user',
    ...(context.actorType === 'service' ? {} : { actorId: context.membershipId }),
    action: 'artifact.deleted',
    targetRef: `artifact:${input.artifactId}`,
    decision: 'allow',
  });
  await closeOutdatedReviews(tx, context, work);
  return found.key;
}

/** Records the restore-safe deletion stage without erasing the row or touching object storage. */
export async function recordArtifactTombstoneInTx(
  tx: Tx,
  context: TenantContext,
  input: {
    artifactId: string;
    workUnitId?: string;
    retention?: ArtifactRetentionAuthority;
    offboardingId?: string;
  },
  beforeLedger?: () => Promise<void>,
): Promise<{ added: boolean; objectKey: string }> {
  let classification: string | undefined;
  if (input.offboardingId) {
    if (context.actorType !== 'service' || input.retention) throw new AppError('NOT_FOUND');
    const receipt = await tx.execute(
      sql`select exists(select 1 from lifecycle.offboardings o join org.organizations g on g.id=o.organization_id where o.organization_id=${context.organizationId}::uuid and o.id=${input.offboardingId}::uuid and o.state='erasing' and g.lifecycle='offboarding' and o.export_offered_at is not null and o.connections_revoked_at is not null and o.work_ended_at is not null and o.actions_settled_at is not null and o.transition_ends_at<=now() and not exists(select 1 from lifecycle.legal_holds h where h.organization_id=o.organization_id and h.status='active')) as allowed`,
    );
    if (receipt.rows[0]?.allowed !== true) throw new AppError('PREREQUISITES_INCOMPLETE');
  } else {
    if (!input.workUnitId) throw new AppError('INVALID_INPUT');
    const work = await loadChangeable(tx, context, input.workUnitId);
    if (input.retention)
      await assertArtifactRetentionInTx(tx, context, input.artifactId, input.retention);
    else if (!canDeleteFile(work.status as WorkState)) throw new AppError('INVALID_STATE');
    const [link] = await tx
      .select({ id: workArtifacts.artifactId })
      .from(workArtifacts)
      .where(
        and(
          eq(workArtifacts.workUnitId, input.workUnitId),
          eq(workArtifacts.artifactId, input.artifactId),
        ),
      );
    if (!link) throw new AppError('NOT_FOUND');
    classification = work.classification;
  }
  const [artifact] = await tx
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, input.artifactId))
    .for('update');
  if (!artifact) throw new AppError('NOT_FOUND');
  classification ??= artifact.classification;
  const marked = await tx
    .insert(tombstones)
    .values({
      organizationId: context.organizationId,
      targetType: 'artifact',
      targetId: input.artifactId,
      reasonCode: input.offboardingId
        ? 'TENANT_ERASURE'
        : input.retention
          ? 'RETENTION_EXPIRED'
          : 'USER_DELETED',
    })
    .onConflictDoNothing()
    .returning({ id: tombstones.targetId });
  await tx
    .insert(blobLifecycle)
    .values({
      organizationId: context.organizationId,
      artifactId: artifact.id,
      objectKey: artifact.objectKey,
      state: 'deleting',
      purgeAfter: new Date(),
    })
    .onConflictDoUpdate({
      target: [blobLifecycle.organizationId, blobLifecycle.artifactId],
      set: { state: 'deleting', purgeAfter: new Date() },
      setWhere: ne(blobLifecycle.state, 'purged'),
    });
  if (beforeLedger) await beforeLedger();
  const [event] = await tx
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.eventType, TOMBSTONE_RECORDED),
        eq(domainEvents.aggregateType, 'artifact'),
        eq(domainEvents.aggregateId, artifact.id),
      ),
    )
    .limit(1);
  if (!event)
    await emit(tx, context, {
      eventType: TOMBSTONE_RECORDED,
      aggregateType: 'artifact',
      aggregateId: artifact.id,
      aggregateVersion: 1,
      classification,
      payload: { artifact_id: artifact.id },
    });
  return { added: marked.length > 0, objectKey: artifact.objectKey };
}

/** Removes one object and confirms it has gone (LIFE-01, steps 5 and 7). */
async function purgeOne(
  database: AppDatabase,
  store: ObjectStore,
  context: TenantContext,
  row: { artifactId: string; objectKey: string },
) {
  const result = await eraseTombstonedArtifact({database,store},context,row.artifactId);
  if (result.state !== 'purged') throw new AppError(result.state === 'held' ? 'LEGAL_HOLD_ACTIVE' : 'OBJECT_DELETE_UNCONFIRMED');
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
          // The exact lifecycle authority selects the actual writer below. An orphan upload's
          // grace period never proves its put finished; missing/unknown receipts remain unconfirmed.
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
