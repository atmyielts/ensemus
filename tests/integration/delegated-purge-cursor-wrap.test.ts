// The delegated purges' page cursor wraps (wrapCursorPage, delegated-record-purge.ts), on real
// PostgreSQL and the real app/agent roles. A pass whose step a legal hold refuses still moves its cursor
// past the open rows, so nothing is open after it. The first pass after the release must wrap to the
// start in that same pass and prove the purge there, not reset the cursor and leave the work to a later
// pass. Both adapters are covered: the Knowledge source purge (delegated-work-purge.ts, its run page) and
// the typed-record purge (delegated-record-purge.ts, its run page). Each case reads the persisted cursor
// before the passing pass and shows that no input run lies past it, so the only way that pass can reach
// the run it closes is the wrap. Fixture setup is copied from delegated-work-purge-transcript.test.ts and
// record-deletion-outbox.test.ts, which stay as they are. Synthetic text only: no provider, network or
// object store.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createWorkUnit } from '@ensemus/application';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import { storeStepPayload } from '@ensemus/application/ai-runs';
import { compileEvidence } from '@ensemus/application/knowledge/compiler';
import { createDelegatedWorkPurge } from '@ensemus/application/knowledge/delegated-work-purge';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import { createScriptedModelPort } from '@ensemus/knowledge/testing';
import {
  agentRuns,
  executionSteps,
  knowledgePurgeJobs,
  openAppDatabase,
  recordPurgeJobs,
  sourceRunClosures,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedOrganizationBudget,
  seedQueuedRun,
  seedRateCard,
  testAgentSpec,
  withAdmittedRunTx,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { delegatedChildHarness } from '../helpers/delegated-child';
import { qualifyDelegationForSuite } from '../helpers/delegation-capability';
import { seedSearchableSource } from '../helpers/knowledge';
import { urls } from '../helpers/stack';

describe('the delegated purges wrap their page cursor in the first pass after a refused one', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let a: AiTenant, profileId: string, rateCardId: string;
  let capability: Awaited<ReturnType<typeof qualifyDelegationForSuite>> | undefined;
  beforeAll(async () => {
    // A genuine delegated child (the record case) is born only while the 0548 capability is qualified.
    capability = await qualifyDelegationForSuite('delegated-purge-cursor-wrap');
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    profileId = await seedActiveProfile(app.db, agent.db, a.owner);
    rateCardId = await seedRateCard(app.db, a.owner, profileId);
    await seedOrganizationBudget(app.db, a.owner, 1_000_000);
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

  /** An organization-wide legal hold, placed as its owner places one. The result releases it. */
  async function placeHold(tenant: AiTenant) {
    const holdId = randomUUID();
    await withTenantTx(app.db, tenant.owner, async (tx) => {
      await tx.execute(sql`insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
        values(${tenant.organizationId}::uuid,${holdId}::uuid,${randomUUID()},${tenant.owner.membershipId}::uuid)`);
      await tx.execute(sql`insert into lifecycle.legal_hold_scopes(organization_id,hold_id,scope_type)
        values(${tenant.organizationId}::uuid,${holdId}::uuid,'organization')`);
    });
    return () =>
      withTenantTx(app.db, tenant.owner, (tx) =>
        tx.execute(sql`update lifecycle.legal_holds set status='released',released_by_membership_id=${tenant.owner.membershipId}::uuid,
          released_at=now(),release_reason_code='TEST_RELEASE',version=version+1
          where organization_id=${tenant.organizationId}::uuid and id=${holdId}::uuid`),
      );
  }

  /**
   * As in delegated-work-purge-transcript.test.ts: a live run that really consumed a Knowledge source
   * (the compiler's evidence package names it, so ai.source_input_runs finds it) and holds a private tool
   * output, then the source is revoked. Its own tenant, so the record case's hold never reaches it.
   */
  async function sourceFixture() {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      word = `cursorwrap${randomUUID().replaceAll('-', '')}`;
    const source = await seedSearchableSource(app.db, tenant.owner, {
      passages: [`${word} is genuine compiler material.`],
      grants: [{ kind: 'organization' }],
    });
    const work = await createWorkUnit(app.db, tenant.owner, {
        title: 'Source consumer Work',
        objective: 'Synthetic delegated purge input.',
      }),
      version = await seedAgentVersion(
        app.db,
        tenant.owner,
        testAgentSpec({
          context: {
            allowed_scopes: [
              'work.read',
              'data.internal.read',
              `knowledge.${source.sourceId}.read`,
            ],
            memory_write_policy: 'none',
          },
        }),
      ),
      runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId),
      service = createServiceContext(tenant.organizationId);
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId));
      await tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
    });
    const compiled = await compileEvidence(
      agent.db,
      context,
      {
        model: createScriptedModelPort({
          route: () => ({
            decision: 'deny',
            reasonCode: 'NO_APPROVED_MODEL',
            policyVersion: 'generated-lexical-only',
          }),
        }),
        authorizeAgentContext: async () => true,
      },
      {
        purpose: 'agent_turn',
        question: word,
        queryClassification: 'internal',
        workUnitId: work.id,
        runId,
        sourceIds: [source.sourceId],
        budgetTokens: 1000,
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!compiled.ok) throw new Error(`TEST_COMPILE_REFUSED:${compiled.code}`);
    const stepId = randomUUID();
    await withAdmittedRunTx(agent.db, context, (tx) =>
      tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId,
        stepNumber: 1,
        kind: 'tool_call',
        state: 'in_flight',
        labelCode: 'DRAFTING_ARTIFACT',
      }),
    );
    await storeStepPayload(agent.db, context, {
      stepId,
      kind: 'tool_output',
      classification: 'internal',
      content: `Synthetic private tool output about ${word}`,
    });
    await revokeSource(app.db, tenant.owner, {
      sourceId: source.sourceId,
      expectedVersion: 1,
      reason: 'Synthetic delegated purge cursor wrap.',
    });
    /** The source's input runs, as the adapter's page reads them (agent role, service context). */
    const consumers = (after: string | null) =>
      withTenantTx(agent.db, service, async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`select actual.run_id id from ai.source_input_runs(${source.sourceId}::uuid) actual(run_id)
              where ${after}::uuid is null or actual.run_id>${after}::uuid order by actual.run_id`,
          )
        ).rows.map((row) => row.id),
      );
    const cursor = async () => {
      const [job] = await withTenantTx(agent.db, service, (tx) =>
        tx
          .select({
            sourceVersion: knowledgePurgeJobs.delegatedWorkCursorSourceVersion,
            afterRun: knowledgePurgeJobs.delegatedWorkAfterRun,
            afterChild: knowledgePurgeJobs.delegatedWorkAfterChild,
          })
          .from(knowledgePurgeJobs)
          .where(eq(knowledgePurgeJobs.sourceId, source.sourceId)),
      );
      return job;
    };
    const payloadCount = () =>
      withTenantTx(
        agent.db,
        service,
        async (tx) =>
          (
            await tx.execute<{ count: number }>(
              sql`select count(*)::integer count from ai.step_payloads payload join ai.execution_steps step
                on step.organization_id=payload.organization_id and step.id=payload.step_id
                where step.organization_id=${tenant.organizationId}::uuid and step.run_id=${runId}::uuid`,
            )
          ).rows[0]!.count,
      );
    const closures = () =>
      withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select({ runId: sourceRunClosures.runId })
          .from(sourceRunClosures)
          .where(
            and(
              eq(sourceRunClosures.sourceId, source.sourceId),
              eq(sourceRunClosures.runId, runId),
            ),
          ),
      );
    const works = createDelegatedWorkPurge({
      database: agent.db,
      accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
    });
    const purge = () => works.purgeSource(service, { sourceId: source.sourceId, limit: 25 });
    return { tenant, runId, consumers, cursor, payloadCount, closures, purge };
  }

  it('a source purge pass refused by a hold moves its cursor past the open run; the first pass after the release wraps to it and proves the source', async () => {
    const f = await sourceFixture();
    expect(await f.consumers(null)).toEqual([f.runId]);
    const release = await placeHold(f.tenant);
    try {
      // 0515's barrier refuses the payload DELETE under the hold, so no closure is recorded and the run
      // stays open; the pass still advances its cursor past it.
      expect(await f.purge()).toMatchObject({ confirmed: false, controlsRemaining: 1 });
      expect(await f.cursor()).toMatchObject({ afterRun: f.runId });
      // A pass under the same hold wraps to the run too, and is refused again: the wrap retries the row,
      // it does not get past the hold.
      expect(await f.purge()).toMatchObject({ confirmed: false, controlsRemaining: 1 });
      expect(await f.payloadCount()).toBe(1);
      expect(await f.closures()).toEqual([]);
    } finally {
      await release();
    }
    const before = await f.cursor();
    // The refused passes left the cursor on the run, at the current source version (2, after the revoke).
    expect(before).toEqual({ sourceVersion: 2, afterRun: f.runId, afterChild: null });
    // Nothing is open past it: a page read from the cursor alone finds no row at all.
    expect(await f.consumers(f.runId)).toEqual([]);

    // One pass: it wraps to the start, closes and erases the run, and proves the controls in that pass.
    expect(await f.purge()).toMatchObject({ remaining: 0, controlsRemaining: 0, unproven: 0 });
    expect(await f.payloadCount()).toBe(0);
    expect(await f.closures()).toEqual([{ runId: f.runId }]);
    // It rewound to the start (null) and advanced past the run again, in the same pass.
    expect(await f.cursor()).toEqual(before);
  });

  it('a record purge pass refused by a hold moves its cursor past the open runs; the first pass after the release wraps to them and confirms the record', async () => {
    const f = await genuineChildWithRecord(),
      service = createServiceContext(a.organizationId);
    await closeRecord(f.input.id);
    const purge = () =>
      recordAdapter().purgeRecord(service, { kind: 'work_unit', id: f.input.id, limit: 25 });
    /** The record's input runs, as the adapter's page reads them (agent role, service context). */
    const inputRuns = (after: string | null) =>
      withTenantTx(agent.db, service, async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`select actual.run_id id from ai.record_input_runs('work_unit',${f.input.id}::uuid) actual(run_id)
              where ${after}::uuid is null or actual.run_id>${after}::uuid order by actual.run_id`,
          )
        ).rows.map((row) => row.id),
      );
    /** Every purge job for the record: one per snapshot, so a second row would be a fresh cursor. */
    const cursors = () =>
      withTenantTx(agent.db, service, (tx) =>
        tx
          .select({ afterRun: recordPurgeJobs.afterRun, afterChild: recordPurgeJobs.afterChild })
          .from(recordPurgeJobs)
          .where(
            and(
              eq(recordPurgeJobs.recordKind, 'work_unit'),
              eq(recordPurgeJobs.recordId, f.input.id),
            ),
          ),
      );
    const runs = await inputRuns(null);
    expect(runs).toContain(f.runId);
    const release = await placeHold(a);
    try {
      // The hold refuses each run's transcript erasure (lifecycle.record_purge_hold_free), so no run is
      // closed and the child page is not reached; the run page still advances past every open run.
      expect(await purge()).toMatchObject({ confirmed: false, removed: 0 });
      const held = await purge();
      expect(held).toMatchObject({ confirmed: false, removed: 0 });
      expect(held.controlsRemaining).toBeGreaterThan(0);
    } finally {
      await release();
    }
    const before = await cursors();
    // One job (the snapshot is unchanged), its run cursor on the last input run, its child cursor unused.
    expect(before).toEqual([{ afterRun: runs.at(-1), afterChild: null }]);
    // Nothing is open past it: a page read from the cursor alone finds no row at all.
    expect(await inputRuns(runs.at(-1)!)).toEqual([]);

    // One pass: it wraps to the start, closes every run, redacts the child's copied Work and confirms.
    expect(await purge()).toMatchObject({
      confirmed: true,
      removed: 1,
      remaining: 0,
      controlsRemaining: 0,
      unproven: 0,
    });
    // The same job: its run cursor rewound and advanced past the last run again, in the same pass, and
    // its child page (never refused, so never wrapped) read from the start.
    expect(await cursors()).toEqual([{ afterRun: runs.at(-1), afterChild: f.childRunId }]);
  });
});
