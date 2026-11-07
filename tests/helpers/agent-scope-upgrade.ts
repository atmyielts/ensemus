// Explicit two-phase migration gate. Run seed BEFORE 0414, apply the real migration transaction,
// then assert AFTER it. These helpers never disable a trigger, forge a receipt, or backfill a read.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { addArtifact, createWorkUnit, readArtifact, type ObjectStore } from '@ensemus/application';
import {
  agentRuns,
  knowledgePurgeJobs,
  runInputObservations,
  unprovenChildWorkInputs,
  withTenantTx,
  workUnits,
  type AppDatabase,
} from '@ensemus/database';
import { createAgentContext } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { workInputHash } from '@ensemus/application/ai-input-ledger';
import { pgCode } from '../../packages/application/src/errors';
import { seedAgentVersion, seedAiTenant, seedQueuedRun, testAgentSpec } from './ai/fixtures';
import { seedSearchableSource, knowledgeCanary } from './knowledge';

export async function seedLegacyChildBeforeAgentScopeMigration(
  app: AppDatabase,
  agent: AppDatabase,
) {
  const tenant = await seedAiTenant(app, { commercialMode: 'sovereign' });
  const parentWork = await createWorkUnit(app, tenant.owner, {
    title: knowledgeCanary(),
    objective: 'Generated migration fixture.',
    classification: 'internal',
  });
  const version = await seedAgentVersion(
    app,
    tenant.owner,
    testAgentSpec({
      context: { allowed_scopes: ['data.internal.read'], memory_write_policy: 'none' },
      execution: {
        max_model_turns: 5,
        max_tool_calls: 5,
        max_total_tokens: 10000,
        max_cost_usd: '1',
        timeout_seconds: 60,
        max_delegation_depth: 1,
      },
    }),
  );
  const parentRunId = await seedQueuedRun(app, tenant.owner, {
    workUnitId: parentWork.id,
    version,
    limits: { maxDelegationDepth: 1 },
  });
  const parent = await createAgentContext(agent, {
    organizationId: tenant.organizationId,
    initiatorMembershipId: tenant.owner.membershipId,
    agentRunId: parentRunId,
  });
  const childWorkId = randomUUID(),
    childRunId = randomUUID();
  await withTenantTx(agent, parent, async (tx) => {
    const state = await tx.execute<{ applied: boolean }>(
      sql`select to_regprocedure('ai.run_scope_preflight(uuid)') is not null applied`,
    );
    assert.equal(
      state.rows[0]?.applied,
      false,
      'This fixture requires the genuine pre-0414 schema.',
    );
    const [material] = await tx
      .select({ title: workUnits.title, objective: workUnits.objective })
      .from(workUnits)
      .where(eq(workUnits.id, parentWork.id));
    assert.ok(material);
    // A real read captured at this time, under the old v1 rules; no invented model/provider outcome.
    await tx.insert(runInputObservations).values({
      organizationId: tenant.organizationId,
      runId: parentRunId,
      inputKind: 'work_unit',
      inputId: parentWork.id,
      inputSha256: workInputHash(material),
      classification: 'internal',
    });
    await tx.insert(workUnits).values({
      organizationId: tenant.organizationId,
      id: childWorkId,
      parentId: parentWork.id,
      title: material.title,
      classification: 'internal',
      ownerMembershipId: tenant.owner.membershipId,
      createdByMembershipId: tenant.owner.membershipId,
    });
    await tx.insert(agentRuns).values({
      organizationId: tenant.organizationId,
      id: childRunId,
      workUnitId: childWorkId,
      agentVersionId: version.versionId,
      parentRunId,
      depth: 1,
      initiatorMembershipId: tenant.owner.membershipId,
      serviceIdentityId: version.serviceIdentityId,
      effectiveClassification: 'internal',
      maxModelTurns: 5,
      maxToolCalls: 5,
      maxTotalTokens: 10000,
      maxCostMicros: 1000000,
      timeoutSeconds: 60,
      maxDelegationDepth: 0,
      delegatedScopes: { tools: ['work.read'] },
    });
  });
  const bodies = new Map<string, Buffer>();
  let reads = 0;
  const store: ObjectStore = {
    put: async (key, body) => {
      bodies.set(key, body);
    },
    get: async (key) => {
      reads += 1;
      const body = bodies.get(key);
      if (!body) throw new Error('TEST_OBJECT_MISSING');
      return body;
    },
    delete: async (key) => {
      bodies.delete(key);
    },
    exists: async (key) => bodies.has(key),
  };
  const artifact = await addArtifact(app, store, tenant.owner, {
    workUnitId: childWorkId,
    name: 'legacy-derived.txt',
    mimeType: 'text/plain',
    body: Buffer.from(knowledgeCanary()),
  });
  const source = await seedSearchableSource(app, tenant.owner, {
    passages: ['Generated source for certificate refusal.'],
    grants: [{ kind: 'organization' }],
  });
  return {
    tenant,
    childWorkId,
    childRunId,
    parentRunId,
    artifactId: artifact.id,
    sourceId: source.sourceId,
    store,
    physicalObjects: () => bodies.size,
    reads: () => reads,
  };
}

export async function assertLegacyChildAfterAgentScopeMigration(
  app: AppDatabase,
  agent: AppDatabase,
  f: Awaited<ReturnType<typeof seedLegacyChildBeforeAgentScopeMigration>>,
) {
  await withTenantTx(app, f.tenant.owner, async (tx) => {
    const inventory = await tx
      .select({ id: unprovenChildWorkInputs.workUnitId })
      .from(unprovenChildWorkInputs)
      .where(eq(unprovenChildWorkInputs.workUnitId, f.childWorkId));
    assert.deepEqual(inventory, [{ id: f.childWorkId }]);
    assert.deepEqual(
      await tx
        .select({ title: workUnits.title })
        .from(workUnits)
        .where(eq(workUnits.id, f.childWorkId)),
      [],
    );
    const proof = await tx.execute<{ readable: boolean }>(
      sql`select knowledge.work_scope_readable(${f.childWorkId}::uuid,${f.tenant.owner.membershipId}::uuid) readable`,
    );
    assert.equal(proof.rows[0]?.readable, false);
    const other = await tx.execute<{ readable: boolean }>(
      sql`select knowledge.work_scope_readable(${f.childWorkId}::uuid,${f.tenant.member.membershipId}::uuid) readable`,
    );
    assert.equal(other.rows[0]?.readable, false);
  });
  const before = f.reads();
  await assert.rejects(
    readArtifact(app, f.store, f.tenant.owner, {
      workUnitId: f.childWorkId,
      artifactId: f.artifactId,
    }),
    { code: 'NOT_FOUND' },
  );
  assert.equal(f.reads(), before);
  assert.ok(f.physicalObjects() > 0, 'Serving refusal is not a physical deletion claim.');
  await withTenantTx(app, createServiceContext(f.tenant.organizationId), async (tx) => {
    assert.deepEqual(
      await tx
        .select({ title: workUnits.title })
        .from(workUnits)
        .where(eq(workUnits.id, f.childWorkId)),
      [],
    );
    await assert.rejects(
      tx.transaction((inner) =>
        inner.insert(knowledgePurgeJobs).values({
          organizationId: f.tenant.organizationId,
          sourceId: f.sourceId,
          reason: 'revoked',
          state: 'completed',
        }),
      ),
      (error: unknown) => pgCode(error) === 'EN119',
    );
  });
  const child = await createAgentContext(agent, {
    organizationId: f.tenant.organizationId,
    initiatorMembershipId: f.tenant.owner.membershipId,
    agentRunId: f.childRunId,
  });
  await withTenantTx(agent, child, async (tx) => {
    assert.deepEqual(
      await tx
        .select({ title: workUnits.title })
        .from(workUnits)
        .where(
          and(
            eq(workUnits.id, f.childWorkId),
            eq(workUnits.organizationId, f.tenant.organizationId),
          ),
        ),
      [],
    );
    assert.equal(
      (
        await tx.execute<{ ready: boolean }>(
          sql`select ai.delegation_influence_ready(${f.parentRunId}::uuid,${f.childRunId}::uuid) ready`,
        )
      ).rows[0]?.ready,
      false,
    );
  });
}
