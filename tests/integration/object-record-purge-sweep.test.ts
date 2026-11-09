// ADR-028 open question 12, lifecycle item 8a: a deleted custom object record's typed-record purge.
// deleteObjectRecord writes knowledge.record_closed, so every deletion starts knowledgeRecordPurgeWorkflow
// and the record stays a sweep candidate. The production generated-file proof used to refuse the kind
// (INVALID_INPUT), so the purge never completed and every 15-minute sweep re-proved the record, taking
// the organization row lock (lifecycle.record_purge_hold_free, 0514) each time. Now the record is proved
// under its own kind: its copied Work first, then the generated and archive file proofs. Real app/agent
// roles and the knowledge worker's production purge composition. Temporal is not running here, so the
// workflow's steps are driven in process through runRecordPurge, as the workflow itself drives them.
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
import { openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
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
  /** The knowledge worker's composition (workers/workflow/src/knowledge-worker.ts), not a stub. */
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
      recordWorks: { confirmRecordInTx: confirmRecordWorkPurgeInTx },
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

  it('[ADR028-Q12-L8a] completes the purge of a deleted custom object record, and the sweep stops restarting it', async () => {
    const record = await objectRecord();
    await deleteObjectRecord(app.db, owner, {
      recordId: record.id,
      expectedVersion: record.version,
    });
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

    // Two later sweeps neither restart it nor count it as a failure, and it ranks as proved.
    for (let pass = 0; pass < 2; pass++) {
      const claim = await production().claimRecordPurgeRestarts({
        organizationId: tenant.organizationId,
      });
      expect({ due: keyed(claim.due), failed: claim.failed }).toEqual({ due: [], failed: 0 });
    }
    expect(await listed()).toEqual([{ kind: 'object_record', id: record.id, checked: true }]);
    expect(await production().readRecordPurgeState(input)).toMatchObject({
      state: 'completed',
      filesRemaining: 0,
    });
  });
});
