import { randomUUID } from 'node:crypto';
import {
  connections,
  domainEvents,
  memberships,
  offboardings,
  openAppDatabase,
  organizations,
  resolveTenantContext,
  withTenantTx,
  workUnits,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import {
  advanceOffboarding,
  beginErasure,
  cancelOffboarding,
  getOffboarding,
  requestOffboarding,
} from '@ensemus/application/saas/offboarding';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { placeLegalHold } from '@ensemus/application/saas/legal-holds';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lifecycleArtifact, lifecycleTenant, LifecycleMemoryStore } from './saas-lifecycle-fixture';
import { offboardingPorts, readyToErase } from './saas-offboarding-fixture';
import { urls } from '../helpers/stack';
describe('owner-authorized offboarding preserves independent restrictions and uncertain effects', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => {
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  it('denies admins, members and cross-tenant IDs before changing standing', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      ports = offboardingPorts();
    for (const role of ['admin', 'member'] as const) {
      const person = await lifecycleTenant(database.db, auth);
      await withTenantTx(database.db, owner, (tx) =>
        tx
          .insert(memberships)
          .values({ organizationId: owner.organizationId, userId: person.userId, role }),
      );
      const context = await resolveTenantContext(database.db, person.userId, owner.organizationId);
      await expect(
        requestOffboarding(
          database.db,
          context,
          { confirmName: 'Same lifecycle name' },
          ports.offboardingAgents,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        cancelOffboarding(
          database.db,
          context,
          { reasonCode: 'TEST_CANCEL', expectedVersion: 1 },
          ports.offboardingAgents,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(getOffboarding(database.db, context)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    const started = await requestOffboarding(
        database.db,
        owner,
        { confirmName: 'Same lifecycle name' },
        ports.offboardingAgents,
      ),
      other = await lifecycleTenant(database.db, auth);
    await expect(
      advanceOffboarding(database.db, createServiceContext(other.organizationId), ports, {
        offboardingId: started.offboardingId,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('wrong exact name or an absent owned halt binding writes nothing', async () => {
    const owner = await lifecycleTenant(database.db, auth);
    await expect(
      requestOffboarding(
        database.db,
        owner,
        { confirmName: 'same lifecycle name' },
        offboardingPorts().offboardingAgents,
      ),
    ).rejects.toMatchObject({ code: 'OFFBOARDING_CONFIRMATION_MISMATCH' });
    await expect(
      requestOffboarding(database.db, owner, { confirmName: 'Same lifecycle name' }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    expect(
      await withTenantTx(database.db, owner, (tx) => tx.select().from(offboardings)),
    ).toHaveLength(0);
    expect(
      (await withTenantTx(database.db, owner, (tx) => tx.select().from(organizations)))[0]!
        .lifecycle,
    ).toBe('active');
  });
  it('concurrent requests share one halt and cancel restores only the recorded standing', async () => {
    for (const prior of ['active', 'read_only', 'suspended'] as const) {
      const owner = await lifecycleTenant(database.db, auth),
        service = createServiceContext(owner.organizationId),
        halts = new Set(['budget:test', 'provider:test']),
        agents = {
          haltOffboardingAgents: vi.fn(async (_tx: Tx, _ctx: TenantContext, id: string) => {
            halts.add(`offboarding:${id}`);
          }),
          releaseOffboardingAgents: vi.fn(async (_tx: Tx, _ctx: TenantContext, id: string) => {
            halts.delete(`offboarding:${id}`);
          }),
        };
      if (prior !== 'active')
        await withAccountTx(database.db, service, (tx) =>
          setTenantStandingInTx(
            tx,
            service,
            {
              to: prior,
              reasonCode: 'TEST_EXISTING_RESTRICTION',
              actor: { type: 'operator', ref: 'test-operator@example.invalid' },
            },
            { haltTenantAgents: async () => undefined, releaseTenantAgents: async () => undefined },
          ),
        );
      const [first, second] = await Promise.all([
        requestOffboarding(database.db, owner, { confirmName: 'Same lifecycle name' }, agents),
        requestOffboarding(database.db, owner, { confirmName: 'Same lifecycle name' }, agents),
      ]);
      expect(first.offboardingId).toBe(second.offboardingId);
      expect(agents.haltOffboardingAgents).toHaveBeenCalledTimes(1);
      await expect(
        withAccountTx(database.db, service, (tx) =>
          setTenantStandingInTx(
            tx,
            service,
            {
              to: 'read_only',
              reasonCode: 'TEST_BYPASS',
              actor: { type: 'operator', ref: 'test-operator@example.invalid' },
            },
            { haltTenantAgents: async () => undefined, releaseTenantAgents: async () => undefined },
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
      const current = (await getOffboarding(database.db, owner))!;
      await cancelOffboarding(
        database.db,
        owner,
        { reasonCode: 'TEST_STAY', expectedVersion: current.version },
        agents,
      );
      expect(halts).toEqual(new Set(['budget:test', 'provider:test']));
      expect(agents.releaseOffboardingAgents).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({ organizationId: owner.organizationId }),
        first.offboardingId,
      );
      expect(
        (await withAccountTx(database.db, service, (tx) => tx.select().from(organizations)))[0]!
          .lifecycle,
      ).toBe(prior);
      const events = await withAccountTx(database.db, service, (tx) =>
        tx.select().from(domainEvents),
      );
      const restored = events.filter(
        (event) =>
          event.eventType === 'tenant.standing_changed' &&
          (event.payload as { reason_code?: string }).reason_code === 'OFFBOARDING_CANCELLED',
      );
      expect(restored).toHaveLength(1);
      expect((restored[0]!.payload as { to: string }).to).toBe(prior);
    }
  });
  it('refusing export or missing trusted connection revocation cannot fabricate completed steps', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      service = createServiceContext(owner.organizationId),
      ports = offboardingPorts(),
      started = await requestOffboarding(
        database.db,
        owner,
        { confirmName: 'Same lifecycle name' },
        ports.offboardingAgents,
      );
    ports.exports = {
      latestExport: async () => {
        throw new Error('TEST_EXPORT_UNAVAILABLE');
      },
    };
    await expect(
      advanceOffboarding(database.db, service, ports, {
        offboardingId: started.offboardingId,
        now: new Date(),
      }),
    ).rejects.toThrow('TEST_EXPORT_UNAVAILABLE');
    expect((await getOffboarding(database.db, owner))!.exportOfferedAt).toBeNull();
    await withAccountTx(database.db, service, (tx) =>
      tx.insert(connections).values({
        organizationId: owner.organizationId,
        connectorType: 'test_connector',
        displayName: 'Same connection',
        config: {},
        state: 'active',
      }),
    );
    ports.exports = { latestExport: async () => null };
    await advanceOffboarding(database.db, service, ports, {
      offboardingId: started.offboardingId,
      now: new Date(),
    });
    const { setTransitionEnd } = await import('@ensemus/application/saas/offboarding');
    await setTransitionEnd(database.db, service, {
      offboardingId: started.offboardingId,
      operatorRef: 'test-operator@example.invalid',
      transitionEndsAt: new Date(Date.now() - 1000),
    });
    await advanceOffboarding(database.db, service, ports, {
      offboardingId: started.offboardingId,
      now: new Date(),
    });
    await expect(
      advanceOffboarding(database.db, service, ports, {
        offboardingId: started.offboardingId,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
    expect(
      (await withAccountTx(database.db, service, (tx) => tx.select().from(offboardings)))[0]!
        .connectionsRevokedAt,
    ).toBeNull();
  });
  it('ready for erasure stops before deletion, preserves manual work, and a hold refuses the operator', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      file = await lifecycleArtifact(database.db, owner, new LifecycleMemoryStore()),
      ready = await readyToErase(database.db, owner);
    expect((await getOffboarding(database.db, owner))!.state).toBe('ready_for_erasure');
    expect(
      (
        await withAccountTx(database.db, ready.service, (tx) =>
          tx.select().from(workUnits).where(eq(workUnits.id, file.workUnitId)),
        )
      )[0]!.status,
    ).toBe('queued');
    await placeLegalHold(database.db, owner, {
      matterRef: randomUUID(),
      scopes: [{ type: 'organization', id: null }],
    });
    await expect(
      beginErasure(database.db, ready.service, {
        offboardingId: ready.offboardingId,
        operatorRef: 'test-operator@example.invalid',
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' });
  });
});
