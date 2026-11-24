// LIFE-04 against the real roles and migrations: a tenant holding connections, the organization's and a
// member's own suite connection (ADR-038), reaches ready_for_erasure through the worker's offboarding
// ports, each connection revoked as a person's revoke would leave it, and connection.revoked emitted so
// the connector worker revokes the sealed secrets. The connection guard admits a service revoke only
// while the tenant's offboarding is at that step, and only under the platform worker's own login (0701,
// FLAGGED FOR HUMAN SECURITY REVIEW).
// Generated values only. Written, not yet run: owed to the first stack run.
import { randomUUID } from 'node:crypto';
import {
  createOffboardingConnectionsPort,
  createProcessRunWindDown,
} from '@ensemus/application/saas/offboarding-connections';
import {
  auditEvents,
  connections,
  domainEvents,
  openAppDatabase,
  withTenantTx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import { getOffboarding } from '@ensemus/application/saas/offboarding';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lifecycleTenant } from './saas-lifecycle-fixture';
import { offboardingPorts, readyToErase } from './saas-offboarding-fixture';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';

describe('offboarding revokes every connection (LIFE-04)', () => {
  // The owner starts offboarding through the web login; the platform worker revokes connections.
  const app = openAppDatabase(urls.app()),
    worker = openAppDatabase(urls.worker()),
    auth = new pg.Client({ connectionString: urls.auth() }),
    // Writes connections the way consent and setup leave them, which a service may not.
    superuser = new pg.Client({ connectionString: urls.superuser() });
  beforeAll(async () => {
    await auth.connect();
    await superuser.connect();
  });
  afterAll(async () => {
    await auth.end();
    await superuser.end();
    await app.close();
    await worker.close();
  });

  const ports = () => ({
    ...offboardingPorts(),
    connections: createOffboardingConnectionsPort(),
    windDowns: [createProcessRunWindDown()],
  });

  async function connected() {
    const owner = await lifecycleTenant(app.db, auth);
    const insert = async (ownerMembershipId: string | null) => {
      const id: string = randomUUID();
      await inFixtureTenant(superuser, owner.organizationId, () =>
        superuser.query(
          `insert into integrations.connections
             (organization_id, id, connector_type, display_name, state, granted_scopes, owner_membership_id)
           values ($1, $2, 'google_workspace', 'Generated connection', 'active', $3, $4)`,
          [
            owner.organizationId,
            id,
            ['https://www.googleapis.com/auth/drive.metadata.readonly'],
            ownerMembershipId,
          ],
        ),
      );
      return id;
    };
    const organizationOwned = await insert(null);
    const memberOwned = await insert(owner.membershipId);
    return { owner, ids: [organizationOwned, memberOwned] };
  }

  it('reaches ready_for_erasure with every connection revoked through the ordinary revoke', async () => {
    const { owner, ids } = await connected();
    const ready = await readyToErase(app.db, owner, ports(), worker.db);
    expect((await getOffboarding(app.db, owner))!.state).toBe('ready_for_erasure');
    const service = createServiceContext(owner.organizationId);
    const rows = await withAccountTx(worker.db, service, (tx) =>
      tx.select().from(connections).orderBy(connections.id),
    );
    expect(rows.map((row) => row.state)).toEqual(['revoked', 'revoked']);
    expect(rows.every((row) => row.revokedAt !== null && row.version === 2)).toBe(true);
    const events = await withAccountTx(worker.db, service, (tx) =>
      tx.select().from(domainEvents).where(eq(domainEvents.eventType, 'connection.revoked')),
    );
    expect(events.map((event) => event.aggregateId).sort()).toEqual([...ids].sort());
    expect(events.every((event) => event.actorType === 'system')).toBe(true);
    const audits = await withAccountTx(worker.db, service, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'connection.revoked')),
    );
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.safeReason === 'TENANT_OFFBOARDING')).toBe(true);
    expect(ready.offboardingId).toBeTruthy();
  });

  it('refuses the same service revoke for a tenant that is not offboarding', async () => {
    const { owner, ids } = await connected();
    const service = createServiceContext(owner.organizationId);
    await expect(
      withTenantTx(worker.db, service, (tx) =>
        createOffboardingConnectionsPort().revokeAllInTx(tx, service),
      ),
    ).rejects.toBeTruthy();
    const rows = await withTenantTx(app.db, owner, (tx) =>
      tx.select({ id: connections.id, state: connections.state }).from(connections),
    );
    expect(rows.filter((row) => ids.includes(row.id)).map((row) => row.state)).toEqual([
      'active',
      'active',
    ]);
  });
});
