// Requires0511. Actual app/agent roles, native people, current subscriptions and owned SQL stops.
// Source authored only; these cases are not provider or production acceptance.
import { createWorkUnit, disableMember } from '@ensemus/application';
import { engageKillSwitch, createHaltCheck } from '@ensemus/application/ai-halt';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { getSecurityPolicy, updateSecurityPolicy } from '@ensemus/application/security-policy';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import {
  cancelOffboarding,
  getOffboarding,
  requestOffboarding,
} from '@ensemus/application/saas/offboarding';
import { createEntitlements } from '@ensemus/commercial';
import {
  killSwitches,
  interactiveSessionOf,
  openAppDatabase,
  organizations,
  resolveTenantContext,
  standingChanges,
  withTenantTx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  openAgentTestDatabase,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { seedPlan, seedRateCard } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { createSaasPorts } from '../../workers/workflow/src/saas-ports';

const app = openAppDatabase(urls.app()),
  agent = openAgentTestDatabase();
const ports = createSaasPorts({});
const move = (tenant: AiTenant, to: 'active' | 'read_only' | 'suspended', reasonCode: string) => {
  const service = createServiceContext(tenant.organizationId);
  return withAccountTx(app.db, service, (tx) =>
    setTenantStandingInTx(
      tx,
      service,
      {
        to,
        reasonCode,
        actor: { type: 'operator', ref: 'test-operator@example.invalid' },
      },
      ports.agents,
    ),
  );
};
const stops = (tenant: AiTenant) =>
  withRunLookupTx(agent.db, tenant.organizationId, (tx) =>
    tx
      .select({
        id: killSwitches.id,
        reason: killSwitches.reasonCode,
        released: killSwitches.releasedAt,
      })
      .from(killSwitches)
      .where(eq(killSwitches.organizationId, tenant.organizationId)),
  );

afterAll(async () => {
  await agent.close();
  await app.close();
});

describe('standing-owned M4 stops and real entitlement composition', () => {
  it('retains required human MFA while permitting only the actual service standing transition', async () => {
    const tenant = await seedAiTenant(app.db);
    const policy = await getSecurityPolicy(app.db, tenant.owner);
    const nativeSession = interactiveSessionOf(tenant.owner);
    if (!nativeSession) throw new Error('TEST_NATIVE_SESSION_MISSING');
    await updateSecurityPolicy(app.db, tenant.owner, { sessionId: nativeSession.sessionId }, {
      expectedVersion: policy.version, mfaForAdministration: true,
      mfaMaxAgeSeconds: policy.mfaMaxAgeSeconds, ssoEnforcement: policy.ssoEnforcement,
    });
    const plain = await resolveTenantContext(app.db, tenant.owner.userId, tenant.organizationId);
    await expect(withAccountTx(app.db, plain, (tx) => tx.update(organizations)
      .set({ name: 'Unproved rename' }).where(eq(organizations.id, tenant.organizationId))))
      .rejects.toMatchObject({ cause: { code: 'EN405' } });
    await withAccountTx(app.db, tenant.owner, (tx) => tx.update(organizations)
      .set({ name: 'Native MFA rename' }).where(eq(organizations.id, tenant.organizationId)));
    expect(await move(tenant, 'read_only', 'TEST_REQUIRED_MFA_STANDING')).toBe('changed');
    expect((await stops(tenant)).filter((row) => row.reason === 'TENANT_STANDING')).toHaveLength(1);
  });

  it('cannot use a genuine standing birth to change organization fields beside lifecycle', async () => {
    const tenant = await seedAiTenant(app.db), service = createServiceContext(tenant.organizationId);
    await expect(withAccountTx(app.db, service, async (tx) => {
      await tx.insert(standingChanges).values({ organizationId: tenant.organizationId,
        fromLifecycle: 'active', toLifecycle: 'suspended', reasonCode: 'TEST_NO_RENAME',
        actorType: 'operator', actorRef: 'test@example.invalid' });
      expect((await tx.execute(sql`select lifecycle.service_standing_birth(${tenant.organizationId}::uuid,'active','suspended') as allowed`)).rows)
        .toEqual([{ allowed: true }]);
      await tx.update(organizations).set({ lifecycle: 'suspended', name: 'Service must not rename' })
        .where(eq(organizations.id, tenant.organizationId));
    })).rejects.toMatchObject({ cause: { code: 'EN405' } });
    expect(await stops(tenant)).toEqual([]);
    expect(await withTenantTx(app.db, tenant.owner, (tx) => tx.select({ name: organizations.name, lifecycle: organizations.lifecycle }).from(organizations)))
      .toEqual([{ name: 'Same Name Ltd', lifecycle: 'active' }]);
  });

  it('does not turn a forged selector or an actual agent SET ROLE app into standing birth authority', async () => {
    const tenant = await seedAiTenant(app.db);
    await withRunLookupTx(agent.db, tenant.organizationId, async (tx) => {
      await tx.execute(sql`set local role ensemus_app`);
      await tx.execute(sql`select set_config('app.actor_type','service',true),set_config('lifecycle.standing_org',${tenant.organizationId},true)`);
      expect((await tx.execute(sql`select lifecycle.service_standing_birth(${tenant.organizationId}::uuid,'active','read_only') as allowed`)).rows)
        .toEqual([{ allowed: false }]);
    });
    const service = createServiceContext(tenant.organizationId);
    await withAccountTx(app.db, service, async (tx) => {
      await tx.execute(sql`select set_config('lifecycle.standing_org','prior-scope',true)`);
      expect((await tx.execute(sql`select lifecycle.service_standing_birth(${tenant.organizationId}::uuid,'active','read_only') as allowed`)).rows)
        .toEqual([{ allowed: false }]);
      expect((await tx.execute(sql`select current_setting('lifecycle.standing_org',true) as scope`)).rows)
        .toEqual([{ scope: 'prior-scope' }]);
    });
    expect(await stops(tenant)).toEqual([]);
  });

  it('commits one stop for concurrent/repeated standing changes and SQL receipt replay', async () => {
    const tenant = await seedAiTenant(app.db);
    const results = await Promise.all([
      move(tenant, 'read_only', 'TEST_COLLECTION'),
      move(tenant, 'read_only', 'TEST_COLLECTION'),
    ]);
    expect(results.sort()).toEqual(['changed', 'unchanged']);
    const service = createServiceContext(tenant.organizationId);
    await withAccountTx(app.db, service, (tx) =>
      ports.agents.haltTenantAgents(tx, service, 'TEST_COLLECTION'),
    );
    const rows = await stops(tenant);
    expect(rows).toEqual([{ id: expect.any(String), reason: 'TENANT_STANDING', released: null }]);
    await expect(
      withAccountTx(app.db, service, (tx) => createHaltCheck().assertRunning(tx, service, {})),
    ).rejects.toMatchObject({ code: 'AI_HALTED' });
    const counts = await withAccountTx(app.db, service, (tx) =>
      tx.execute(
        sql`select count(*)::int as n from platform.domain_events where event_type='kill_switch.engaged'`,
      ),
    );
    expect(counts.rows).toEqual([{ n: 1 }]);
  });

  it('releases only receipt-owned stops, including when an independent stop uses the same reason', async () => {
    const tenant = await seedAiTenant(app.db);
    const independent = await engageKillSwitch(app.db, tenant.owner, {
      scope: 'organization',
      target_ref: null,
      reason_code: 'TENANT_STANDING',
    });
    await move(tenant, 'read_only', 'TEST_COLLECTION');
    await move(tenant, 'suspended', 'TEST_TERMS');
    await move(tenant, 'active', 'TEST_PAID');
    const rows = await stops(tenant);
    const owned = rows.filter((row) => row.id !== independent.switchId);
    expect(owned).toHaveLength(2);
    expect(owned.every((row) => row.released instanceof Date)).toBe(true);
    expect(rows.find((row) => row.id === independent.switchId)?.released).toBeNull();
    const service = createServiceContext(tenant.organizationId);
    await withAccountTx(app.db, service, (tx) =>
      ports.agents.releaseTenantAgents(tx, service, 'TEST_PAID'),
    );
    expect(
      (await stops(tenant)).find((row) => row.id === independent.switchId)?.released,
    ).toBeNull();
  });

  it('keeps a real offboarding stop separate through cancellation and standing recovery', async () => {
    const tenant = await seedAiTenant(app.db);
    await move(tenant, 'read_only', 'TEST_COLLECTION');
    const started = await requestOffboarding(
      app.db,
      tenant.owner,
      { confirmName: 'Same Name Ltd' },
      ports.offboarding.offboardingAgents,
    );
    const offboardingStop = (await stops(tenant)).find(
      (row) => row.reason === 'TENANT_OFFBOARDING',
    )!;
    expect(offboardingStop.released).toBeNull();
    const service = createServiceContext(tenant.organizationId);
    await expect(
      withAccountTx(app.db, service, (tx) =>
        ports.agents.releaseTenantAgents(tx, service, 'TEST_RECOVERY'),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN850' } });
    expect((await stops(tenant)).find((row) => row.id === offboardingStop.id)?.released).toBeNull();
    const current = await getOffboarding(app.db, tenant.owner);
    expect(current?.id).toBe(started.offboardingId);
    await cancelOffboarding(
      app.db,
      tenant.owner,
      { reasonCode: 'TEST_STAY', expectedVersion: current!.version },
      ports.offboarding.offboardingAgents,
    );
    const cancelled = (await stops(tenant)).find((row) => row.id === offboardingStop.id)!;
    expect(cancelled.released).toBeInstanceOf(Date);
    await move(tenant, 'active', 'TEST_RECOVERY');
    expect((await stops(tenant)).find((row) => row.id === offboardingStop.id)?.released).toEqual(
      cancelled.released,
    );
  });

  it('refuses generic human and actual agent-login release of a standing-owned stop', async () => {
    const tenant = await seedAiTenant(app.db);
    await move(tenant, 'read_only', 'TEST_COLLECTION');
    const stop = (await stops(tenant))[0]!;
    await expect(
      withAccountTx(app.db, tenant.owner, (tx) =>
        tx.update(killSwitches).set({ releasedAt: new Date() }).where(eq(killSwitches.id, stop.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN850' } });
    await expect(
      withRunLookupTx(agent.db, tenant.organizationId, async (tx) => {
        await tx.execute(sql`set local role ensemus_app`);
        await tx.execute(sql`select set_config('app.actor_type','service',true)`);
        await tx
          .update(killSwitches)
          .set({ releasedAt: new Date() })
          .where(eq(killSwitches.id, stop.id));
      }),
    ).rejects.toMatchObject({ cause: { code: 'EN850' } });
    expect((await stops(tenant))[0]!.released).toBeNull();
  });

  it('refuses a foreign or missing transition receipt and restores its private scope', async () => {
    const tenant = await seedAiTenant(app.db),
      other = await seedAiTenant(app.db);
    await move(tenant, 'read_only', 'TEST_COLLECTION');
    const service = createServiceContext(other.organizationId);
    await expect(
      withAccountTx(app.db, service, (tx) =>
        ports.agents.haltTenantAgents(tx, service, 'TEST_COLLECTION'),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN850' } });
    await withAccountTx(app.db, service, async (tx) => {
      await tx.execute(sql`select set_config('lifecycle.standing_org','prior-scope',true)`);
      await expect(
        tx.transaction((save) => ports.agents.haltTenantAgents(save, service, 'TEST_COLLECTION')),
      ).rejects.toMatchObject({ cause: { code: 'EN850' } });
      expect(
        (await tx.execute(sql`select current_setting('lifecycle.standing_org',true) as scope`))
          .rows,
      ).toEqual([{ scope: 'prior-scope' }]);
    });
    expect(await stops(other)).toEqual([]);
    expect((await stops(tenant))[0]!.released).toBeNull();
  });

  it('rolls back a real standing change if the required stop adapter does nothing', async () => {
    const tenant = await seedAiTenant(app.db),
      service = createServiceContext(tenant.organizationId);
    await expect(
      withAccountTx(app.db, service, (tx) =>
        setTenantStandingInTx(
          tx,
          service,
          {
            to: 'suspended',
            reasonCode: 'TEST_NO_STOP',
            actor: { type: 'operator', ref: 'test@example.invalid' },
          },
          { haltTenantAgents: async () => undefined, releaseTenantAgents: async () => undefined },
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN850' } });
    const rows = await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.select({ lifecycle: organizations.lifecycle }).from(organizations),
    );
    expect(rows).toEqual([{ lifecycle: 'active' }]);
    expect(await stops(tenant)).toEqual([]);
  });

  it('does not treat a pre-existing arbitrary standing row as new transition birth', async () => {
    const tenant = await seedAiTenant(app.db),
      service = createServiceContext(tenant.organizationId);
    await withAccountTx(app.db, service, (tx) =>
      tx.insert(standingChanges).values({
        organizationId: tenant.organizationId,
        fromLifecycle: 'active',
        toLifecycle: 'suspended',
        reasonCode: 'TEST_OLD_ROW',
        actorType: 'operator',
        actorRef: 'test@example.invalid',
      }),
    );
    await expect(
      withAccountTx(app.db, service, async (tx) => {
        await tx.execute(
          sql`update org.organizations set lifecycle='suspended' where id=${tenant.organizationId}`,
        );
        await ports.agents.haltTenantAgents(tx, service, 'TEST_OLD_ROW');
      }),
    ).rejects.toMatchObject({ cause: { code: 'EN807' } });
    expect(await stops(tenant)).toEqual([]);
  });

  it('grants no app table read or caller-stamped receipt birth', async () => {
    const tenant = await seedAiTenant(app.db),
      service = createServiceContext(tenant.organizationId);
    await expect(
      withAccountTx(app.db, service, (tx) =>
        tx.execute(sql`select * from lifecycle.standing_stop_receipts`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withAccountTx(app.db, service, (tx) =>
        tx.execute(
          sql`insert into lifecycle.standing_stop_receipts(organization_id,standing_change_id,birth_transaction)
      values(${tenant.organizationId},gen_random_uuid(),pg_current_xact_id()::text)`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('uses actual Cloud/BYOM subscriptions and never grants legacy or disabled capacity', async () => {
    for (const commercialMode of ['cloud', 'byom'] as const) {
      const tenant = await seedAiTenant(app.db, { commercialMode });
      const checker = createEntitlements(app.db, { billingEnabled: true });
      expect(await checker.check(tenant.owner, 'model.call')).toEqual({
        ok: false,
        code: 'ENTITLEMENT_DENIED',
      });
      const plan =
        commercialMode === 'cloud'
          ? await seedPlan({
              mode: 'cloud',
              rateCard: await seedRateCard(),
              features: ['agent.run', 'model.call'],
            })
          : await seedPlan({ mode: 'byom', features: ['agent.run', 'model.call'] });
      await startSubscription(app.db, tenant.owner, plan);
      expect(await checker.check(tenant.member, 'model.call')).toEqual(
        commercialMode === 'cloud'
          ? { ok: false, code: 'ENTITLEMENT_DENIED' }
          : { ok: true, billable: false, commercialMode },
      );
      expect(
        await createEntitlements(app.db, { billingEnabled: false }).check(
          tenant.owner,
          'model.call',
        ),
      ).toEqual({ ok: false, code: 'ENTITLEMENT_DENIED' });
      await move(tenant, 'read_only', 'TEST_COLLECTION');
      expect(await checker.check(tenant.owner, 'model.call')).toEqual({
        ok: false,
        code: 'ENTITLEMENT_DENIED',
      });
    }
  });

  it('rechecks a disabled initiator before granting hosted entitlement', async () => {
    const tenant = await seedAiTenant(app.db);
    await startSubscription(
      app.db,
      tenant.owner,
      await seedPlan({ mode: 'byom', features: ['agent.run'] }),
    );
    const checker = createEntitlements(app.db, { billingEnabled: true });
    expect((await checker.check(tenant.member, 'agent.run')).ok).toBe(true);
    await disableMember(app.db, tenant.owner, { membershipId: tenant.member.membershipId });
    await expect(checker.check(tenant.member, 'agent.run')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('serves exact licensing metadata to an actual M4 agent principal without private financial bodies', async () => {
    const tenant = await seedAiTenant(app.db);
    await startSubscription(
      app.db,
      tenant.owner,
      await seedPlan({ mode: 'byom', features: ['agent.run'] }),
    );
    const version = await seedAgentVersion(app.db, tenant.owner);
    const work = await createWorkUnit(app.db, tenant.owner, {
      title: 'License fixture',
      objective: 'Read current authority',
    });
    const runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const context = await createAgentContext(agent.db, {
      organizationId: tenant.organizationId,
      initiatorMembershipId: tenant.owner.membershipId,
      agentRunId: runId,
    });
    expect(
      await createEntitlements(agent.db, { billingEnabled: true }).check(context, 'agent.run'),
    ).toEqual({ ok: true, billable: false, commercialMode: 'byom' });
    expect(
      (
        await withTenantTx(agent.db, context, (tx) =>
          tx.execute(sql`select * from billing.billing_accounts`),
        )
      ).rows,
    ).toEqual([]);
  });

  it('retains the existing offline Sovereign entitlement port without a hosted subscription', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    expect(
      await createEntitlements(app.db, { billingEnabled: false }).check(tenant.owner, 'model.call'),
    ).toEqual({ ok: true, billable: false, commercialMode: 'sovereign' });
  });
});
