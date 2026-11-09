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
import { urls } from '../helpers/stack';
import { delegatedChildHarness, noObjects } from '../helpers/delegated-child';
import { qualifyDelegationForSuite } from '../helpers/delegation-capability';

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
  /** The knowledge worker's Activities over the app role. Generated files are out of this file's
   * scope (the children here write none), so their proof is a fixed zero, never a skipped check. */
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
    (await knowledge().claimRecordPurgeRestarts({ organizationId })).map(
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
    ).rejects.toBeTruthy();
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

  it('[ADR028-Q12-L8a] an imported client tombstone writes the event once, and a second emit writes nothing', async () => {
    const service = createServiceContext(people.b.organizationId),
      clientId = randomUUID();
    expect(
      await withTenantTx(app.db, service, (tx) =>
        recordImportedTombstone(tx, service, {
          targetType: 'client',
          targetId: clientId,
          deletedAt: new Date(),
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
    if ('result' in outcome) expect(outcome.result).toMatchObject({ confirmed: false, removed: 0 });
    expect(await snapshot()).toEqual(before);
    expect((await getWorkUnit(app.db, a.owner, f.childWorkId)).title).toBe('Actual copied child');
    expect(await dueFor(a.organizationId)).not.toContain(`work_unit:${f.input.id}`);
  });
});
