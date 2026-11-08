import { drizzle } from 'drizzle-orm/node-postgres';
import {
  breakGlassRequests,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
} from '@ensemus/database';
import {
  decideBreakGlass,
  listBreakGlassRequests,
  revokeBreakGlass,
  authorizeBreakGlassAsOperator,
} from '@ensemus/application/saas/break-glass';
import { openTicket } from '@ensemus/application/saas/support';
import { requestBreakGlass } from '@ensemus/application/saas/support-desk';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { urls } from '../helpers/stack';
import { lifecycleArtifact, lifecycleTenant, LifecycleMemoryStore } from './saas-lifecycle-fixture';

describe('break-glass is a bounded consent record, never a content read capability', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() }),
    supportClient = new pg.Client({ connectionString: urls.superuser() }),
    operatorClient = new pg.Client({ connectionString: urls.superuser() });
  let desk: Parameters<typeof requestBreakGlass>[0],
    operator: Parameters<typeof authorizeBreakGlassAsOperator>[0];
  const config = { enabled: true as const, maxMinutes: 3 };
  beforeAll(async () => {
    await auth.connect();
    await supportClient.connect();
    await operatorClient.connect();
    await supportClient.query('set role ensemus_support');
    await operatorClient.query('set role ensemus_operator');
    desk = drizzle(supportClient, { casing: 'snake_case' }) as unknown as typeof desk;
    operator = drizzle(operatorClient, { casing: 'snake_case' }) as unknown as typeof operator;
  });
  afterAll(async () => {
    await supportClient.query('reset role');
    await operatorClient.query('reset role');
    await supportClient.end();
    await operatorClient.end();
    await auth.end();
    await database.close();
  });
  async function requested() {
    const owner = await lifecycleTenant(database.db, auth),
      file = await lifecycleArtifact(database.db, owner, new LifecycleMemoryStore()),
      ticket = await openTicket(database.db, owner, {
        subject: 'Test support request',
        category: 'other',
        body: 'Test context',
      }),
      input = {
        organizationId: owner.organizationId,
        ticketId: ticket.ticketId,
        requestedBy: 'test-requester@example.invalid',
        reasonCode: 'TEST_DIAGNOSIS',
        scopeType: 'artifact' as const,
        scopeId: file.artifactId,
        requestedMinutes: 3,
      };
    const request = await requestBreakGlass(desk, input, config);
    return { owner, file, input, ...request };
  }
  it('refuses to file requests while disabled and denies admins/members or another tenant access to decisions', async () => {
    const who = await requested();
    await expect(requestBreakGlass(desk, who.input, { enabled: false })).rejects.toMatchObject({
      code: 'BREAK_GLASS_DISABLED',
    });
    for (const role of ['admin', 'member'] as const) {
      const person = await lifecycleTenant(database.db, auth);
      await withTenantTx(database.db, who.owner, (tx) =>
        tx
          .insert(memberships)
          .values({ organizationId: who.owner.organizationId, userId: person.userId, role }),
      );
      const context = await resolveTenantContext(
        database.db,
        person.userId,
        who.owner.organizationId,
      );
      await expect(listBreakGlassRequests(database.db, context)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        decideBreakGlass(
          database.db,
          context,
          { requestId: who.requestId, decision: 'authorize', expectedVersion: 1 },
          config,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const other = await lifecycleTenant(database.db, auth);
    await expect(
      decideBreakGlass(
        database.db,
        other,
        { requestId: who.requestId, decision: 'deny', expectedVersion: 1 },
        config,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('one signature is insufficient and a requester cannot counter-sign as operator, including direct constraint tampering', async () => {
    const who = await requested();
    await expect(
      authorizeBreakGlassAsOperator(
        operator,
        {
          organizationId: who.owner.organizationId,
          requestId: who.requestId,
          operatorRef: who.input.requestedBy,
        },
        config,
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'BREAK_GLASS_NOT_AUTHORIZABLE' });
    expect(
      await decideBreakGlass(
        database.db,
        who.owner,
        { requestId: who.requestId, decision: 'authorize', expectedVersion: 1 },
        config,
      ),
    ).toEqual({ state: 'requested', expiresAt: null });
    await expect(
      withTenantTx(database.db, who.owner, (tx) =>
        tx
          .update(breakGlassRequests)
          .set({
            state: 'authorized',
            authorizedFrom: new Date(),
            expiresAt: new Date(Date.now() + 60000),
          })
          .where(eq(breakGlassRequests.id, who.requestId)),
      ),
    ).rejects.toThrow();
  });
  it('the second signature starts expiry, a customer can revoke, and the support role still reads no work', async () => {
    const who = await requested();
    await decideBreakGlass(
      database.db,
      who.owner,
      { requestId: who.requestId, decision: 'authorize', expectedVersion: 1 },
      config,
    );
    const now = new Date(),
      approved = await authorizeBreakGlassAsOperator(
        operator,
        {
          organizationId: who.owner.organizationId,
          requestId: who.requestId,
          operatorRef: 'test-authorizer@example.invalid',
        },
        config,
        now,
      );
    expect(approved).toEqual({
      state: 'authorized',
      expiresAt: new Date(now.getTime() + 3 * 60000),
    });
    await expect(supportClient.query('select name from work.artifacts')).rejects.toMatchObject({
      code: '42501',
    });
    const [current] = await listBreakGlassRequests(database.db, who.owner);
    await revokeBreakGlass(database.db, who.owner, {
      requestId: who.requestId,
      expectedVersion: current!.version,
    });
    expect((await listBreakGlassRequests(database.db, who.owner))[0]!.state).toBe('revoked');
  });
  it('a foreign scope cannot gain customer consent, even when an operator has signed', async () => {
    const who = await requested(),
      other = await lifecycleTenant(database.db, auth),
      foreign = await lifecycleArtifact(database.db, other, new LifecycleMemoryStore());
    const result = await requestBreakGlass(
      desk,
      { ...who.input, scopeId: foreign.artifactId },
      config,
    );
    await authorizeBreakGlassAsOperator(
      operator,
      {
        organizationId: who.owner.organizationId,
        requestId: result.requestId,
        operatorRef: 'test-authorizer@example.invalid',
      },
      config,
      new Date(),
    );
    await expect(
      decideBreakGlass(
        database.db,
        who.owner,
        { requestId: result.requestId, decision: 'authorize', expectedVersion: 2 },
        config,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', auditAs: 'FOREIGN_REFERENCE' });
  });
  it('cannot lengthen the requested or configured period, and expiry holds without a sweep', async () => {
    const who = await requested();
    await expect(
      requestBreakGlass(desk, { ...who.input, requestedMinutes: 4 }, config),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await decideBreakGlass(
      database.db,
      who.owner,
      { requestId: who.requestId, decision: 'authorize', expectedVersion: 1 },
      config,
    );
    const past = new Date(Date.now() - 4 * 60000);
    await withTenantTx(database.db, who.owner, (tx) =>
      tx
        .update(breakGlassRequests)
        .set({ customerAuthorizedAt: new Date(past.getTime() - 1) })
        .where(eq(breakGlassRequests.id, who.requestId)),
    );
    await authorizeBreakGlassAsOperator(
      operator,
      {
        organizationId: who.owner.organizationId,
        requestId: who.requestId,
        operatorRef: 'test-authorizer@example.invalid',
      },
      config,
      past,
    );
    expect((await listBreakGlassRequests(database.db, who.owner))[0]!.state).toBe('expired');
  });
});
