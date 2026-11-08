import { randomUUID } from 'node:crypto';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  AppError,
  auditRefusal,
  isAuditedRefusal,
  refusalFromDatabase,
} from '@ensemus/application';
import { getBillingOverview } from '@ensemus/application/saas/subscriptions';
import {
  getTenantStanding,
  provisionTenant,
  setTenantStandingInTx,
  type TenantProvisioningPort,
} from '@ensemus/application/saas/standing';
import type { AgentHaltPort } from '@ensemus/application/saas/ports';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedPlan } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('standing and trusted provisioning', () => {
  const database = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  let owner: TenantContext;
  const actualAgents = createStandingAgentHaltPort();
  const agents: AgentHaltPort = {
    haltTenantAgents: vi.fn(actualAgents.haltTenantAgents),
    releaseTenantAgents: vi.fn(actualAgents.releaseTenantAgents),
  };
  beforeAll(async () => {
    await auth.connect();
    const id = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values ($1,$2,$3)', [
      id,
      'Standing person',
      `${id}@example.invalid`,
    ]);
    const made = await createOrganization(database.db, {
      userId: id,
      name: 'Standing tenant',
      commercialMode: 'byom',
    });
    owner = await resolveTenantContext(database.db, id, made.organizationId);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  it('a web user cannot change standing, even when an owner', async () => {
    await expect(
      withTenantTx(database.db, owner, (tx) =>
        setTenantStandingInTx(
          tx,
          owner,
          {
            to: 'suspended',
            reasonCode: 'TEST_TERMS',
            actor: { type: 'operator', ref: 'test-operator' },
          },
          agents,
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('missing agent binding or a failing halt rolls back lifecycle and its record', async () => {
    const service = createServiceContext(owner.organizationId);
    const input = {
      to: 'read_only' as const,
      reasonCode: 'TEST_TERMS',
      actor: { type: 'operator' as const, ref: 'test-operator' },
    };
    await expect(
      withTenantTx(database.db, service, (tx) =>
        setTenantStandingInTx(tx, service, input, undefined as unknown as AgentHaltPort),
      ),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    await expect(
      withTenantTx(database.db, service, (tx) =>
        setTenantStandingInTx(tx, service, input, {
          ...agents,
          haltTenantAgents: async () => {
            throw new Error('TEST_HALT_FAILED');
          },
        }),
      ),
    ).rejects.toThrow('TEST_HALT_FAILED');
    expect((await getTenantStanding(database.db, owner)).lifecycle).toBe('active');
  });
  it('records first, notifies owners and halts once; account stays readable', async () => {
    const service = createServiceContext(owner.organizationId);
    const input = {
      to: 'suspended' as const,
      reasonCode: 'TEST_TERMS',
      actor: { type: 'operator' as const, ref: 'test-operator' },
    };
    expect(
      await withTenantTx(database.db, service, (tx) =>
        setTenantStandingInTx(tx, service, input, agents),
      ),
    ).toBe('changed');
    expect(
      await withTenantTx(database.db, service, (tx) =>
        setTenantStandingInTx(tx, service, input, agents),
      ),
    ).toBe('unchanged');
    const current = await resolveTenantContext(database.db, owner.userId, owner.organizationId);
    expect(current.serving).toBe('suspended');
    expect(
      (await getBillingOverview(database.db, current, { billingEnabled: true })).lifecycle,
    ).toBe('suspended');
    const counts = await withTenantTx(database.db, service, (tx) =>
      tx.execute(
        sql`select (select count(*)::int from billing.standing_changes) as changes, (select count(*)::int from platform.domain_events where event_type='tenant.standing_changed') as events, (select count(*)::int from platform.notifications where kind='tenant.standing_changed') as notices`,
      ),
    );
    expect(counts.rows[0]).toMatchObject({ changes: 1, events: 1, notices: 1 });
    let refusal: unknown;
    try {
      await withTenantTx(database.db, current, (tx) =>
        tx.execute(sql`update org.organizations set name = name`),
      );
    } catch (error) {
      refusal = refusalFromDatabase(error);
    }
    expect(refusal).toMatchObject({ code: 'TENANT_READ_ONLY' });
    expect(isAuditedRefusal(refusal)).toBe(true);
    // Audit failure in a read-only transaction never grants the original write.
    await auditRefusal(database.db, current, {
      code: (refusal as AppError).code,
      surface: 'web',
    }).catch(() => undefined);
  });
  it('provisioning refuses without a trusted lookup and refuses an unregistered person before tenant writes', async () => {
    const plan = await seedPlan({ mode: 'byom' });
    const input = {
      organizationName: 'Provision test',
      commercialMode: 'byom' as const,
      ownerEmail: 'unregistered@example.invalid',
      planVersionId: plan.planVersionId,
      operatorRef: 'test-operator',
      requestKey: randomUUID(),
    };
    await expect(provisionTenant(database.db, input)).rejects.toMatchObject({
      code: 'PREREQUISITES_INCOMPLETE',
    });
    const commit = vi.fn();
    await expect(
      provisionTenant(database.db, input, {
        prepare: async () => null,
        issueOwnerInvitationInTx: commit,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(commit).not.toHaveBeenCalled();
  });
  it('a failed trusted bootstrap write rolls back tenant, owner and subscription together', async () => {
    const plan = await seedPlan({ mode: 'byom' });
    const organizationId = randomUUID();
    const port: TenantProvisioningPort = {
      prepare: async () => ({
        ownerUserId: owner.userId,
        organizationId,
        ownerMembershipId: randomUUID(),
        capability: randomUUID(),
      }),
      issueOwnerInvitationInTx: async () => {
        throw new AppError('VERSION_CONFLICT');
      },
    };
    await expect(
      provisionTenant(
        database.db,
        {
          organizationName: 'Provision test',
          commercialMode: 'byom',
          ownerEmail: 'existing@example.invalid',
          planVersionId: plan.planVersionId,
          operatorRef: 'test-operator',
          requestKey: randomUUID(),
        },
        port,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(resolveTenantContext(database.db, owner.userId, organizationId)).rejects.toThrow();
    const persisted = await withTenantTx(database.db, createServiceContext(organizationId), (tx) =>
      tx.execute(sql`select count(*)::int as n from org.organizations`),
    );
    expect(persisted.rows[0]).toEqual({ n: 0 });
  });
});
