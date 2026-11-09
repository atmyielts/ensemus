// ADR-028 open question 12, lifecycle items 6 (restricted eraser ordering and positive disposition) and
// 8b (the sealDelegatedErasureInTx offboarding binding, made reachable by the delegated input closure),
// through the operator's real erase command with a genuine delegated child. ensemus_eraser cannot log in,
// so the command is handed a superuser connection that took its session authorization, as
// saas-erasure.test.ts does. Each case erases or offboards its own tenant. The capability is qualified for
// this file through the migrator and restored afterwards. SQL first runs in the CI run after 0548 was journaled.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentContext } from '@ensemus/database/agent';
import { finishRun, purgeEndedRunTranscript } from '@ensemus/application/ai-runs';
import { closeDelegatedRecordInputsInTx } from '@ensemus/application/knowledge/delegated-erasure';
import { createOffboardingAgentHaltPort } from '@ensemus/application/saas/offboarding-agent-port';
import { cancelOffboarding, getOffboarding } from '@ensemus/application/saas/offboarding';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { eraseTenantRows } from '@ensemus/database/eraser';
import { eraseCommand } from '../../workers/workflow/src/ops-erase';
import { recordPurgeStartFor } from '../../workers/workflow/src/record-purge-route';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createKnowledgeTranscriptActivities } from '@ensemus/workflows/knowledge-purge-activities';
import type { KnowledgeRecordPurgeInput } from '@ensemus/workflows/knowledge-schemas';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedAiTenant,
  seedOrganizationBudget,
  seedRateCard,
} from '../helpers/ai/fixtures';
import { nativeSovereignContext } from '../helpers/sovereign';
import { urls } from '../helpers/stack';
import { delegatedChildHarness } from '../helpers/delegated-child';
import { qualifyDelegationForSuite } from '../helpers/delegation-capability';
import { LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { readyToErase } from './saas-offboarding-fixture';

type EraserDb = Parameters<typeof eraseTenantRows>[0];
/** The ten tables 0515's lifecycle.delete_delegated_proof guards, plus the runs themselves. */
const PROOF_TABLES = [
  'ai.run_authority_checkpoints',
  'ai.run_read_authorities',
  'ai.delegated_input_receipts',
  'ai.delegated_work_births',
  'ai.delegated_input_refs',
  'knowledge.artifact_authority_receipts',
  'knowledge.artifact_authority_refs',
  'ai.source_run_closures',
  'ai.record_run_closures',
  'ai.record_purge_jobs',
  'ai.agent_runs',
] as const;

describe('ADR-028 delegated child offboarding (L6, L8b)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4),
    su = new pg.Client({ connectionString: urls.superuser() }),
    eraserClient = new pg.Client({ connectionString: urls.superuser() });
  let eraser: EraserDb, directory: string;
  let capability: Awaited<ReturnType<typeof qualifyDelegationForSuite>> | undefined;
  beforeAll(async () => {
    capability = await qualifyDelegationForSuite('agent-delegated-offboarding');
    await su.connect();
    await eraserClient.connect();
    await eraserClient.query('set session authorization ensemus_eraser');
    eraser = drizzle(eraserClient, { casing: 'snake_case' }) as unknown as EraserDb;
    directory = mkdtempSync(join(tmpdir(), 'ensemus-delegated-offboarding-'));
  });
  afterAll(async () => {
    await capability?.restore();
    rmSync(directory, { recursive: true, force: true });
    await eraserClient.query('reset session authorization');
    await eraserClient.end();
    await su.end();
    await agent.close();
    await app.close();
  });

  /** A fresh sovereign tenant with a genuine delegated child whose parent and child have both ended. */
  async function tenantWithEndedChild() {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      profileId = await seedActiveProfile(app.db, agent.db, tenant.owner),
      rateCardId = await seedRateCard(app.db, tenant.owner, profileId);
    await seedOrganizationBudget(app.db, tenant.owner, 1_000_000);
    const harness = delegatedChildHarness({
      app: app.db,
      agent: agent.db,
      tenant: () => tenant,
      profileId: () => profileId,
      rateCardId: () => rateCardId,
    });
    const f = await harness.genuineChildWithRecord();
    const childContext = await createAgentContext(agent.db, {
      organizationId: tenant.organizationId,
      initiatorMembershipId: tenant.owner.membershipId,
      agentRunId: f.childRunId,
    });
    await finishRun(agent.db, childContext, {
      agentRunId: f.childRunId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    return { tenant, harness, f };
  }
  /** The record inputs the child's receipt names, read as the superuser so offboarding cannot hide them. */
  const recordRefs = async (organizationId: string, childRunId: string) =>
    (
      await su.query<{ kind: string; id: string }>(
        `select distinct ref_kind kind,ref_id id from ai.delegated_input_refs
          where organization_id=$1 and child_run_id=$2
            and ref_kind in ('work_unit','project','client','object_record') order by 1,2`,
        [organizationId, childRunId],
      )
    ).rows;
  const tombstoned = async (organizationId: string, ref: { kind: string; id: string }) =>
    (
      await su.query(
        'select 1 from platform.tombstones where organization_id=$1 and target_type=$2 and target_id=$3',
        [organizationId, ref.kind, ref.id],
      )
    ).rowCount;
  const closedEvents = async (organizationId: string, ref: { kind: string; id: string }) =>
    (
      await su.query(
        `select 1 from platform.domain_events where organization_id=$1 and event_type='knowledge.record_closed'
          and aggregate_type=$2 and aggregate_id=$3`,
        [organizationId, ref.kind, ref.id],
      )
    ).rowCount;
  const seals = async (organizationId: string) =>
    (
      await su.query<{ child_count: string }>(
        'select child_count::text from lifecycle.delegated_erasure_receipts where organization_id=$1',
        [organizationId],
      )
    ).rows;
  let runs = 0;
  /** Every purge start the erase command asked Temporal for (not running here), in order. */
  const started: { workflowType: string; workflowId: string; args: unknown[] }[] = [];
  const recordPurges = {
    workflow: {
      start: async (workflowType: string, options: { workflowId: string; args: unknown[] }) => {
        started.push({ workflowType, workflowId: options.workflowId, args: options.args });
      },
    },
  };
  async function erase(
    ready: { offboardingId: string },
    organizationId: string,
    eraserDb: EraserDb = eraser,
  ) {
    runs += 1;
    const file = join(directory, `input-${runs}.json`),
      report = join(directory, `report-${runs}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        organizationId,
        offboardingId: ready.offboardingId,
        operatorRef: 'test-operator@example.invalid',
      }),
    );
    const code = await eraseCommand(['run', '--file', file, '--report-file', report], {
      store: new LifecycleMemoryStore(),
      agents: createOffboardingAgentHaltPort(),
      recordPurges,
      databases: {
        app: { db: app.db, close: async () => undefined },
        eraser: { db: eraserDb, close: async () => undefined },
      },
    });
    return {
      code,
      // A pending or failed run writes { state, ... }; a finished run writes the ErasureReport.
      report: JSON.parse(readFileSync(report, 'utf8')) as {
        state?: string;
        reasonCode?: string;
        errorCode?: string;
        restarted?: number;
        leftOver?: unknown[];
      },
    };
  }
  /** The knowledge.record_closed outbox rows the closure wrote for one record, as the dispatcher reads them. */
  const closedOutbox = async (organizationId: string, ref: { kind: string; id: string }) =>
    (
      await su.query<{
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        organization_id: string;
        state: string;
      }>(
        `select e.event_type,e.aggregate_type,e.aggregate_id::text,e.organization_id::text,o.state
           from platform.domain_events e join platform.outbox_events o
             on o.organization_id=e.organization_id and o.event_id=e.id
          where e.organization_id=$1 and e.event_type='knowledge.record_closed'
            and e.aggregate_type=$2 and e.aggregate_id=$3`,
        [organizationId, ref.kind, ref.id],
      )
    ).rows;

  it('[ADR028-Q12-L6] [ADR028-Q12-L8b] closes delegated inputs before erasing, seals once the purges prove, then erases', async () => {
    const { tenant, harness, f } = await tenantWithEndedChild(),
      organizationId = tenant.organizationId,
      service = createServiceContext(organizationId);
    const refs = await recordRefs(organizationId, f.childRunId);
    // The parent's own Work and the input Work it read are both inputs of the copied child.
    expect(refs).toEqual(
      expect.arrayContaining([
        { kind: 'work_unit', id: f.work.id },
        { kind: 'work_unit', id: f.input.id },
      ]),
    );
    const ready = await readyToErase(app.db, tenant.owner);
    // Run 1: the closure tombstones every record input and writes its knowledge.record_closed event; the
    // seal cannot hold yet, so the command itself restarts each record's purge (no sweep runs for an
    // offboarding tenant).
    started.length = 0;
    const first = await erase(ready, organizationId);
    expect(first).toEqual({
      code: 1,
      report: { state: 'pending', reasonCode: 'MATERIAL_PURGE_PENDING', restarted: refs.length },
    });
    const expectedStarts = refs.map((ref) => ({
      workflowType: 'knowledgeRecordPurgeWorkflow',
      workflowId: `knowledge-record-purge-${organizationId}-${ref.kind}-${ref.id}`,
      args: [{ organizationId, kind: ref.kind, id: ref.id, limit: 25 }],
    }));
    expect(started).toEqual(expectedStarts);
    for (const ref of refs) {
      expect(await tombstoned(organizationId, ref)).toBe(1);
      expect(await closedEvents(organizationId, ref)).toBe(1);
      // The outbox row the dispatcher consumes routes, through its real route, to the same start.
      const [row] = await closedOutbox(organizationId, ref);
      expect(row?.state).toBe('queued');
      const route = recordPurgeStartFor({
        eventType: row!.event_type,
        aggregateType: row!.aggregate_type,
        aggregateId: row!.aggregate_id,
        organizationId: row!.organization_id,
      });
      expect(route).toEqual({
        workflowType: 'knowledgeRecordPurgeWorkflow',
        input: { organizationId, kind: ref.kind, id: ref.id, limit: 25 },
        workflowId: `knowledge-record-purge-${organizationId}-${ref.kind}-${ref.id}`,
      });
    }
    expect(await seals(organizationId)).toEqual([]);
    expect(
      (
        await su.query<{ n: number }>(
          'select count(*)::integer n from work.work_units where organization_id=$1',
          [organizationId],
        )
      ).rows[0]?.n,
    ).toBeGreaterThan(0);
    // Temporal is not running here, so each started workflow's first Activity (purgeRecordMaterials, on
    // the agent queue) runs by hand with exactly the input the command started it with. The workflow's
    // later file step and the transcript purges belong to the knowledge and agent workers.
    const materials = createKnowledgeTranscriptActivities({
      database: agent.db,
      transcripts: createRunTranscriptPurge(),
      delegatedRecords: harness.recordAdapter(),
    });
    for (const start of started)
      expect(
        await materials.purgeRecordMaterials(start.args[0] as KnowledgeRecordPurgeInput),
      ).toMatchObject({ confirmed: true, remaining: 0, controlsRemaining: 0 });
    for (const runId of [f.childRunId, f.runId])
      expect(await purgeEndedRunTranscript(agent.db, service, { agentRunId: runId })).toBe(
        'purged',
      );
    // Run 2 seals, then its eraser handle fails before any row is removed: the seal persists alone.
    let transactions = 0;
    const failing = new Proxy(eraser as object, {
      get(target, property, receiver) {
        if (property === 'transaction' && ++transactions > 1)
          return async () => {
            throw new Error('TEST_ERASER_CRASH_AFTER_SEAL');
          };
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as EraserDb;
    const crashed = await erase(ready, organizationId, failing);
    expect(crashed.code).toBe(2);
    expect(crashed.report.state).toBe('failed');
    expect(await seals(organizationId)).toEqual([{ child_count: '1' }]);
    // Run 3 resumes from the same witness: no second seal, rows erased, reported. A finished run writes
    // finishErasure's ErasureReport (packages/saas/src/offboarding.ts), which has no `state`: its empty
    // leftOver is what "verified" means (LIFE-04), and the offboarding row itself must then be reported.
    // The report is checked first so a failure names every table left over.
    const resumed = await erase(ready, organizationId);
    expect(resumed.report).toMatchObject({
      schemaVersion: 1,
      organizationId,
      offboardingId: ready.offboardingId,
      leftOver: [],
    });
    expect(resumed.code).toBe(0);
    expect(
      (
        await su.query<{ state: string }>(
          'select state from lifecycle.offboardings where organization_id=$1 and id=$2',
          [organizationId, ready.offboardingId],
        )
      ).rows,
    ).toEqual([{ state: 'reported' }]);
    expect(await seals(organizationId)).toEqual([{ child_count: '1' }]);
    for (const table of PROOF_TABLES)
      expect(
        (
          await su.query<{ n: number }>(
            `select count(*)::integer n from ${table} where organization_id=$1`,
            [organizationId],
          )
        ).rows[0]?.n,
        table,
      ).toBe(0);
  });

  it('[ADR028-Q12-L8b] an active legal hold refuses the closure: no record tombstone and no seal', async () => {
    const { tenant, f } = await tenantWithEndedChild(),
      organizationId = tenant.organizationId;
    const ready = await readyToErase(app.db, tenant.owner),
      owner = await nativeSovereignContext(app.db, tenant.owner.userId, organizationId);
    const hold = await placeLegalHold(app.db, owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    try {
      const held = await erase(ready, organizationId);
      expect(held.code).toBe(2);
      expect(held.report.state).toBe('failed');
      for (const ref of await recordRefs(organizationId, f.childRunId))
        expect(await tombstoned(organizationId, ref)).toBe(0);
      expect(await seals(organizationId)).toEqual([]);
      await expect(
        withTenantTx(app.db, ready.service, (tx) =>
          closeDelegatedRecordInputsInTx(tx, ready.service, ready),
        ),
      ).rejects.toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' });
    } finally {
      await releaseLegalHold(app.db, owner, {
        holdId: hold.holdId,
        reasonCode: 'TEST_CLOSED',
        expectedVersion: 1,
      });
    }
  });

  it('[ADR028-Q12-L8b] once the closure has tombstoned a record input, the offboarding cannot be cancelled', async () => {
    // Positive control: before any closure, the owner can still cancel and service comes back.
    const early = await tenantWithEndedChild(),
      earlyReady = await readyToErase(app.db, early.tenant.owner),
      earlyOwner = await nativeSovereignContext(
        app.db,
        early.tenant.owner.userId,
        early.tenant.organizationId,
      );
    const earlyView = await getOffboarding(app.db, earlyOwner);
    expect(earlyView?.state).toBe('ready_for_erasure');
    await cancelOffboarding(
      app.db,
      earlyOwner,
      { reasonCode: 'TEST_CHANGED_MIND', expectedVersion: earlyView!.version },
      earlyReady.ports.offboardingAgents,
    );
    expect(await getOffboarding(app.db, earlyOwner)).toBeNull();

    const { tenant, f } = await tenantWithEndedChild(),
      organizationId = tenant.organizationId;
    const ready = await readyToErase(app.db, tenant.owner),
      owner = await nativeSovereignContext(app.db, tenant.owner.userId, organizationId);
    const refs = await recordRefs(organizationId, f.childRunId);
    // The closure runs while the offboarding is still ready_for_erasure, before the move to erasing.
    expect(
      await withTenantTx(app.db, ready.service, (tx) =>
        closeDelegatedRecordInputsInTx(tx, ready.service, ready),
      ),
    ).toEqual({ closed: refs.length, more: false, busy: false });
    const view = await getOffboarding(app.db, owner);
    expect(view?.state).toBe('ready_for_erasure');
    await expect(
      cancelOffboarding(
        app.db,
        owner,
        { reasonCode: 'TEST_TOO_LATE', expectedVersion: view!.version },
        ready.ports.offboardingAgents,
      ),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_NOT_CANCELLABLE' });
    // Nothing changed: still ready_for_erasure, the same version, every tombstone kept.
    expect(await getOffboarding(app.db, owner)).toMatchObject({
      state: 'ready_for_erasure',
      version: view!.version,
    });
    for (const ref of refs) expect(await tombstoned(organizationId, ref)).toBe(1);
  });

  it('[ADR028-Q12-L8b] the closure is idempotent: a second page writes no second event', async () => {
    const { tenant, f } = await tenantWithEndedChild(),
      organizationId = tenant.organizationId;
    const ready = await readyToErase(app.db, tenant.owner);
    const close = () =>
      withTenantTx(app.db, ready.service, (tx) =>
        closeDelegatedRecordInputsInTx(tx, ready.service, ready),
      );
    const refs = await recordRefs(organizationId, f.childRunId);
    expect(await close()).toEqual({ closed: refs.length, more: false, busy: false });
    expect(await close()).toEqual({ closed: 0, more: false, busy: false });
    for (const ref of refs) {
      expect(await tombstoned(organizationId, ref)).toBe(1);
      expect(await closedEvents(organizationId, ref)).toBe(1);
    }
    // A service context is required, and a person's context is refused.
    await expect(
      withTenantTx(app.db, tenant.owner, (tx) =>
        closeDelegatedRecordInputsInTx(tx, tenant.owner, ready),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
