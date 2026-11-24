// API-12 / ADR-024 D4: cached responses belong to one actual active person, not a tenant reader.
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { openAppDatabase, withTenantTx, idempotencyKeys } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { pgCode } from '../../packages/application/src/errors';
import { disableMember } from '@ensemus/application';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('private API replay responses through native readers', () => {
  const web = openAppDatabase(urls.app());
  const native = [urls.worker, urls.connector, urls.knowledge, urls.agent].map((url) =>
    openAppDatabase(url()),
  );
  let people: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    people = await makeTwoTenants(web.db);
    await proveSecondFactor(people.a.owner);
  });
  afterAll(async () => {
    await web.close();
    for (const db of native) await db.close();
  });
  it('does not expose one person response to other people, mismatched identities or worker logins', async () => {
    const owner = people.a.owner.context,
      key = randomUUID();
    const body = { generated_private_response: 'GENERATED-CALLER-ONLY-REPLAY-BODY' };
    await withTenantTx(web.db, owner, (tx) =>
      tx.insert(idempotencyKeys).values({
        organizationId: owner.organizationId,
        membershipId: owner.membershipId,
        key,
        requestHash: 'a'.repeat(64),
        responseStatus: 201,
        responseBody: body,
      }),
    );
    const read = (db: typeof web, context: typeof owner, role = false) =>
      withTenantTx(db.db, context, async (tx) => {
        if (role) await tx.execute(sql`set local role ensemus_app`);
        return tx
          .select({ body: idempotencyKeys.responseBody })
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, key));
      });
    expect(await read(web, owner)).toEqual([{ body }]);
    expect.soft(await read(web, people.a.admin.context), 'same-tenant admin').toEqual([]);
    expect.soft(await read(web, people.a.member.context), 'same-tenant member').toEqual([]);
    expect.soft(await read(web, people.b.owner.context), 'foreign tenant').toEqual([]);
    expect
      .soft(
        await read(web, { ...owner, userId: people.a.member.context.userId }),
        'mismatched active user',
      )
      .toEqual([]);
    expect
      .soft(
        await read(web, createServiceContext(owner.organizationId)),
        'web service-shaped bindings',
      )
      .toEqual([]);
    for (const db of native) {
      expect.soft(await read(db, owner), 'native worker copied human').toEqual([]);
      expect.soft(await read(db, owner, true), 'native worker SET ROLE copied human').toEqual([]);
      expect
        .soft(await read(db, createServiceContext(owner.organizationId)), 'native service')
        .toEqual([]);
    }
  });
  it('refuses native inserts even with copied human bindings', async () => {
    const owner = people.a.owner.context;
    for (const db of native)
      await expect(
        withTenantTx(db.db, owner, (tx) =>
          tx.insert(idempotencyKeys).values({
            organizationId: owner.organizationId,
            membershipId: owner.membershipId,
            key: randomUUID(),
            requestHash: 'c'.repeat(64),
            responseStatus: 201,
            responseBody: { generated: true },
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
  it('stops stale contexts reading a disabled member response', async () => {
    const member = people.a.member.context,
      key = randomUUID();
    await withTenantTx(web.db, member, (tx) =>
      tx.insert(idempotencyKeys).values({
        organizationId: member.organizationId,
        membershipId: member.membershipId,
        key,
        requestHash: 'd'.repeat(64),
        responseStatus: 201,
        responseBody: { generated: true },
      }),
    );
    await disableMember(web.db, people.a.owner.context, { membershipId: member.membershipId });
    expect(
      await withTenantTx(web.db, member, (tx) =>
        tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)),
      ),
    ).toEqual([]);
  });
  it('refuses inserting a replay result for another person', async () => {
    const owner = people.a.owner.context;
    await expect(
      withTenantTx(web.db, owner, (tx) =>
        tx.insert(idempotencyKeys).values({
          organizationId: owner.organizationId,
          membershipId: people.a.member.context.membershipId,
          key: randomUUID(),
          requestHash: 'b'.repeat(64),
          responseStatus: 201,
          responseBody: { generated: true },
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
});
