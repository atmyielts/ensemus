// A refusal in a tenant that is not served in full still goes on the record (ADR-032 D5, NEXT-01).
// Its standing makes every ordinary write fail with 25006, and that guard is asserted unchanged here:
// only the refusal row itself is exempt, and only for a code the refusal audit list accepts.
import { randomUUID } from 'node:crypto';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { auditRefusal, pgCode } from '@ensemus/application';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urls } from '../helpers/stack';

describe('refusal audit in restricted standing', () => {
  const database = openAppDatabase(urls.app());
  const auth = new pg.Client({ connectionString: urls.auth() });
  const agents = createStandingAgentHaltPort();

  const tenant = async (label: string) => {
    const userId = randomUUID();
    await auth.query('insert into identity.users(id,name,email) values ($1,$2,$3)', [
      userId,
      `Refusal ${label}`,
      `${userId}@example.invalid`,
    ]);
    const made = await createOrganization(database.db, {
      userId,
      name: `Refusal ${label}`,
      commercialMode: 'byom',
    });
    return resolveTenantContext(database.db, userId, made.organizationId);
  };

  const setStanding = async (context: TenantContext, to: 'read_only' | 'suspended') => {
    const service = createServiceContext(context.organizationId);
    await withTenantTx(database.db, service, (tx) =>
      setTenantStandingInTx(
        tx,
        service,
        { to, reasonCode: 'TEST_TERMS', actor: { type: 'operator', ref: 'test-operator' } },
        agents,
      ),
    );
    return resolveTenantContext(database.db, context.userId, context.organizationId);
  };

  const refusalRows = async (organizationId: string, code: string) =>
    (
      await withTenantTx(database.db, createServiceContext(organizationId), (tx) =>
        tx.execute<{ organization_id: string; actor_id: string; decision: string }>(
          sql`select organization_id, actor_id, decision from governance.audit_events
              where action = 'access.refused.web' and safe_reason = ${code}`,
        ),
      )
    ).rows;

  beforeAll(async () => {
    await auth.connect();
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });

  it.each(['read_only', 'suspended'] as const)(
    'a refusal in %s standing is audited, once an hour, in that tenant only',
    async (standing) => {
      const restricted = await setStanding(await tenant(standing), standing);
      const bystander = await tenant(`${standing} bystander`);
      expect(restricted.serving).toBe(standing);

      // The standing's own guard is untouched: an ordinary write still fails in PostgreSQL.
      await expect(
        withTenantTx(database.db, restricted, (tx) =>
          tx.execute(sql`update org.organizations set name = name`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '25006');

      expect(
        await auditRefusal(database.db, restricted, { code: 'FORBIDDEN', surface: 'web' }),
      ).toBe(true);
      expect(await refusalRows(restricted.organizationId, 'FORBIDDEN')).toEqual([
        {
          organization_id: restricted.organizationId,
          actor_id: restricted.membershipId,
          decision: 'deny',
        },
      ]);
      // The hourly dedupe still holds on this path, so a flood adds nothing.
      expect(
        await auditRefusal(database.db, restricted, { code: 'FORBIDDEN', surface: 'web' }),
      ).toBe(false);
      expect(await refusalRows(restricted.organizationId, 'FORBIDDEN')).toHaveLength(1);
      // An audit-only code from the same list goes on the record the same way.
      expect(
        await auditRefusal(database.db, restricted, { code: 'FOREIGN_REFERENCE', surface: 'web' }),
      ).toBe(true);
      expect(await refusalRows(restricted.organizationId, 'FOREIGN_REFERENCE')).toHaveLength(1);
      // Nothing reached another tenant.
      expect(await refusalRows(bystander.organizationId, 'FORBIDDEN')).toEqual([]);
    },
  );

  it('the standing answer itself is not an audited refusal and still writes nothing', async () => {
    const restricted = await setStanding(await tenant('read-only answer'), 'suspended');
    await expect(
      auditRefusal(database.db, restricted, { code: 'TENANT_READ_ONLY', surface: 'web' }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '25006');
    // Mistyped input is ordinary and also stays on the read-only path.
    await expect(
      auditRefusal(database.db, restricted, { code: 'INVALID_INPUT', surface: 'web' }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '25006');
    expect(await refusalRows(restricted.organizationId, 'TENANT_READ_ONLY')).toEqual([]);
    expect(await refusalRows(restricted.organizationId, 'INVALID_INPUT')).toEqual([]);
  });

  it('a tenant served in full is audited through withTenantTx as before', async () => {
    const active = await tenant('active');
    expect(active.serving).toBe('full');
    expect(await auditRefusal(database.db, active, { code: 'NOT_FOUND', surface: 'web' })).toBe(
      true,
    );
    expect(await refusalRows(active.organizationId, 'NOT_FOUND')).toEqual([
      { organization_id: active.organizationId, actor_id: active.membershipId, decision: 'deny' },
    ]);
  });
});
