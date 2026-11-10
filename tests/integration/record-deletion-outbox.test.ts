// ADR-028 open question 12, lifecycle item 8a: the typed-record deletion outbox and its restart path.
// Real app/agent roles. The dispatcher and Temporal are not running here, so the dispatcher route is
// unit-tested (workers/workflow/src/record-purge-route.test.ts) and this file proves the PostgreSQL side:
// the producers write the event and its outbox row, and the sweep's claim re-proves each dead record from
// PostgreSQL. The capability is qualified for this file through the migrator and restored afterwards.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createWorkUnit, getWorkUnit } from '@ensemus/application';
import {
  createObjectRecord,
  createObjectType,
  deleteObjectRecord,
} from '@ensemus/application/custom-objects';
import { confirmRecordWorkPurgeInTx } from '@ensemus/application/knowledge/delegated-record-purge';
import {
  emitRecordClosedInTx,
  listRecordPurgeCandidates,
} from '@ensemus/application/knowledge/record-closure';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import {
  createKnowledgePurgeActivities,
  createKnowledgeTranscriptActivities,
} from '@ensemus/workflows/knowledge-purge-activities';
import {
  delegatedInputReceipts,
  domainEvents,
  openAppDatabase,
  outboxEvents,
  runInputCheckpoints,
  tombstones,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { recordImportedTombstone } from '../../packages/application/src/portability-sections-import';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedAiTenant,
  seedOrganizationBudget,
  seedRateCard,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { makeTwoTenants } from '../helpers/product';
import { nativeSovereignContext } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { delegatedChildHarness, noObjects } from '../helpers/delegated-child';
import { qualifyDelegationForSuite } from '../helpers/delegation-capability';
import {
  createObjectDeletionLifecycle,
  refuseUnadmittedDeletes,
} from '@ensemus/application/saas/object-deletion';
import { withRawKnowledgeObjects } from '@ensemus/application/knowledge/raw-objects';
import { createKnowledgePurgePorts } from '../../workers/workflow/src/knowledge-ports';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';

describe('ADR-028 typed-record deletion outbox (8a)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let a: AiTenant, b: AiTenant, profileId: string, rateCardId: string;
  let people: Awaited<ReturnType<typeof makeTwoTenants>>;
  let capability: Awaited<ReturnType<typeof qualifyDelegationForSuite>> | undefined;
  beforeAll(async () => {
    capability = await qualifyDelegationForSuite('record-deletion-outbox');
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    profileId = await seedActiveProfile(app.db, agent.db, a.owner);
    rateCardId = await seedRateCard(app.db, a.owner, profileId);
    await seedOrganizationBudget(app.db, a.owner, 1_000_000);
    people = await makeTwoTenants(app.db);
  });
  afterAll(async () => {
    await capability?.restore();
    await agent.close();
    await app.close();
  });
  const { genuineChildWithRecord, recordAdapter, closeRecord } = delegatedChildHarness({
    app: app.db,
    agent: agent.db,
    tenant: () => a,
    profileId: () => profileId,
    rateCardId: () => rateCardId,
  });
  /** The knowledge worker's Activities over the app role, with the generated-file proof fixed at zero
   * (the children here write no file). It isolates the copied-Work proof; the last case below runs the
   * production file-proof composition instead, which this stub would hide. */
  const knowledge = () =>
    createKnowledgePurgeActivities({
      database: app.db,
      store: noObjects,
      ingest: {} as never,
      recordWorks: { confirmRecordInTx: confirmRecordWorkPurgeInTx },
      derivedArtifacts: {
        purgeSource: async () => {
          throw new Error('TEST_UNUSED');
        },
        confirmInTx: async () => {
          throw new Error('TEST_UNUSED');
        },
        confirmRecordInTx: async () => ({ remaining: 0 }),
      },
    });
  const closedEvents = (context: TenantContext, id: string) =>
    withTenantTx(app.db, context, async (tx) => {
      const events = await tx
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.eventType, 'knowledge.record_closed'),
            eq(domainEvents.aggregateId, id),
          ),
        );
      const outbox = await Promise.all(
        events.map(async (event) => {
          const [row] = await tx
            .select({ state: outboxEvents.state })
            .from(outboxEvents)
            .where(eq(outboxEvents.eventId, event.id));
          return row?.state;
        }),
      );
      return { events, outbox };
    });
  const objectType = () =>
    createObjectType(app.db, people.a.owner.context, {
      slug: `outbox_${randomUUID().replaceAll('-', '')}`,
      displayName: 'Outbox items',
      classification: 'internal',
      fields: [{ key: 'name', label: 'Name', kind: 'text', required: true, indexed: true }],
      relations: [],
    });
  const dueFor = async (organizationId: string) =>
    (await knowledge().claimRecordPurgeRestarts({ organizationId })).due.map(
      (record) => `${record.kind}:${record.id}`,
    );

  it('[ADR028-Q12-L8a] deleting a custom object record writes one restricted IDs-only event and its outbox row', async () => {
    const type = await objectType();
    const record = await createObjectRecord(app.db, people.a.member.context, {
      typeId: type.id,
      displayName: 'Closed by its owner',
      attributes: { name: 'closing' },
    });
    // A refused delete (a stale version) writes nothing.
    await expect(
      deleteObjectRecord(app.db, people.a.member.context, {
        recordId: record.id,
        expectedVersion: record.version + 1,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await closedEvents(people.a.owner.context, record.id)).events).toEqual([]);
    await deleteObjectRecord(app.db, people.a.member.context, {
      recordId: record.id,
      expectedVersion: record.version,
    });
    const { events, outbox } = await closedEvents(people.a.owner.context, record.id);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: 'knowledge.record_closed',
        aggregateType: 'object_record',
        aggregateId: record.id,
        classification: 'restricted',
        payload: { record_kind: 'object_record', record_id: record.id },
      }),
    ]);
    expect(Object.keys(events[0]!.payload as object).sort()).toEqual(['record_id', 'record_kind']);
    expect(outbox).toEqual(['queued']);
  });

  /** Imports a client tombstone dated `deletedAt`, then emits again for it in a later transaction. */
  const importClientTombstone = async (deletedAt: Date) => {
    const service = createServiceContext(people.b.organizationId),
      clientId = randomUUID();
    expect(
      await withTenantTx(app.db, service, (tx) =>
        recordImportedTombstone(tx, service, {
          targetType: 'client',
          targetId: clientId,
          deletedAt,
        }),
      ),
    ).toBe(true);
    const first = await closedEvents(service, clientId);
    expect(first.events).toEqual([
      expect.objectContaining({ aggregateType: 'client', classification: 'restricted' }),
    ]);
    expect(first.outbox).toEqual(['queued']);
    expect(
      await withTenantTx(app.db, service, (tx) =>
        emitRecordClosedInTx(tx, service, { kind: 'client', id: clientId }),
      ),
    ).toBe(false);
    expect((await closedEvents(service, clientId)).events).toHaveLength(1);
    const [stored] = await withTenantTx(app.db, service, (tx) =>
      tx
        .select({ createdAt: tombstones.createdAt })
        .from(tombstones)
        .where(and(eq(tombstones.targetType, 'client'), eq(tombstones.targetId, clientId))),
    );
    return { tombstoneAt: stored!.createdAt, eventAt: first.events[0]!.occurredAt };
  };

  it('[ADR028-Q12-L8a] an imported client tombstone writes the event once, and a second emit writes nothing', async () => {
    // An archive is hostile and may date a deletion in the future. recordImportedTombstone clamps it to
    // the import transaction's now(), the event's occurred_at, because emitRecordClosedInTx counts only
    // an event at least as new as the tombstone as this closure's (ADR-028 item 8a): a tombstone dated
    // after its own event would make every later emit write the event again.
    const deletedAt = new Date(Date.now() + 86_400_000);
    const { tombstoneAt, eventAt } = await importClientTombstone(deletedAt);
    expect(tombstoneAt.getTime()).toBeLessThan(deletedAt.getTime());
    expect(tombstoneAt.getTime()).toBe(eventAt.getTime());
  });

  it('[ADR028-Q12-L8a] an imported client tombstone dated in the past keeps its date, and writes the event once', async () => {
    const deletedAt = new Date(Date.now() - 86_400_000);
    const { tombstoneAt, eventAt } = await importClientTombstone(deletedAt);
    expect(tombstoneAt.getTime()).toBe(deletedAt.getTime());
    expect(eventAt.getTime()).toBeGreaterThan(tombstoneAt.getTime());
  });

  it('[ADR028-Q12-L8a] the sweep claims a closed record with genuine child material until PostgreSQL proves its purge', async () => {
    const f = await genuineChildWithRecord(),
      service = createServiceContext(a.organizationId),
      key = `work_unit:${f.input.id}`,
      holdId = randomUUID();
    expect(await dueFor(a.organizationId)).not.toContain(key);
    await closeRecord(f.input.id);
    expect(await dueFor(a.organizationId)).toContain(key);
    await withTenantTx(app.db, a.owner, async (tx) => {
      await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
        values(${a.organizationId}::uuid,${holdId}::uuid,${randomUUID()},${a.owner.membershipId}::uuid)`);
      await tx.execute(
        sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type) values(${a.organizationId}::uuid,${holdId}::uuid,'organization')`,
      );
    });
    try {
      expect(
        await recordAdapter().purgeRecord(service, {
          kind: 'work_unit',
          id: f.input.id,
          limit: 25,
        }),
      ).toMatchObject({ confirmed: false, removed: 0 });
      // Under the hold the record stays due.
      expect(await dueFor(a.organizationId)).toContain(key);
    } finally {
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.execute(sql`update lifecycle.legal_holds set status='released',released_by_membership_id=${a.owner.membershipId}::uuid,
      released_at=now(),release_reason_code='TEST_RELEASE',version=version+1 where organization_id=${a.organizationId}::uuid and id=${holdId}::uuid`),
      );
    }
    expect(
      await recordAdapter().purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 }),
    ).toMatchObject({ confirmed: true, removed: 1, remaining: 0, controlsRemaining: 0 });
    expect(await dueFor(a.organizationId)).not.toContain(key);
    expect(
      await knowledge().readRecordPurgeState({
        organizationId: a.organizationId,
        kind: 'work_unit',
        id: f.input.id,
        limit: 25,
      }),
    ).toMatchObject({ state: 'completed', filesRemaining: 0 });
  });

  it('[ADR028-Q12-L8a] claims at most five restarts, and never a live, artifact or other-tenant record', async () => {
    const closed = [] as string[];
    for (let i = 0; i < 7; i++) {
      const work = await createWorkUnit(app.db, b.owner, { title: `Closed record ${i}` });
      await withTenantTx(app.db, b.owner, (tx) =>
        tx.insert(tombstones).values({
          organizationId: b.organizationId,
          targetType: 'work_unit',
          targetId: work.id,
          reasonCode: 'USER_DELETED',
        }),
      );
      closed.push(`work_unit:${work.id}`);
    }
    const live = await createWorkUnit(app.db, b.owner, { title: 'Still live' }),
      artifactId = randomUUID();
    await withTenantTx(app.db, b.owner, (tx) =>
      tx.insert(tombstones).values({
        organizationId: b.organizationId,
        targetType: 'artifact',
        targetId: artifactId,
        reasonCode: 'USER_DELETED',
      }),
    );
    const due = await dueFor(b.organizationId);
    expect(due).toHaveLength(5);
    for (const key of due) expect(closed).toContain(key);
    const listed = (
      await listRecordPurgeCandidates(app.db, createServiceContext(b.organizationId), {
        limit: 50,
      })
    ).map((candidate) => `${candidate.kind}:${candidate.id}`);
    expect(listed).toEqual(expect.arrayContaining(closed));
    expect(listed).not.toContain(`work_unit:${live.id}`);
    expect(listed.some((key) => key.endsWith(artifactId))).toBe(false);
    // Another tenant's closed records never appear.
    const other = (
      await listRecordPurgeCandidates(app.db, createServiceContext(a.organizationId), {
        limit: 50,
      })
    ).map((candidate) => `${candidate.kind}:${candidate.id}`);
    for (const key of closed) expect(other).not.toContain(key);
    for (const context of [b.owner, b.member])
      await expect(listRecordPurgeCandidates(app.db, context, { limit: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
  });

  it('[ADR028-Q12-L8a] a forged event for a live record purges nothing', async () => {
    const f = await genuineChildWithRecord(),
      service = createServiceContext(a.organizationId);
    // ensemus_app may write a domain event, so a forged one must be inert on its own.
    await withTenantTx(app.db, service, (tx) =>
      emitRecordClosedInTx(tx, service, { kind: 'work_unit', id: f.input.id }),
    );
    const snapshot = () =>
      withTenantTx(app.db, a.owner, async (tx) => ({
        receipts: await tx
          .select()
          .from(delegatedInputReceipts)
          .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
        checkpoints: await tx
          .select()
          .from(runInputCheckpoints)
          .where(eq(runInputCheckpoints.runId, f.runId)),
      }));
    const before = await snapshot();
    const materials = createKnowledgeTranscriptActivities({
      database: agent.db,
      transcripts: createRunTranscriptPurge(),
      delegatedRecords: recordAdapter(),
    });
    const outcome = await materials
      .purgeRecordMaterials({
        organizationId: a.organizationId,
        kind: 'work_unit',
        id: f.input.id,
        limit: 25,
      })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    // A live record has no purge snapshot (ai.lock_record_purge_snapshot is NULL), so the purge refuses
    // with INVALID_STATE before it touches anything.
    expect(outcome).toEqual({ error: expect.objectContaining({ code: 'INVALID_STATE' }) });
    expect(await snapshot()).toEqual(before);
    expect((await getWorkUnit(app.db, a.owner, f.childWorkId)).title).toBe('Actual copied child');
    expect(await dueFor(a.organizationId)).not.toContain(`work_unit:${f.input.id}`);
    // The forged event is older than the record's real closure, so it does not suppress the genuine
    // event and outbox row when the record is really closed later; a repeat for that closure does.
    await withTenantTx(app.db, a.owner, async (tx) => {
      await tx.insert(tombstones).values({
        organizationId: a.organizationId,
        targetType: 'work_unit',
        targetId: f.input.id,
        reasonCode: 'USER_DELETED',
      });
      expect(await emitRecordClosedInTx(tx, a.owner, { kind: 'work_unit', id: f.input.id })).toBe(
        true,
      );
    });
    expect(
      await withTenantTx(app.db, service, (tx) =>
        emitRecordClosedInTx(tx, service, { kind: 'work_unit', id: f.input.id }),
      ),
    ).toBe(false);
    const { events, outbox } = await closedEvents(service, f.input.id);
    expect(events.map((event) => event.aggregateVersion).sort()).toEqual([1, 2]);
    expect(outbox).toEqual(['queued', 'queued']);
  });

  it('[ADR028-Q12-L8a] with the production purge composition, a deleted custom object record never stops the restart claim', async () => {
    const f = await genuineChildWithRecord(),
      owner = await nativeSovereignContext(app.db, a.owner.userId, a.organizationId);
    await closeRecord(f.input.id);
    const type = await createObjectType(app.db, owner, {
      slug: `outbox_${randomUUID().replaceAll('-', '')}`,
      displayName: 'Outbox items',
      classification: 'internal',
      fields: [{ key: 'name', label: 'Name', kind: 'text', required: true, indexed: true }],
      relations: [],
    });
    const record = await createObjectRecord(app.db, owner, {
      typeId: type.id,
      displayName: 'Deleted while a child is pending',
      attributes: { name: 'deleted' },
    });
    await deleteObjectRecord(app.db, owner, {
      recordId: record.id,
      expectedVersion: record.version,
    });
    // Its copied-Work part proves (it has no child material), so the next proof reaches the
    // production generated-file proof, which proves it under its own kind (finding 3: the composite
    // used to refuse object_record, so its purge never completed and every sweep counted it as failed;
    // tests/integration/object-record-purge-sweep.test.ts covers the whole purge).
    const materials = createKnowledgeTranscriptActivities({
      database: agent.db,
      transcripts: createRunTranscriptPurge(),
      delegatedRecords: recordAdapter(),
    });
    expect(
      await materials.purgeRecordMaterials({
        organizationId: a.organizationId,
        kind: 'object_record',
        id: record.id,
        limit: 25,
      }),
    ).toMatchObject({ confirmed: true, remaining: 0 });
    // The knowledge worker's real composition (workers/workflow/src/knowledge-worker.ts), not a stub.
    const store = new LifecycleMemoryStore(),
      guarded = withRawKnowledgeObjects({
        database: app.db,
        store,
        exposedStore: refuseUnadmittedDeletes(store),
      }),
      lifecycle = createObjectDeletionLifecycle({ database: app.db, store });
    // Observed, not replaced: each record whose production proof ran, and the error any proof threw, so
    // the object record's own proof can be checked to have run and thrown nothing.
    const proved: string[] = [],
      thrown = new Map<string, unknown>();
    const observe = async <T>(input: { kind: string; id: string }, proof: () => Promise<T>) => {
      try {
        return await proof();
      } catch (error) {
        thrown.set(`${input.kind}:${input.id}`, error);
        throw error;
      }
    };
    const ports = createKnowledgePurgePorts({
      database: app.db,
      store: guarded,
      derivedLifecycle: lifecycle.derived,
      archiveLifecycle: lifecycle.archive,
    });
    const production = createKnowledgePurgeActivities({
      database: app.db,
      store: guarded,
      ingest: {} as never,
      recordWorks: {
        confirmRecordInTx: (tx, context, input) => {
          proved.push(`${input.kind}:${input.id}`);
          return observe(input, () => confirmRecordWorkPurgeInTx(tx, context, input));
        },
      },
      derivedArtifacts: {
        ...ports.derivedArtifacts,
        confirmRecordInTx: (tx, context, input) =>
          observe(input, () => ports.derivedArtifacts.confirmRecordInTx(tx, context, input)),
      },
    });
    const claim = await production.claimRecordPurgeRestarts({ organizationId: a.organizationId });
    const due = claim.due.map((item) => `${item.kind}:${item.id}`),
      objectKey = `object_record:${record.id}`;
    // The genuine child's closed input is still due. The object record's proof now completes, so it is
    // neither restarted nor a failure: the same proof the claim ran reads completed.
    expect(due).toContain(`work_unit:${f.input.id}`);
    expect(due).not.toContain(objectKey);
    // Finding 2 (round 12): the pass counted no failure for the object record. Its proof ran and threw
    // nothing.
    expect(proved).toContain(objectKey);
    expect(thrown.has(objectKey)).toBe(false);
    // The failure count is fixed by hand from what this file has left in tenant a, not recomputed from
    // the claim's own classification (check finding 10, round 13). Tenant a's only dead or tombstoned
    // typed records here are:
    // - the input of the "sweep claims ... until PostgreSQL proves its purge" case: purged, and that
    //   case's last claim recorded its durable completion (0554), so it is no longer listed. Were it
    //   listed again, its copied-Work proof reads confirmed and its file proof (kind-generic, and the
    //   child wrote no file) reads 0, so it would be neither due nor failed;
    // - the input of the "forged event" case: tombstoned there but never purged, so its copied-Work
    //   proof reads unconfirmed and the claim restarts it (due, not failed), as the sweep case shows;
    // - this case's input f.input: the same, and asserted due above;
    // - the deleted object record: its proof completes (asserted above and below), not failed.
    // Every other closed record of this file belongs to tenant b or to `people`, never listed for a.
    // So no candidate refuses with a code the claim does not restart: a regression of finding 2 would
    // count the object record and make this 1.
    expect(claim.failed).toBe(0);
    expect(
      await production.readRecordPurgeState({
        organizationId: a.organizationId,
        kind: 'object_record',
        id: record.id,
        limit: 25,
      }),
    ).toMatchObject({ state: 'completed', filesRemaining: 0 });
  });
});
