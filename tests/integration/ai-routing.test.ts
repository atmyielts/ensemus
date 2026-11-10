// MODEL-03, COMM-02, SEC-01, QA-009, QA-010, BYOM-TS-01. Routing against the real roles, RLS and triggers, with a
// scripted model. Needs the role provisioning step in ADR-028, and `createProfileStore` from the model-profiles
// slice and the usage slice's ledger is not used here: a double stands in for it, so this file is about routing.
// Written and typechecked. It has not been run yet: no container may run in this mode.
import { randomUUID } from 'node:crypto';
import { createWorkUnit } from '@ensemus/application';
import {
  createEgressLog,
  listEgressDecisions,
  loadTenantPolicyBundle,
} from '@ensemus/application/ai-egress-log';
import { createProfileStore } from '@ensemus/application/ai-model-profiles';
import type { AgentContext, UsageLedger } from '@ensemus/application/ai-ports';
import {
  agentRuns,
  egressDecisions,
  modelProfiles,
  openAppDatabase,
  policyBundles,
  withTenantTx,
} from '@ensemus/database';
import { withRunLookupTx } from '@ensemus/database/agent';
import {
  createInferenceGateway,
  createModelRouter,
  type CompiledTurn,
} from '@ensemus/intelligence';
import { RecordingLender, ScriptedModelAdapter } from '@ensemus/intelligence/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  seedRateCard,
  sha256Of,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';

describe('routing, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let a: AiTenant;
  let b: AiTenant;

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 2 });
    agent = openAgentTestDatabase();
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
  });

  afterAll(async () => {
    await app.close();
    await agent.close();
  });

  /** A queued run for this tenant, and the agent's context for it, re-read as a turn would. */
  async function runFor(
    tenant: AiTenant,
    classification: 'public' | 'internal' | 'confidential' | 'restricted' = 'internal',
  ): Promise<{ runId: string; context: AgentContext; workUnitId: string; versionId: string }> {
    const version = await seedAgentVersion(app.db, tenant.owner);
    const { id: workUnitId } = await createWorkUnit(app.db, tenant.owner, {
      title: 'Agent work',
      objective: 'Do it.',
    });
    const runId = await seedQueuedRun(app.db, tenant.owner, {
      workUnitId,
      version,
      classification,
    });
    const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId);
    return { runId, context, workUnitId, versionId: version.versionId };
  }

  const routerFor = () =>
    createModelRouter({
      profiles: createProfileStore(agent.db),
      egress: createEgressLog(agent.db),
      bundle: (context) => loadTenantPolicyBundle(agent.db, context),
    });

  const taskFor = (runId: string, classification: CompiledTurn['task']['classification']) => ({
    runId,
    purpose: 'reason' as const,
    quality: 'balanced' as const,
    required: ['text' as const],
    classification,
    requiredRegion: null,
    allowFallback: true,
    pinned: null,
  });

  /** Egress is written by the agent role and read by a person with `usage.view`. */
  const rowsFor = (tenant: AiTenant, runId: string) =>
    listEgressDecisions(app.db, tenant.owner, { runId });

  const activeProfile = async (
    tenant: AiTenant,
    overrides: Parameters<typeof seedActiveProfile>[3] = {},
  ) => {
    const id = await seedActiveProfile(app.db, agent.db, tenant.owner, overrides);
    await seedRateCard(app.db, tenant.owner, id);
    return id;
  };

  describe('two tenants, same names', () => {
    it('never offers A’s profile to B', async () => {
      const profileA = await activeProfile(a, { alias: `shared-${randomUUID().slice(0, 8)}` });
      const onlyB = await seedAiTenant(app.db);
      const { runId, context } = await runFor(onlyB);

      const route = await routerFor().select(taskFor(runId, 'internal'), context);
      expect(route).toMatchObject({ kind: 'denied', reasonCode: 'NO_CANDIDATE' });

      const rows = await rowsFor(onlyB, runId);
      expect(rows.map((row) => row.profileId)).toEqual([null]);
      expect(JSON.stringify(rows)).not.toContain(profileA);
    });

    it('a fallback or a pin naming A’s profile finds nothing from B', async () => {
      const profileA = await activeProfile(a);
      const profileB = await activeProfile(b, { fallbackProfileIds: [profileA] });
      const { runId, context } = await runFor(b);

      const route = await routerFor().select(taskFor(runId, 'internal'), context);
      expect(route).toMatchObject({ kind: 'selected', fallbacks: [] });
      expect(route.kind === 'selected' && route.profile.id).toBe(profileB);

      const pinned = await routerFor().select(
        { ...taskFor(runId, 'internal'), pinned: { profileId: profileA, profileVersion: 1 } },
        context,
      );
      expect(pinned).toMatchObject({ kind: 'denied', reasonCode: 'PROFILE_CHANGED' });
    });

    it('one tenant cannot read another’s egress decisions, even with the run’s ID', async () => {
      await activeProfile(a);
      const { runId, context } = await runFor(a);
      await routerFor().select(taskFor(runId, 'internal'), context);
      expect((await rowsFor(a, runId)).length).toBeGreaterThan(0);
      expect(await rowsFor(b, runId)).toEqual([]);
    });
  });

  describe('the log itself', () => {
    it('web cannot write a decision, by grant', async () => {
      const { runId } = await runFor(a);
      await expect(
        withTenantTx(app.db, a.owner, (tx) =>
          tx.insert(egressDecisions).values({
            organizationId: a.organizationId,
            runId,
            dataClass: 'public',
            purpose: 'reason',
            decision: 'allow',
            reasonCode: 'ALLOWED',
            policyVersion: 'forged',
          }),
        ),
      ).rejects.toThrow();
    });

    it('nobody can change or remove a decision', async () => {
      await activeProfile(a);
      const { runId, context } = await runFor(a);
      await routerFor().select(taskFor(runId, 'internal'), context);
      await expect(
        withRunLookupTx(agent.db, a.organizationId, (tx) =>
          tx
            .update(egressDecisions)
            .set({ decision: 'allow' })
            .where(eq(egressDecisions.runId, runId)),
        ),
      ).rejects.toThrow();
      await expect(
        withRunLookupTx(agent.db, a.organizationId, (tx) =>
          tx.delete(egressDecisions).where(eq(egressDecisions.runId, runId)),
        ),
      ).rejects.toThrow();
    });

    it('a run cannot write for another run', async () => {
      const first = await runFor(a);
      const second = await runFor(a);
      await expect(
        createEgressLog(agent.db).record(first.context, {
          runId: second.runId,
          stepId: null,
          profileId: null,
          dataClass: 'public',
          purpose: 'reason',
          destinationHost: null,
          decision: 'deny',
          reasonCode: 'NO_CANDIDATE',
          policyVersion: 'test',
          requestHash: null,
          expiresAt: null,
        }),
      ).rejects.toThrow();
    });

    it('writes an allow only behind the run’s own admission, and still records a closed run’s deny', async () => {
      const tenant = await seedAiTenant(app.db);
      const profileId = await activeProfile(tenant);
      const { runId, context } = await runFor(tenant);
      const entry = (decision: 'allow' | 'deny') => ({
        runId,
        stepId: null,
        profileId: decision === 'allow' ? profileId : null,
        dataClass: 'internal' as const,
        purpose: 'reason' as const,
        destinationHost: null,
        decision,
        reasonCode: decision === 'allow' ? ('ALLOWED' as const) : ('NO_CANDIDATE' as const),
        policyVersion: 'test',
        requestHash: null,
        expiresAt: null,
      });
      // Admitted: 0417's authority_egress_write refuses an allow row for an authority-v1 run unless
      // this transaction holds the run's own admission, which the log now takes for allow rows.
      await expect(createEgressLog(agent.db).record(context, entry('allow'))).resolves.toBe(
        undefined,
      );
      // Closed: the run ends, so it can no longer be admitted. An allow is refused before it is
      // written, and nothing may leave; a deny needs no admission and is still recorded.
      await withRunLookupTx(agent.db, tenant.organizationId, (tx) =>
        tx.update(agentRuns).set({ status: 'cancelled' }).where(eq(agentRuns.id, runId)),
      );
      await expect(createEgressLog(agent.db).record(context, entry('allow'))).rejects.toMatchObject(
        { code: 'POLICY_DENIED' },
      );
      await expect(createEgressLog(agent.db).record(context, entry('deny'))).resolves.toBe(
        undefined,
      );
      const rows = await rowsFor(tenant, runId);
      expect(rows.map((row) => row.decision).sort()).toEqual(['allow', 'deny']);
    });

    it('a plain member cannot read decisions', async () => {
      const { runId } = await runFor(a);
      await expect(listEgressDecisions(app.db, a.member, { runId })).rejects.toThrow();
    });

    it('text that is not a run ID finds nothing, and is no error', async () => {
      expect(await listEgressDecisions(app.db, a.owner, { runId: 'not-a-uuid' })).toEqual([]);
    });
  });

  describe('the whole gateway, with a scripted model', () => {
    const noBudgetCheck: UsageLedger = {
      async headroom() {
        return { availableMicros: 1_000_000 };
      },
      async reserve(_tx, _context, request) {
        return { ok: true, reservationId: randomUUID(), amountMicros: request.amountMicros };
      },
      async settle() {},
      async release() {},
      async record() {
        return true;
      },
      async reconcileRun() {
        return { ledgerMicros: 0, counterMicros: 0, matches: true };
      },
    };

    const compiledFor = (
      runId: string,
      classification: CompiledTurn['task']['classification'],
    ): CompiledTurn => ({
      messages: [{ role: 'task', partId: 'task', text: 'Do the work.', classification }],
      tools: [],
      responseSchema: null,
      task: taskFor(runId, classification),
      requestHash: sha256Of('Do the work.'),
      maxOutputTokens: 100,
      timeoutMs: 1_000,
    });

    const gatewayWith = (adapter: ScriptedModelAdapter, lender: RecordingLender) =>
      createInferenceGateway({
        entitlements: {
          async check() {
            return { ok: true, billable: false, commercialMode: 'byom' };
          },
        },
        ledger: noBudgetCheck,
        withTx: (context, fn) => withTenantTx(agent.db, context, fn),
        router: routerFor(),
        egress: createEgressLog(agent.db),
        guard: {
          fetchFor() {
            return (() => {
              throw new Error('This test reaches no network.');
            }) as unknown as typeof fetch;
          },
        },
        credentials: lender,
        adapter,
        turns: {
          async beginTurn() {
            throw new Error('Not used here.');
          },
          async bindProfile() {},
        },
        halt: {
          async assertRunning() {},
        },
        privateEndpoints: ['http://127.0.0.1:59999'],
        canaries: async () => [],
        bundle: (context) => loadTenantPolicyBundle(agent.db, context),
      });

    const stepFor = (run: { runId: string; workUnitId: string; versionId: string }) => ({
      runId: run.runId,
      stepId: randomUUID(),
      stepNumber: 0,
      attempt: 1,
      workUnitId: run.workUnitId,
      agentVersionId: run.versionId,
    });

    it('QA-010: restricted data and a profile that lists it, but is outside: zero hits, one row, no key', async () => {
      const tenant = await seedAiTenant(app.db);
      await activeProfile(tenant, {
        providerKind: 'openai_compatible',
        endpointUrl: 'https://outside.example.invalid/v1',
        allowedClasses: ['public', 'internal', 'confidential', 'restricted'],
        retentionBasis: 'contract_recorded',
        contractRef: 'contract-record-1',
        region: 'eu',
      });
      const run = await runFor(tenant, 'restricted');
      const adapter = new ScriptedModelAdapter([{ kind: 'final', text: 'Should not happen.' }]);
      const lender = new RecordingLender(Buffer.from('unused'));

      const outcome = await gatewayWith(adapter, lender).turn(
        run.context,
        stepFor(run),
        compiledFor(run.runId, 'restricted'),
        new AbortController().signal,
      );

      expect(outcome).toMatchObject({ outcome: 'policy_denied', decisionCode: 'CLASS_DENIED' });
      expect(adapter.hits).toBe(0);
      expect(lender.asked).toHaveLength(0);
      const rows = await rowsFor(tenant, run.runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decision: 'deny', reasonCode: 'CLASS_DENIED' });
    });

    it('a tenant’s active bundle tightens, through the real read', async () => {
      const tenant = await seedAiTenant(app.db);
      await activeProfile(tenant);
      await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.insert(policyBundles).values({
          organizationId: tenant.organizationId,
          version: 1,
          sha256: sha256Of('bundle'),
          document: { denyClasses: { customer_private_inference: ['internal'] } },
          active: true,
          createdByMembershipId: tenant.owner.membershipId,
        }),
      );
      const { runId, context } = await runFor(tenant);
      const route = await routerFor().select(taskFor(runId, 'internal'), context);
      expect(route).toMatchObject({ kind: 'denied', reasonCode: 'CLASS_DENIED' });
    });

    it('provider access revoked mid-run: the next turn stops, and nothing else is tried', async () => {
      const tenant = await seedAiTenant(app.db);
      const profileId = await activeProfile(tenant);
      await activeProfile(tenant, { alias: `spare-${randomUUID().slice(0, 8)}` });
      const run = await runFor(tenant);
      const adapter = new ScriptedModelAdapter([{ kind: 'final', text: 'Should not happen.' }]);
      const lender = new RecordingLender(Buffer.from('unused'));

      // A person disables the profile between two turns of a run already pinned to it.
      const [before] = await withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .select({ version: modelProfiles.version })
          .from(modelProfiles)
          .where(eq(modelProfiles.id, profileId)),
      );
      await withTenantTx(app.db, tenant.owner, (tx) =>
        tx.update(modelProfiles).set({ status: 'disabled' }).where(eq(modelProfiles.id, profileId)),
      );

      const compiled = compiledFor(run.runId, 'internal');
      const outcome = await gatewayWith(adapter, lender).turn(
        run.context,
        stepFor(run),
        {
          ...compiled,
          task: {
            ...compiled.task,
            pinned: { profileId, profileVersion: before?.version ?? 1 },
          },
        },
        new AbortController().signal,
      );

      expect(outcome.outcome).toBe('policy_denied');
      expect(adapter.hits).toBe(0);
      expect(lender.asked).toHaveLength(0);
      const rows = await rowsFor(tenant, run.runId);
      expect(rows.map((row) => row.decision)).toEqual(['deny']);
    });

    it('BYOM-TS-01: a key attached mid-run moves the version, so the pin no longer holds', async () => {
      const tenant = await seedAiTenant(app.db);
      const profileId = await activeProfile(tenant);
      const run = await runFor(tenant);
      await withTenantTx(app.db, tenant.owner, (tx) =>
        tx
          .update(modelProfiles)
          .set({ modelId: 'another-test-model' })
          .where(eq(modelProfiles.id, profileId)),
      );
      const route = await routerFor().select(
        { ...taskFor(run.runId, 'internal'), pinned: { profileId, profileVersion: 1 } },
        run.context,
      );
      expect(route.kind).toBe('denied');
    });
  });
});
