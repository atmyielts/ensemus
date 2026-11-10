// ADR-028 open question 12, lifecycle item 8a: a deleted custom object record's typed-record purge.
// deleteObjectRecord writes knowledge.record_closed, so every deletion starts knowledgeRecordPurgeWorkflow
// and the record stays a sweep candidate. The production generated-file proof used to refuse the kind
// (INVALID_INPUT), so the purge never completed and every 15-minute sweep re-proved the record, taking
// the organization row lock (lifecycle.record_purge_hold_free, 0514) each time. Now the record is proved
// under its own kind: its copied Work first, then the generated and archive file proofs. Round 12
// (finding 3, 0554): a proof that reads completed records a durable completion, which PostgreSQL writes
// only after proving it again itself, and the sweep no longer lists, proves or locks for that record.
// Real app/agent roles and the knowledge worker's production purge composition. Temporal is not running
// here, so the workflow's steps are driven in process through runRecordPurge, as the workflow itself
// drives them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createObjectRecord,
  createObjectType,
  deleteObjectRecord,
} from '@ensemus/application/custom-objects';
import { confirmRecordWorkPurgeInTx } from '@ensemus/application/knowledge/delegated-record-purge';
import { listRecordPurgeCandidates } from '@ensemus/application/knowledge/record-closure';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import {
  createObjectDeletionLifecycle,
  refuseUnadmittedDeletes,
} from '@ensemus/application/saas/object-deletion';
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';
import {
  createKnowledgePurgeActivities,
  createKnowledgeTranscriptActivities,
} from '@ensemus/workflows/knowledge-purge-activities';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { and, eq, sql } from 'drizzle-orm';
import { pgCode } from '@ensemus/application';
import { legalHolds, openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { runRecordPurge } from '../../packages/workflows/src/knowledge-record-purge-step';
import { createKnowledgePurgePorts } from '../../workers/workflow/src/knowledge-ports';
import { openAgentTestDatabase, seedAiTenant, type AiTenant } from '../helpers/ai/fixtures';
import { delegatedChildHarness } from '../helpers/delegated-child';
import { nativeSovereignContext } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';

describe('ADR-028 typed-record purge of a deleted custom object record (8a)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  // A tenant of its own: the claim ranks every dead record of the tenant, so nothing else is listed.
  let tenant: AiTenant, owner: TenantContext;
  beforeAll(async () => {
    tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    owner = await nativeSovereignContext(app.db, tenant.owner.userId, tenant.organizationId);
  });
  afterAll(async () => {
    await agent.close();
    await app.close();
  });
  // Only the harness's record adapter is used: no child is born here, so no profile or rate card.
  const unused = (): string => {
    throw new Error('TEST_UNUSED');
  };
  const { recordAdapter } = delegatedChildHarness({
    app: app.db,
    agent: agent.db,
    tenant: () => tenant,
    profileId: unused,
    rateCardId: unused,
  });
  /** Each record the copied-Work proof (the first step of every composite proof) was asked about. */
  const proved: string[] = [];
  /** The knowledge worker's composition (workers/workflow/src/knowledge-worker.ts), not a stub. Only
   * observed: every copied-Work proof is the production one, recorded in `proved` before it runs. */
  const production = () => {
    const store = new LifecycleMemoryStore(),
      guarded = withRawKnowledgeObjects({
        database: app.db,
        store,
        exposedStore: refuseUnadmittedDeletes(store),
      }),
      lifecycle = createObjectDeletionLifecycle({ database: app.db, store });
    return createKnowledgePurgeActivities({
      database: app.db,
      store: guarded,
      ingest: {} as never,
      recordWorks: {
        confirmRecordInTx: (tx, context, input) => {
          proved.push(`${input.kind}:${input.id}`);
          return confirmRecordWorkPurgeInTx(tx, context, input);
        },
      },
      ...createKnowledgePurgePorts({
        database: app.db,
        store: guarded,
        derivedLifecycle: lifecycle.derived,
        archiveLifecycle: lifecycle.archive,
      }),
    });
  };
  /** The agent worker's copied-Work step, on the native agent role. */
  const materials = () =>
    createKnowledgeTranscriptActivities({
      database: agent.db,
      transcripts: createRunTranscriptPurge(),
      delegatedRecords: recordAdapter(),
    });
  const objectRecord = async () => {
    const type = await createObjectType(app.db, owner, {
      slug: `purge_${randomUUID().replaceAll('-', '')}`,
      displayName: 'Purged items',
      classification: 'internal',
      fields: [{ key: 'name', label: 'Name', kind: 'text', required: true, indexed: true }],
      relations: [],
    });
    return createObjectRecord(app.db, owner, {
      typeId: type.id,
      displayName: 'Deleted custom record',
      attributes: { name: 'deleted' },
    });
  };
  const listed = async () =>
    listRecordPurgeCandidates(app.db, createServiceContext(tenant.organizationId), { limit: 50 });
  const deletedObjectRecord = async () => {
    const record = await objectRecord();
    await deleteObjectRecord(app.db, owner, {
      recordId: record.id,
      expectedVersion: record.version,
    });
    return record;
  };
  /** Whether any job of the record holds a completion (0554), and whether it is current. */
  const completion = (id: string) =>
    withTenantTx(app.db, createServiceContext(tenant.organizationId), async (tx) => {
      const result = await tx.execute<{ completed: boolean; current: boolean }>(sql`
        select coalesce(bool_or(job.completed_restore_generation is not null),false) completed,
          ai.record_purge_completed('object_record',${id}::uuid,ai.current_material_restore_generation()) current
        from ai.record_purge_jobs job where job.record_kind='object_record' and job.record_id=${id}::uuid`);
      return result.rows[0];
    });

  it('[ADR028-Q12-L8a] a live custom object record is no candidate and its file purge refuses', async () => {
    const live = await objectRecord();
    expect((await listed()).some((candidate) => candidate.id === live.id)).toBe(false);
    // The generated contributor's closure check refuses a live record; the composite never turns
    // that refusal into an empty success.
    await expect(
      production().purgeRecordFiles({
        organizationId: tenant.organizationId,
        kind: 'object_record',
        id: live.id,
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('[ADR028-Q12-L8a] completes the purge of a deleted custom object record, and the sweep stops proving it', async () => {
    const record = await deletedObjectRecord();
    const input = {
      organizationId: tenant.organizationId,
      kind: 'object_record' as const,
      id: record.id,
      limit: 25,
    };
    const key = `object_record:${record.id}`;
    const keyed = (rows: readonly { kind: string; id: string }[]) =>
      rows.map((row) => `${row.kind}:${row.id}`);
    expect(await listed()).toEqual([{ kind: 'object_record', id: record.id, checked: false }]);
    // Before its copied Work is proved the record is restarted, never counted as failed.
    const before = await production().claimRecordPurgeRestarts({
      organizationId: tenant.organizationId,
    });
    expect({ due: keyed(before.due), failed: before.failed }).toEqual({ due: [key], failed: 0 });
    expect(await production().readRecordPurgeState(input)).toMatchObject({
      state: 'unconfirmed',
      filesRemaining: null,
    });

    // The workflow's own steps: copied Work on the agent role, then the generated and archive files,
    // then the final proof, each for the object record under its own kind.
    const worker = production();
    const result = await runRecordPurge({
      materials: () => materials().purgeRecordMaterials(input),
      files: () => worker.purgeRecordFiles(input),
      confirm: () => worker.confirmRecordPurge(input),
    });
    expect(result).toMatchObject({
      state: 'completed',
      work: { confirmed: true, remaining: 0, controlsRemaining: 0, unproven: 0 },
      filesRemaining: 0,
      filesHeld: 0,
    });
    // Its delegated copies stay purged: PostgreSQL's copied-Work proof holds for the record.
    expect(
      await withTenantTx(app.db, createServiceContext(tenant.organizationId), (tx) =>
        confirmRecordWorkPurgeInTx(tx, createServiceContext(tenant.organizationId), {
          kind: 'object_record',
          id: record.id,
        }),
      ),
    ).toMatchObject({ confirmed: true, remaining: 0, controlsRemaining: 0, unproven: 0 });

    // The workflow's final proof read completed, so PostgreSQL recorded the durable completion (0554).
    expect(await completion(record.id)).toEqual({ completed: true, current: true });

    // A second deleted record whose purge has not run: its proof is incomplete.
    const open = await deletedObjectRecord(),
      openKey = `object_record:${open.id}`;
    expect(await completion(open.id)).toEqual({ completed: false, current: false });

    // Finding 3 (round 12, 0554): a completed record is no longer a candidate, so later sweeps neither
    // restart it nor count it as a failure, and never prove it again: its copied-Work proof (the first
    // step of the composite proof, and the one that takes the organization row lock through 0514) is
    // not asked. The incomplete record is still proved, and restarted, by every sweep.
    expect(keyed(await listed())).toEqual([openKey]);
    for (let pass = 0; pass < 2; pass++) {
      proved.length = 0;
      const claim = await production().claimRecordPurgeRestarts({
        organizationId: tenant.organizationId,
      });
      expect({ due: keyed(claim.due), failed: claim.failed }).toEqual({
        due: [openKey],
        failed: 0,
      });
      expect(proved).toEqual([openKey]);
    }
    expect(await completion(open.id)).toEqual({ completed: false, current: false });
    // The completed record still reads completed from PostgreSQL whenever the workflow asks.
    expect(await production().readRecordPurgeState(input)).toMatchObject({
      state: 'completed',
      filesRemaining: 0,
    });
  });

  it('[ADR028-Q12-L8a] PostgreSQL writes a record purge completion only from its own composite proof (0554)', async () => {
    const record = await deletedObjectRecord();
    const input = {
      organizationId: tenant.organizationId,
      kind: 'object_record' as const,
      id: record.id,
      limit: 25,
    };
    const service = createServiceContext(tenant.organizationId);
    // The runtime's direct UPDATE. Whatever value it sends for the completion is not what is stored.
    const assignments = {
      completion: sql`completed_restore_generation=${randomUUID()}::uuid`,
      completedAt: sql`completed_at=now()`,
      checkedAt: sql`checked_at=null`,
    };
    const attest = (context: TenantContext, assignment = assignments.completion) =>
      withTenantTx(app.db, context, async (tx) => {
        const result = await tx.execute(
          sql`update ai.record_purge_jobs set ${assignment}
            where record_kind='object_record' and record_id=${record.id}::uuid`,
        );
        return result.rowCount;
      });
    const refusal = (attempt: Promise<unknown>) =>
      attempt.then(
        () => 'written',
        (error: unknown) => pgCode(error) ?? (error as { code?: string }).code,
      );

    // Before any purge there is no job: the attestation finds nothing to complete.
    expect(await attest(service)).toBe(0);
    // Its copied Work is proved on the agent role (the job is checked), but a legal hold keeps the
    // composite proof from completing: PostgreSQL refuses the completion (EN119) and writes nothing.
    // The hold is placed and released by the owner through the real commands (ADR-032 D6,
    // legal_hold.manage), on the app role, exactly as the product writes it.
    await materials().purgeRecordMaterials(input);
    const { holdId } = await placeLegalHold(app.db, tenant.owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    const hold = () =>
      withTenantTx(app.db, tenant.owner, async (tx) => {
        const [row] = await tx
          .select({
            status: legalHolds.status,
            placedByMembershipId: legalHolds.placedByMembershipId,
            releasedByMembershipId: legalHolds.releasedByMembershipId,
            releasedAt: legalHolds.releasedAt,
            releaseReasonCode: legalHolds.releaseReasonCode,
            version: legalHolds.version,
          })
          .from(legalHolds)
          .where(
            and(eq(legalHolds.organizationId, tenant.organizationId), eq(legalHolds.id, holdId)),
          );
        return row;
      });
    const placed = await hold();
    expect(placed).toEqual({
      status: 'active',
      placedByMembershipId: tenant.owner.membershipId,
      releasedByMembershipId: null,
      releasedAt: null,
      releaseReasonCode: null,
      version: 1,
    });
    try {
      expect(await refusal(attest(service))).toBe('EN119');
      expect(await completion(record.id)).toEqual({ completed: false, current: false });
    } finally {
      await releaseLegalHold(app.db, tenant.owner, {
        holdId,
        reasonCode: 'TEST_MATTER_CLOSED',
        expectedVersion: placed!.version,
      });
    }
    // The hold row as releaseLegalHold wrote it: released, by the owner's membership, with its reason.
    expect(await hold()).toEqual({
      status: 'released',
      placedByMembershipId: tenant.owner.membershipId,
      releasedByMembershipId: tenant.owner.membershipId,
      releasedAt: expect.any(Date),
      releaseReasonCode: 'TEST_MATTER_CLOSED',
      version: 2,
    });
    // The runtime cannot write the completion time or any other column of the job (no privilege), and
    // a person's context reaches no row.
    for (const assignment of [assignments.completedAt, assignments.checkedAt])
      expect(await refusal(attest(service, assignment))).toBe('42501');
    expect(await attest(tenant.owner)).toBe(0);
    expect(await completion(record.id)).toEqual({ completed: false, current: false });

    // With the hold released the composite proof completes. The value the runtime sent is ignored:
    // PostgreSQL stores the current restore generation, the one the completion is keyed by.
    expect(await attest(service)).toBe(1);
    expect(await completion(record.id)).toEqual({ completed: true, current: true });
    expect(await listed()).not.toContainEqual(expect.objectContaining({ id: record.id }));
    const keyedBy = (generation: 'current' | 'other' | 'none') =>
      withTenantTx(app.db, service, async (tx) => {
        const value =
          generation === 'current'
            ? sql`ai.current_material_restore_generation()`
            : generation === 'other'
              ? sql`${randomUUID()}::uuid`
              : sql`null::uuid`;
        const result = await tx.execute<{ completed: boolean }>(
          sql`select ai.record_purge_completed('object_record',${record.id}::uuid,${value}) completed`,
        );
        return result.rows[0]?.completed;
      });
    // Another restore generation (a restore) does not see this completion; neither does none.
    expect([await keyedBy('current'), await keyedBy('other'), await keyedBy('none')]).toEqual([
      true,
      false,
      false,
    ]);

    // Any agent purge pass reopens it: the next sweep lists and proves the record again, and that proof,
    // reading completed, records it again.
    await materials().purgeRecordMaterials(input);
    expect(await completion(record.id)).toEqual({ completed: false, current: false });
    const key = `object_record:${record.id}`;
    expect((await listed()).map((row) => `${row.kind}:${row.id}`)).toContain(key);
    proved.length = 0;
    const claim = await production().claimRecordPurgeRestarts({
      organizationId: tenant.organizationId,
    });
    expect(proved).toContain(key);
    expect(claim.due.map((row) => `${row.kind}:${row.id}`)).not.toContain(key);
    expect(await completion(record.id)).toEqual({ completed: true, current: true });
    expect(await listed()).not.toContainEqual(expect.objectContaining({ id: record.id }));
  });
});
