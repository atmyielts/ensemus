import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  memberships,
  organizations,
  openAppDatabase,
  resolveTenantContext,
  ticketMessages,
  tickets,
  withTenantTx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { createServiceContext } from '@ensemus/database/service';
import {
  closeTicket,
  getPublishedCoverage,
  getTicket,
  listTickets,
  openTicket,
  replyToTicket,
  supportContentWritable,
} from '@ensemus/application/saas/support';
import {
  getDeskTicket,
  listDeskQueue,
  replyAsDesk,
  SupportContentBusy,
} from '@ensemus/application/saas/support-desk';
import { setTenantStandingInTx } from '@ensemus/application/saas/standing';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRole, TEST_OPERATOR } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { lifecycleTenant } from './saas-lifecycle-fixture';
import { readyToErase } from './saas-offboarding-fixture';
import { beginErasure } from '@ensemus/application/saas/offboarding';
import { sql } from 'drizzle-orm';

describe('support reads only what a customer deliberately supplies', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() }),
    supportClient = new pg.Client({ connectionString: urls.superuser() });
  let desk: Parameters<typeof listDeskQueue>[0];
  beforeAll(async () => {
    await auth.connect();
    await supportClient.connect();
    await supportClient.query('set role ensemus_support');
    desk = drizzle(supportClient, { casing: 'snake_case' }) as unknown as Parameters<
      typeof listDeskQueue
    >[0];
  });
  afterAll(async () => {
    await supportClient.query('reset role');
    await supportClient.end();
    await auth.end();
    await database.close();
  });
  it('SEC-011: the support role cannot read customer-content or identity schemas', async () => {
    for (const relation of [
      'work.work_units',
      'integrations.connections',
      'secrets.sealed_secrets',
      'org.organizations',
      'identity.users',
      'billing.invoices',
    ])
      await expect(
        asRole('ensemus_support', (client) => client.query(`select * from ${relation}`)),
      ).rejects.toMatchObject({ code: '42501' });
  });
  it('fences customer and actual desk-role content writes at erasing while retaining account reads', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      other = await lifecycleTenant(database.db, auth),
      first = await openTicket(database.db, owner, {
        subject: 'Before erasure',
        category: 'other',
        body: 'Generated original message',
      }),
      second = await openTicket(database.db, other, {
        subject: 'Other tenant',
        category: 'other',
        body: 'Generated other message',
      }),
      ready = await readyToErase(database.db, owner);
    await beginErasure(database.db, ready.service, {
      offboardingId: ready.offboardingId,
      operatorRef: TEST_OPERATOR,
    });
    expect(await supportContentWritable(database.db, owner)).toBe(false);
    expect(await supportContentWritable(database.db, other)).toBe(true);
    for (const operation of [
      () =>
        openTicket(database.db, owner, {
          subject: 'Late ticket',
          category: 'other',
          body: 'Must not be inserted',
        }),
      () =>
        replyToTicket(database.db, owner, {
          ticketId: first.ticketId,
          body: 'Late reply',
          expectedVersion: 1,
        }),
      () => closeTicket(database.db, owner, { ticketId: first.ticketId, expectedVersion: 1 }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await getTicket(database.db, owner, first.ticketId)).messages).toHaveLength(1);
    expect(
      (await listTickets(database.db, owner)).some((ticket) => ticket.id === first.ticketId),
    ).toBe(true);
    await expect(
      replyAsDesk(desk, {
        organizationId: owner.organizationId,
        ticketId: first.ticketId,
        agentRef: TEST_OPERATOR,
        body: 'Late desk reply',
      }),
    ).rejects.toMatchObject({ cause: { code: '25006' } });
    // 0532: the birth fence binds every support-content writer, the desk included, to its tenant.
    const lateDirect = (bound?: string) =>
      asRole(
        'ensemus_support',
        (connection) =>
          connection.query(
            "insert into support.ticket_messages(organization_id,ticket_id,author_kind,author_ref,body) values($1,$2,'support',$3,'Late direct reply')",
            [owner.organizationId, first.ticketId, TEST_OPERATOR],
          ),
        bound ? { organizationId: bound } : {},
      );
    await expect(lateDirect()).rejects.toMatchObject({
      code: '42501',
      message: 'INVALID_ERASURE_BIRTH_TENANT',
    });
    await expect(lateDirect(other.organizationId)).rejects.toMatchObject({
      code: '42501',
      message: 'INVALID_ERASURE_BIRTH_TENANT',
    });
    await expect(lateDirect(owner.organizationId)).rejects.toMatchObject({
      code: '25006',
      message: 'SUPPORT_CONTENT_ERASURE_FENCED',
    });
    await expect(
      withAccountTx(database.db, owner, (tx) =>
        tx.execute(
          sql`update support.tickets set status='closed' where id=${first.ticketId}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '25006' } });
    // Binding the message to an open tenant cannot relabel a different tenant's ticket.
    await expect(
      asRole(
        'ensemus_support',
        (connection) =>
          connection.query(
            "insert into support.ticket_messages(organization_id,ticket_id,author_kind,author_ref,body) values($1,$2,'support',$3,'Wrong tenant')",
            [other.organizationId, first.ticketId, TEST_OPERATOR],
          ),
        { organizationId: other.organizationId },
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await replyAsDesk(desk, {
      organizationId: other.organizationId,
      ticketId: second.ticketId,
      agentRef: TEST_OPERATOR,
      body: 'Other tenant still served',
    });
    expect((await getTicket(database.db, other, second.ticketId)).messages).toHaveLength(2);
  });
  it('NOWAIT breaks the ticket-to-org inverse lock order and restores private/caller bindings', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      opened = await openTicket(database.db, owner, {
        subject: 'Contention test',
        category: 'other',
        body: 'Original',
      }),
      sentinelOrg = randomUUID(),
      sentinelUser = randomUUID(),
      sentinelFence = randomUUID();
    await withAccountTx(database.db, owner, async (tx) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, owner.organizationId))
        .for('no key update');
      await expect(
        replyAsDesk(desk, {
          organizationId: owner.organizationId,
          ticketId: opened.ticketId,
          agentRef: TEST_OPERATOR,
          body: 'Contended',
        }),
      ).rejects.toBeInstanceOf(SupportContentBusy);
      await asRole('ensemus_support', async (connection) => {
        await connection.query(
          "select set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),set_config('support.write_fence_org',$3,true)",
          [sentinelOrg, sentinelUser, sentinelFence],
        );
        await connection.query('savepoint busy_write');
        await expect(
          connection.query(
            "update support.tickets set status='waiting_on_customer' where organization_id=$1 and id=$2",
            [owner.organizationId, opened.ticketId],
          ),
        ).rejects.toMatchObject({ code: 'EN807' });
        await connection.query('rollback to savepoint busy_write');
        const { rows } = await connection.query(
          "select current_setting('app.organization_id') as org,current_setting('app.user_id') as person,current_setting('support.write_fence_org') as fence",
        );
        expect(rows[0]).toEqual({ org: sentinelOrg, person: sentinelUser, fence: sentinelFence });
      });
    });
    await asRole('ensemus_support', async (connection) => {
      await connection.query(
        "select set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),set_config('support.write_fence_org',$3,true)",
        [sentinelOrg, sentinelUser, sentinelFence],
      );
      // 0532: a desk birth bound to any tenant other than the row's own is refused.
      await connection.query('savepoint misbound_write');
      await expect(
        connection.query(
          "insert into support.ticket_messages(organization_id,ticket_id,author_kind,author_ref,body) values($1,$2,'support',$3,'Misbound')",
          [owner.organizationId, opened.ticketId, TEST_OPERATOR],
        ),
      ).rejects.toMatchObject({ code: '42501', message: 'INVALID_ERASURE_BIRTH_TENANT' });
      await connection.query('rollback to savepoint misbound_write');
      await connection.query("select set_config('app.organization_id',$1,true)", [
        owner.organizationId,
      ]);
      await connection.query(
        "insert into support.ticket_messages(organization_id,ticket_id,author_kind,author_ref,body) values($1,$2,'support',$3,'After lock release')",
        [owner.organizationId, opened.ticketId, TEST_OPERATOR],
      );
      const { rows } = await connection.query(
        "select current_setting('app.organization_id') as org,current_setting('app.user_id') as person,current_setting('support.write_fence_org') as fence,has_function_privilege(current_user,'support.fence_erasing_content()','EXECUTE') as callable",
      );
      expect(rows[0]).toEqual({
        org: owner.organizationId,
        person: sentinelUser,
        fence: sentinelFence,
        callable: false,
      });
    });
    expect((await getTicket(database.db, owner, opened.ticketId)).messages).toHaveLength(2);
    const ready = await readyToErase(database.db, owner);
    await beginErasure(database.db, ready.service, {
      offboardingId: ready.offboardingId,
      operatorRef: TEST_OPERATOR,
    });
    await asRole(
      'ensemus_support',
      async (connection) => {
        await connection.query("select set_config('support.write_fence_org',$1,true)", [
          sentinelFence,
        ]);
        await connection.query('savepoint fenced_write');
        await expect(
          connection.query(
            "insert into support.ticket_messages(organization_id,ticket_id,author_kind,author_ref,body) values($1,$2,'support',$3,'Fenced')",
            [owner.organizationId, opened.ticketId, TEST_OPERATOR],
          ),
        ).rejects.toMatchObject({ code: '25006' });
        await connection.query('rollback to savepoint fenced_write');
        expect(
          (await connection.query("select current_setting('support.write_fence_org') as fence"))
            .rows[0],
        ).toEqual({ fence: sentinelFence });
        // An UPDATE reaches 0507's fixed fence alone, which refuses and still restores the binding.
        await connection.query('savepoint fenced_update');
        await expect(
          connection.query(
            "update support.tickets set status='waiting_on_customer' where organization_id=$1 and id=$2",
            [owner.organizationId, opened.ticketId],
          ),
        ).rejects.toMatchObject({ code: '25006' });
        await connection.query('rollback to savepoint fenced_update');
        expect(
          (await connection.query("select current_setting('support.write_fence_org') as fence"))
            .rows[0],
        ).toEqual({ fence: sentinelFence });
      },
      { organizationId: owner.organizationId },
    );
    expect((await getTicket(database.db, owner, opened.ticketId)).messages).toHaveLength(2);
  });
  it('a member sees only their own tickets and another tenant never sees the conversation', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      person = await lifecycleTenant(database.db, auth);
    await withTenantTx(database.db, owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: owner.organizationId, userId: person.userId, role: 'member' }),
    );
    const member = await resolveTenantContext(database.db, person.userId, owner.organizationId),
      first = await openTicket(database.db, owner, {
        subject: 'Same ticket',
        category: 'other',
        body: 'Owner-supplied text',
      }),
      second = await openTicket(database.db, member, {
        subject: 'Same ticket',
        category: 'other',
        body: 'Member-supplied text',
      });
    expect((await listTickets(database.db, member)).map((ticket) => ticket.id)).toEqual([
      second.ticketId,
    ]);
    expect(await listTickets(database.db, owner)).toHaveLength(2);
    for (const context of [member, person])
      await expect(getTicket(database.db, context, first.ticketId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    await expect(
      openTicket(database.db, createServiceContext(owner.organizationId), {
        subject: 'Invalid actor',
        category: 'other',
        body: 'No person',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('the queue shows identifiers until an agent explicitly opens a ticket, and replies measure the first response', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      canary = `test-support-${randomUUID()}`,
      opened = await openTicket(database.db, owner, {
        subject: canary,
        category: 'account',
        body: canary,
      }),
      queue = await listDeskQueue(desk, { limit: 100 });
    expect(JSON.stringify(queue)).not.toContain(canary);
    expect(
      await getDeskTicket(desk, {
        organizationId: owner.organizationId,
        ticketId: opened.ticketId,
      }),
    ).toMatchObject({ subject: canary });
    await replyAsDesk(desk, {
      organizationId: owner.organizationId,
      ticketId: opened.ticketId,
      agentRef: 'test-agent@example.invalid',
      body: 'Test reply',
    });
    const [first] = await withTenantTx(database.db, owner, (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, opened.ticketId)),
    );
    expect(first!.firstResponseAt).not.toBeNull();
    await replyAsDesk(desk, {
      organizationId: owner.organizationId,
      ticketId: opened.ticketId,
      agentRef: 'test-agent@example.invalid',
      body: 'Another test reply',
    });
    const [second] = await withTenantTx(database.db, owner, (tx) =>
      tx.select().from(tickets).where(eq(tickets.id, opened.ticketId)),
    );
    expect(second!.firstResponseAt).toEqual(first!.firstResponseAt);
    await expect(
      replyToTicket(database.db, owner, {
        ticketId: opened.ticketId,
        body: 'Stale reply',
        expectedVersion: first!.version,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const saved = await replyToTicket(database.db, owner, {
      ticketId: opened.ticketId,
      body: 'Current reply',
      expectedVersion: second!.version,
    });
    await closeTicket(database.db, owner, {
      ticketId: opened.ticketId,
      expectedVersion: saved.version,
    });
    await expect(
      replyAsDesk(desk, {
        organizationId: owner.organizationId,
        ticketId: opened.ticketId,
        agentRef: 'test-agent@example.invalid',
        body: 'Closed reply',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('each database role is refused when attempting to speak as the other side', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      opened = await openTicket(database.db, owner, {
        subject: 'Authorship test',
        category: 'security',
        body: 'Test details',
      });
    // Bound to the ticket's tenant, so the birth fence admits it and desk_write's author check refuses.
    await expect(
      asRole(
        'ensemus_support',
        (client) =>
          client.query(
            "insert into support.ticket_messages(organization_id,ticket_id,author_kind,author_ref,body) values($1,$2,'customer',$3,'test')",
            [owner.organizationId, opened.ticketId, 'test-agent@example.invalid'],
          ),
        { organizationId: owner.organizationId },
      ),
    ).rejects.toMatchObject({
      code: '42501',
      message: expect.stringMatching(/row-level security/),
    });
    await expect(
      withTenantTx(database.db, owner, (tx) =>
        tx.insert(ticketMessages).values({
          organizationId: owner.organizationId,
          ticketId: opened.ticketId,
          authorKind: 'support',
          authorRef: owner.membershipId,
          body: 'test',
        }),
      ),
    ).rejects.toThrow();
  });
  it('a suspended tenant can still ask for help, and a draft schedule is never presented as published', async () => {
    const owner = await lifecycleTenant(database.db, auth),
      service = createServiceContext(owner.organizationId);
    await withAccountTx(database.db, service, (tx) =>
      setTenantStandingInTx(
        tx,
        service,
        {
          to: 'suspended',
          reasonCode: 'TEST_SUSPENDED',
          actor: { type: 'operator', ref: TEST_OPERATOR },
        },
        createStandingAgentHaltPort(),
      ),
    );
    expect(
      (
        await openTicket(database.db, owner, {
          subject: 'Suspended account',
          category: 'billing',
          body: 'Help with this test account',
        })
      ).ticketId,
    ).toBeTruthy();
    const draft = await asRole('ensemus_operator', async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('support:coverage_versions',0))",
      );
      const result = await client.query<{ version: number }>(
        "insert into support.coverage_schedules(version,timezone,schedule,staffed_by_ref,drafted_by) select coalesce(max(version),0)+1,'UTC',$1,$2,$2 from support.coverage_schedules returning version",
        [JSON.stringify([{ day: 1, from: '09:00', to: '10:00' }]), TEST_OPERATOR],
      );
      return result.rows[0]!.version;
    });
    expect((await getPublishedCoverage(database.db))?.version).not.toBe(draft);
  });
});
