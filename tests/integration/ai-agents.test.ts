// AGENT-01, AGENT-16, threat SEC-007: publishing as the real roles. A version is fixed for everyone, even
// the roles that could otherwise change anything. Needs the role provisioning step in ADR-028. Written and
// typechecked. It has not been run yet.
import { randomUUID } from 'node:crypto';
import { auditRefusal, createWorkUnit } from '@ensemus/application';
import {
  agentSpecSha256,
  DEFAULT_AGENT_POLICY_VERSION,
  getAgentPolicyVersion,
  getAgentVersion,
  listAgentRegistry,
  listAgentVersions,
  publishAgentVersion,
} from '@ensemus/application/ai-agents';
import { agentSpecV1Schema, type EvaluationReport } from '@ensemus/contracts/ai';
import {
  agentDefinitions,
  agentPublications,
  agentRuns,
  agentVersions,
  auditEvents,
  domainEvents,
  listAuditEvents,
  openAppDatabase,
  outboxEvents,
  policyBundles,
  serviceIdentities,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createAgentContext } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { canonicalJson } from '@ensemus/domain/approval';
import { and, eq, isNull } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAgentTestDatabase,
  seedAiTenant,
  seedQueuedRun,
  sha256Of,
  testAgentSpec,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';

/** A manifest of its own, so that one test's versions never meet another's. */
function freshSpec(overrides: Record<string, unknown> = {}) {
  return testAgentSpec({ id: `brief-${randomUUID().slice(0, 8)}`, ...overrides });
}

function reportFor(
  spec: unknown,
  policyVersion: string,
  overrides: Partial<EvaluationReport> = {},
): EvaluationReport {
  return {
    report_version: 1,
    spec_sha256: agentSpecSha256(agentSpecV1Schema.parse(spec)),
    policy_version: policyVersion,
    suite_ref: 'evaluations/agents/work-brief',
    dataset_version: 'synthetic-1',
    model_label: 'scripted',
    pass_rate: 1,
    cases: 3,
    passed: true,
    scripted_model: true,
    ...overrides,
  };
}

describe('publishing an agent, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let a: AiTenant;
  let b: AiTenant;
  let bundleVersions = 0;

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 2 });
    agent = openAgentTestDatabase();
    // The same name in both, so nothing below can pass by telling them apart by name.
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
  });

  afterAll(async () => {
    await app.close();
    await agent.close();
  });

  const publish = (
    context: TenantContext,
    spec: unknown,
    report: unknown = reportFor(spec, DEFAULT_AGENT_POLICY_VERSION),
    policyVersion = DEFAULT_AGENT_POLICY_VERSION,
  ) => publishAgentVersion(app.db, context, { spec, evaluationReport: report, policyVersion });

  const versionCount = (context: TenantContext) =>
    withTenantTx(app.db, context, async (tx) => (await tx.select().from(agentVersions)).length);

  /** Makes a document the active policy of one tenant, and hands back its version. */
  const activatePolicy = async (tenant: AiTenant, document: unknown) => {
    bundleVersions += 1;
    const version = bundleVersions;
    await withTenantTx(app.db, tenant.owner, async (tx) => {
      await tx.update(policyBundles).set({ active: false }).where(eq(policyBundles.active, true));
      await tx.insert(policyBundles).values({
        organizationId: tenant.organizationId,
        version,
        sha256: sha256Of(JSON.stringify(document)),
        document,
        active: true,
        createdByMembershipId: tenant.owner.membershipId,
      });
    });
    return String(version);
  };

  const clearPolicy = (tenant: AiTenant) =>
    withTenantTx(app.db, tenant.owner, (tx) =>
      tx.update(policyBundles).set({ active: false }).where(eq(policyBundles.active, true)),
    );

  describe('a good publish', () => {
    it('writes the definition, an identity, the version and a publication, together', async () => {
      const spec = freshSpec();
      const view = await publish(a.owner, spec);

      expect(view.version_number).toBe(1);
      expect(view.published_by_membership_id).toBe(a.owner.membershipId);
      expect(view.policy_version).toBe(DEFAULT_AGENT_POLICY_VERSION);

      await withTenantTx(app.db, a.owner, async (tx) => {
        const [definition] = await tx
          .select()
          .from(agentDefinitions)
          .where(eq(agentDefinitions.id, view.definition_id));
        expect(definition?.slug).toBe(spec.id);
        expect(definition?.ownerMembershipId).toBe(a.owner.membershipId);
        const [identity] = await tx
          .select()
          .from(serviceIdentities)
          .where(eq(serviceIdentities.id, definition?.serviceIdentityId ?? ''));
        expect(identity?.status).toBe('active');
        const publications = await tx
          .select()
          .from(agentPublications)
          .where(eq(agentPublications.definitionId, view.definition_id));
        expect(publications.map((row) => [row.versionId, row.activeUntil])).toEqual([
          [view.id, null],
        ]);
      });
    });

    it('stores a spec that still hashes to what the row says, after jsonb has reordered it', async () => {
      const spec = freshSpec();
      const view = await publish(a.owner, spec);
      const [row] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(agentVersions).where(eq(agentVersions.id, view.id)),
      );
      expect(agentSpecSha256(row?.spec)).toBe(view.spec_sha256);
      expect(row?.maxCostMicros).toBe(1_000_000);
    });

    it('keeps the hash of the exact report it was published on', async () => {
      const spec = freshSpec();
      const report = reportFor(spec, DEFAULT_AGENT_POLICY_VERSION);
      const view = await publish(a.owner, spec, report);
      expect(view.evaluation_report_sha256).toBe(sha256Of(canonicalJson(report)));
    });

    it('emits one fact, with IDs and hashes only, and audits it', async () => {
      const spec = freshSpec({ instructions: 'CANARY-INSTRUCTIONS stay out of events and audit' });
      const view = await publish(a.owner, spec);
      await withTenantTx(app.db, a.owner, async (tx) => {
        const events = await tx
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.aggregateId, view.id));
        expect(events.map((event) => event.eventType)).toEqual(['agent_version.published']);
        expect(JSON.stringify(events)).not.toContain('CANARY-INSTRUCTIONS');
        const outbox = await tx
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.eventId, events[0]?.id ?? ''));
        expect(outbox).toHaveLength(1);
        const audit = await tx
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.targetRef, `agent_version:${view.id}`));
        expect(audit.map((row) => [row.action, row.decision, row.actorId])).toEqual([
          ['agent_version.published', 'allow', a.owner.membershipId],
        ]);
        expect(JSON.stringify(audit)).not.toContain('CANARY-INSTRUCTIONS');
      });
    });

    it('never puts the spec in what a reader is shown', async () => {
      const spec = freshSpec({ instructions: 'CANARY-INSTRUCTIONS stay on the row' });
      const view = await publish(a.owner, spec);
      const read = await getAgentVersion(app.db, a.owner, view.id);
      expect(JSON.stringify(read)).not.toContain('CANARY-INSTRUCTIONS');
      expect(read).toEqual(view);
    });

    it('lists what was published, in the page too, marking the one new runs get', async () => {
      const spec = freshSpec();
      const first = await publish(a.owner, spec);
      const nextSpec = { ...spec, version: 2 };
      const second = await publish(a.owner, nextSpec);
      expect((await listAgentVersions(app.db, a.owner)).map((row) => row.id)).toEqual(
        expect.arrayContaining([first.id, second.id]),
      );
      const rows = (await listAgentRegistry(app.db, a.owner)).filter((row) => row.slug === spec.id);
      expect(rows.map((row) => [row.versionNumber, row.active])).toEqual([
        [2, true],
        [1, false],
      ]);
    });
  });

  describe('a version cannot change', () => {
    const ROLES: readonly [string, () => string][] = [
      ['ensemus_app', urls.app],
      ['ensemus_agent', urls.agent],
      ['ensemus_auth', urls.auth],
      ['ensemus_dispatcher', urls.dispatcher],
      ['ensemus_secrets', urls.secrets],
      ['ensemus_migrator', urls.migrator],
      // Above every grant and policy, so only the trigger stands here. That is the point of having both.
      ['the superuser', urls.superuser],
    ];

    const STATEMENTS: readonly [string, string][] = [
      ['UPDATE', `update ai.agent_versions set spec = '{}'::jsonb where id = $1`],
      ['UPDATE of its limit', `update ai.agent_versions set max_cost_micros = 0 where id = $1`],
      ['DELETE', `delete from ai.agent_versions where id = $1`],
    ];

    const asRole = async <T>(url: string, tenant: AiTenant, work: (c: pg.Client) => Promise<T>) => {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(`select set_config('app.organization_id', $1, false)`, [
          tenant.organizationId,
        ]);
        return await work(client);
      } finally {
        await client.end();
      }
    };

    for (const [role, url] of ROLES) {
      for (const [name, statement] of STATEMENTS) {
        it(`refuses ${name} for ${role}`, async () => {
          const view = await publish(a.owner, freshSpec());
          await expect(
            asRole(url(), a, (client) => client.query(statement, [view.id])),
          ).rejects.toThrow();
          const unchanged = await getAgentVersion(app.db, a.owner, view.id);
          expect(unchanged).toEqual(view);
        });
      }

      it(`refuses TRUNCATE for ${role}`, async () => {
        const view = await publish(a.owner, freshSpec());
        await expect(
          asRole(url(), a, (client) => client.query('truncate ai.agent_versions cascade')),
        ).rejects.toThrow();
        expect(await getAgentVersion(app.db, a.owner, view.id)).toEqual(view);
      });
    }

    it('refuses a number that has been used, even for the same spec', async () => {
      const spec = freshSpec();
      await publish(a.owner, spec);
      await expect(publish(a.owner, spec)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('refuses going backwards', async () => {
      const spec = freshSpec({ version: 3 });
      await publish(a.owner, spec);
      await expect(publish(a.owner, { ...spec, version: 2 })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
      });
    });

    it('lets only one of two people publish the same number', async () => {
      const spec = freshSpec();
      const results = await Promise.allSettled([publish(a.owner, spec), publish(a.owner, spec)]);
      const refused = results.filter((result) => result.status === 'rejected');
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'VERSION_CONFLICT',
      });
    });
  });

  describe('a running Work Unit keeps its version', () => {
    it('after a new one is published, and new runs would get the new one', async () => {
      const spec = freshSpec();
      const first = await publish(a.owner, spec);
      const work = await createWorkUnit(app.db, a.owner, {
        title: 'Agent work',
        objective: 'Do it.',
      });
      const [definition] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(agentDefinitions).where(eq(agentDefinitions.id, first.definition_id)),
      );
      const runId = await seedQueuedRun(app.db, a.owner, {
        workUnitId: work.id,
        version: {
          definitionId: first.definition_id,
          serviceIdentityId: definition?.serviceIdentityId ?? '',
          versionId: first.id,
        },
      });

      const second = await publish(a.owner, { ...spec, version: 2 });

      await withTenantTx(app.db, a.owner, async (tx) => {
        const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId));
        expect(run?.agentVersionId).toBe(first.id);
        const active = await tx
          .select()
          .from(agentPublications)
          .where(
            and(
              eq(agentPublications.definitionId, first.definition_id),
              isNull(agentPublications.activeUntil),
            ),
          );
        expect(active.map((row) => row.versionId)).toEqual([second.id]);
      });
      expect(await getAgentVersion(app.db, a.owner, first.id)).toEqual(first);
    });

    it('keeps the same service identity across versions', async () => {
      const spec = freshSpec();
      const first = await publish(a.owner, spec);
      const second = await publish(a.owner, { ...spec, version: 2 });
      expect(second.definition_id).toBe(first.definition_id);
      const identities = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(serviceIdentities)
          .where(eq(serviceIdentities.purpose, `agent:${spec.id}`)),
      );
      expect(identities).toHaveLength(1);
    });
  });

  describe('what the gate refuses, writing nothing', () => {
    const refused = async (attempt: () => Promise<unknown>, code: string) => {
      const before = await versionCount(a.owner);
      await expect(attempt()).rejects.toMatchObject({ code });
      expect(await versionCount(a.owner)).toBe(before);
    };

    it('a schema violation', async () => {
      const spec = { ...freshSpec(), grants_everything: true };
      await refused(
        () => publish(a.owner, spec, reportFor(freshSpec(), DEFAULT_AGENT_POLICY_VERSION)),
        'AGENT_SPEC_INVALID',
      );
    });

    it('an unknown tool in allow', async () => {
      const spec = freshSpec({ tools: { allow: ['web.search'] } });
      await refused(() => publish(a.owner, spec), 'AGENT_SPEC_INVALID');
    });

    it('secrets.*', async () => {
      const spec = freshSpec({ tools: { allow: ['secrets.read'] } });
      await refused(() => publish(a.owner, spec), 'AGENT_SPEC_INVALID');
    });

    it('skills, in M4', async () => {
      const spec = { ...freshSpec(), skills: ['a-skill'] };
      await refused(
        () => publish(a.owner, spec, reportFor(freshSpec(), DEFAULT_AGENT_POLICY_VERSION)),
        'AGENT_SPEC_INVALID',
      );
    });

    it('any delegation, with no policy that allows it', async () => {
      const execution = { ...testAgentSpec().execution, max_delegation_depth: 1 };
      await refused(() => publish(a.owner, freshSpec({ execution })), 'AGENT_SPEC_INVALID');
    });

    it('no report', async () => {
      // Not through the helper: its default would fill the report in.
      await refused(
        () =>
          publishAgentVersion(app.db, a.owner, {
            spec: freshSpec(),
            evaluationReport: undefined,
            policyVersion: DEFAULT_AGENT_POLICY_VERSION,
          }),
        'AGENT_EVALUATION_REQUIRED',
      );
      await refused(() => publish(a.owner, freshSpec(), null), 'AGENT_EVALUATION_REQUIRED');
    });

    it('a failing report', async () => {
      const spec = freshSpec();
      const report = reportFor(spec, DEFAULT_AGENT_POLICY_VERSION, { passed: false });
      await refused(() => publish(a.owner, spec, report), 'AGENT_EVALUATION_REQUIRED');
    });

    it('a report for another spec', async () => {
      const report = reportFor(freshSpec(), DEFAULT_AGENT_POLICY_VERSION);
      await refused(() => publish(a.owner, freshSpec(), report), 'AGENT_EVALUATION_REQUIRED');
    });

    it('a stale report, from before the policy changed', async () => {
      const spec = freshSpec();
      const report = reportFor(spec, DEFAULT_AGENT_POLICY_VERSION);
      const current = await activatePolicy(a, {});
      try {
        await refused(
          () => publish(a.owner, spec, report, DEFAULT_AGENT_POLICY_VERSION),
          'AGENT_EVALUATION_REQUIRED',
        );
        await refused(() => publish(a.owner, spec, report, current), 'AGENT_EVALUATION_REQUIRED');
      } finally {
        await clearPolicy(a);
      }
    });

    it('limits above organization policy', async () => {
      const current = await activatePolicy(a, {
        organization_policy: { agent_limits: { max_model_turns: 2 } },
      });
      try {
        const spec = freshSpec();
        await refused(
          () => publish(a.owner, spec, reportFor(spec, current), current),
          'AGENT_SPEC_INVALID',
        );
      } finally {
        await clearPolicy(a);
      }
    });

    it('anything, against a policy document it cannot read', async () => {
      const current = await activatePolicy(a, {
        organization_policy: { agent_limits: { max_model_turns: 'few' } },
      });
      try {
        const spec = freshSpec();
        await refused(
          () => publish(a.owner, spec, reportFor(spec, current), current),
          'POLICY_DENIED',
        );
      } finally {
        await clearPolicy(a);
      }
    });

    it('takes a policy that allows delegation at its word', async () => {
      const current = await activatePolicy(a, {
        organization_policy: { agent_limits: { max_delegation_depth: 2 } },
      });
      try {
        const execution = { ...testAgentSpec().execution, max_delegation_depth: 2 };
        const spec = freshSpec({ execution });
        const view = await publish(a.owner, spec, reportFor(spec, current), current);
        expect(view.policy_version).toBe(current);
        expect(await getAgentPolicyVersion(app.db, a.owner)).toBe(current);
      } finally {
        await clearPolicy(a);
      }
    });

    it('leaves no definition or identity behind when the gate says no', async () => {
      const spec = freshSpec({ tools: { allow: ['secrets.read'] } });
      await expect(publish(a.owner, spec)).rejects.toMatchObject({ code: 'AGENT_SPEC_INVALID' });
      await withTenantTx(app.db, a.owner, async (tx) => {
        expect(
          await tx.select().from(agentDefinitions).where(eq(agentDefinitions.slug, spec.id)),
        ).toEqual([]);
        expect(
          await tx
            .select()
            .from(serviceIdentities)
            .where(eq(serviceIdentities.purpose, `agent:${spec.id}`)),
        ).toEqual([]);
      });
    });

    it('can be put on the record, with a code and nothing from the spec', async () => {
      await auditRefusal(app.db, a.owner, { code: 'AGENT_SPEC_INVALID', surface: 'api' });
      const audit = await listAuditEvents(app.db, a.owner);
      expect(
        audit.some(
          (row) => row.action === 'access.refused.api' && row.safeReason === 'AGENT_SPEC_INVALID',
        ),
      ).toBe(true);
    });
  });

  describe('who may publish', () => {
    it('not a member', async () => {
      const before = await versionCount(a.owner);
      await expect(publish(a.member, freshSpec())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await versionCount(a.owner)).toBe(before);
    });

    it('not a member reading the registry either', async () => {
      await expect(listAgentVersions(app.db, a.member)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(listAgentRegistry(app.db, a.member)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('not a worker', async () => {
      const service = createServiceContext(a.organizationId);
      await expect(publish(service, freshSpec())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('not an agent, even one whose initiator owns the organization', async () => {
      const context = await createAgentContext(agent.db, {
        organizationId: a.organizationId,
        initiatorMembershipId: a.owner.membershipId,
        agentRunId: randomUUID(),
      });
      expect(context.role).toBe('owner');
      await expect(publish(context, freshSpec())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('not someone whose role changed after their request began', async () => {
      const superuser = new pg.Client({ connectionString: urls.superuser() });
      await superuser.connect();
      const demoted = await seedAiTenant(app.db);
      try {
        await inFixtureTenant(superuser, demoted.organizationId, () =>
          superuser.query(`update org.memberships set role = 'member' where id = $1`, [
            demoted.owner.membershipId,
          ]),
        );
        // The context still says owner, as it would for a request already under way.
        expect(demoted.owner.role).toBe('owner');
        await expect(publish(demoted.owner, freshSpec())).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      } finally {
        await superuser.end();
      }
    });
  });

  describe('between tenants', () => {
    it('refuses a version ID from another tenant, the same as one that does not exist', async () => {
      const view = await publish(a.owner, freshSpec());
      const foreign = await getAgentVersion(app.db, b.owner, view.id).catch(
        (error: unknown) => error,
      );
      const missing = await getAgentVersion(app.db, b.owner, randomUUID()).catch(
        (error: unknown) => error,
      );
      expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
      expect(missing).toMatchObject({ code: 'NOT_FOUND' });
      expect((foreign as Error).message).toBe((missing as Error).message);
    });

    it('does not list another tenant’s versions', async () => {
      const view = await publish(a.owner, freshSpec());
      const listed = await listAgentVersions(app.db, b.owner);
      expect(listed.map((row) => row.id)).not.toContain(view.id);
      const registry = await listAgentRegistry(app.db, b.owner);
      expect(registry.map((row) => row.versionId)).not.toContain(view.id);
    });

    it('lets two tenants use one name, as two separate agents', async () => {
      const spec = freshSpec();
      const inA = await publish(a.owner, spec);
      const inB = await publish(b.owner, spec);
      expect(inB.definition_id).not.toBe(inA.definition_id);
      expect(inB.id).not.toBe(inA.id);
      // Same text, same hash. The hash says what was published, and the row says for whom.
      expect(inB.spec_sha256).toBe(inA.spec_sha256);
    });

    it('takes one tenant’s policy only from that tenant', async () => {
      const current = await activatePolicy(a, {
        organization_policy: { agent_limits: { max_model_turns: 2 } },
      });
      try {
        // Tenant B has no policy, so its limits are the spec's own and its version is the default.
        expect(await getAgentPolicyVersion(app.db, b.owner)).toBe(DEFAULT_AGENT_POLICY_VERSION);
        await expect(publish(b.owner, freshSpec())).resolves.toBeTruthy();
        const spec = freshSpec();
        await expect(
          publish(a.owner, spec, reportFor(spec, current), current),
        ).rejects.toMatchObject({ code: 'AGENT_SPEC_INVALID' });
      } finally {
        await clearPolicy(a);
      }
    });

    it('cannot write a version for another tenant, even by naming it', async () => {
      const view = await publish(a.owner, freshSpec());
      const inA = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(agentVersions).where(eq(agentVersions.id, view.id)),
      );
      await expect(
        withTenantTx(app.db, b.owner, (tx) =>
          tx.insert(agentVersions).values({
            ...inA[0]!,
            id: randomUUID(),
            versionNumber: 99,
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
