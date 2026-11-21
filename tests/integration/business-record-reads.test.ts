// Generated business records, actual source ACL rows and native database logins.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAppDatabase,
  withTenantTx,
  businessRecords,
  externalResources,
  externalResourceAcl,
  connections,
  teams,
  teamMemberships,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  applyBusinessRecordPage,
  getBusinessRecord,
  listBusinessRecords,
  purgeRevokedBusinessRecords,
  type BusinessRecordPage,
} from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import { and, eq, sql } from 'drizzle-orm';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { seedConnection } from '../helpers/integrations';
import { urls } from '../helpers/stack';

const code = (value: string) => expect.objectContaining({ code: value });
const hash = (fields: unknown) => createHash('sha256').update(canonicalJson(fields)).digest('hex');
const stream = 'crm.accounts';
describe('business records use source grants and native writer authority', () => {
  let web: ReturnType<typeof openAppDatabase>,
    connector: ReturnType<typeof openAppDatabase>,
    worker: ReturnType<typeof openAppDatabase>,
    agent: ReturnType<typeof openAppDatabase>,
    knowledge: ReturnType<typeof openAppDatabase>;
  let people: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    web = openAppDatabase(urls.app());
    connector = openAppDatabase(urls.connector());
    worker = openAppDatabase(urls.worker());
    agent = openAppDatabase(urls.agent());
    knowledge = openAppDatabase(urls.knowledge());
    people = await makeTwoTenants(web.db);
    await proveSecondFactor(people.a.owner);
    await proveSecondFactor(people.b.owner);
  });
  afterAll(async () => {
    for (const db of [web, connector, worker, agent, knowledge]) await db?.close();
  });
  async function source(context = people.a.owner.context) {
    return seedConnection(web.db, context, {
      connectorType: 'crm_http',
      config: { streams: [stream], scopes: ['crm_http.read'] },
      grantedScopes: ['crm_http.read'],
    });
  }
  const page = (
    connectionId: string,
    externalId = 'same-source-id',
    fields = { name: 'Generated account', status: 'open' },
  ) => ({
    connectionId,
    connectorType: 'crm_http' as const,
    stream,
    records: [
      {
        externalId,
        externalVersion: '1',
        displayName: fields.name,
        fields,
        fieldsSha256: hash(fields),
        classification: 'internal' as const,
      },
    ],
    deletedExternalIds: [] as string[],
  });
  async function apply(context: TenantContext, input: BusinessRecordPage) {
    await applyBusinessRecordPage(
      connector.db,
      createServiceContext(context.organizationId),
      input,
    );
  }
  async function mapped(
    context: TenantContext,
    connectionId: string,
    membershipId: string,
    externalId = 'same-source-id',
    aclState: 'mapped' | 'partial' = 'mapped',
  ) {
    return withTenantTx(connector.db, createServiceContext(context.organizationId), async (tx) => {
      const [r] = await tx
        .insert(externalResources)
        .values({
          organizationId: context.organizationId,
          connectionId,
          stream,
          resourceType: stream,
          externalId,
          externalVersion: '1',
          contentSha256: hash(page(connectionId).records[0]!.fields),
          classification: 'internal',
          aclState,
        })
        .returning();
      await tx.insert(externalResourceAcl).values({
        organizationId: context.organizationId,
        resourceId: r!.id,
        principalKind: 'user',
        principalExternalId: 'generated-person',
        membershipId,
        access: 'read',
      });
      return r!.id;
    });
  }
  it('denies a direct SQL read without a source grant, including administrators and worker user impersonation', async () => {
    const owner = people.a.owner.context,
      connectionId = await source();
    // Seed through the native connector, so the denied case is independent of the unfinished sink.
    await withTenantTx(connector.db, createServiceContext(owner.organizationId), async (tx) => {
      await tx.execute(sql`select set_config('app.business_connection_id',${connectionId},true)`);
      await tx.insert(businessRecords).values({
        organizationId: owner.organizationId,
        ...page(connectionId).records[0]!,
        connectionId,
        stream,
      });
    });
    for (const context of [owner, people.a.member.context, people.a.admin.context])
      expect
        .soft(await withTenantTx(web.db, context, (tx) => tx.select().from(businessRecords)))
        .toEqual([]);
    await mapped(owner, connectionId, people.a.member.context.membershipId);
    expect(
      await withTenantTx(web.db, people.a.member.context, (tx) =>
        tx.select({ id: businessRecords.id }).from(businessRecords),
      ),
    ).toHaveLength(1);
    for (const native of [agent, worker, connector, knowledge])
      expect
        .soft(
          await withTenantTx(native.db, people.a.member.context, async (tx) => {
            await tx.execute(sql`set local role ensemus_app`);
            return tx.select().from(businessRecords);
          }),
        )
        .toEqual([]);
  });
  it('stores selected fields idempotently, hides the uncommitted source snapshot and never adds an admin bypass', async () => {
    const a = people.a.owner.context,
      connectionId = await source();
    const input = page(connectionId);
    await apply(a, input);
    expect((await listBusinessRecords(web.db, a, { connectionId })).items).toEqual([]);
    const resourceId = await mapped(
      a,
      connectionId,
      people.a.member.context.membershipId,
      'same-source-id',
      'partial',
    );
    const member = people.a.member.context;
    const first = (await listBusinessRecords(web.db, member, { connectionId })).items[0]!;
    expect(first.fields).toEqual(input.records[0]!.fields);
    await apply(a, input);
    expect(await getBusinessRecord(web.db, member, first.id)).toEqual(first);
    await expect(getBusinessRecord(web.db, a, first.id)).rejects.toEqual(code('NOT_FOUND'));
    const changed = page(connectionId, 'same-source-id', {
      name: 'Generated changed account',
      status: 'closed',
    });
    await apply(a, changed);
    // The new fields are not readable under the previous source snapshot and its grants.
    await expect(getBusinessRecord(web.db, member, first.id)).rejects.toEqual(code('NOT_FOUND'));
    await withTenantTx(connector.db, createServiceContext(a.organizationId), (tx) =>
      tx
        .update(externalResources)
        .set({ contentSha256: changed.records[0]!.fieldsSha256 })
        .where(eq(externalResources.id, resourceId)),
    );
    expect((await getBusinessRecord(web.db, member, first.id)).fields).toEqual(
      changed.records[0]!.fields,
    );
    await withTenantTx(connector.db, createServiceContext(a.organizationId), (tx) =>
      tx.delete(externalResourceAcl).where(eq(externalResourceAcl.resourceId, resourceId)),
    );
    await expect(getBusinessRecord(web.db, member, first.id)).rejects.toEqual(code('NOT_FOUND'));
  });
  it('separates identical source IDs in two companies and supports actual team grants and stable keyset pages', async () => {
    const a = people.a.owner.context,
      b = people.b.owner.context,
      ca = await source(a),
      cb = await source(b);
    await apply(a, page(ca));
    await apply(b, page(cb));
    const ra = await mapped(a, ca, people.a.member.context.membershipId),
      rb = await mapped(b, cb, b.membershipId);
    await withTenantTx(web.db, a, async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ organizationId: a.organizationId, name: 'Generated source team' })
        .returning();
      await tx.insert(teamMemberships).values({
        organizationId: a.organizationId,
        teamId: team!.id,
        membershipId: a.membershipId,
      });
      await tx.insert(externalResourceAcl).values({
        organizationId: a.organizationId,
        resourceId: ra,
        principalKind: 'group',
        principalExternalId: 'generated-team',
        teamId: team!.id,
        access: 'read',
      });
    });
    const mine = (await listBusinessRecords(web.db, a, { connectionId: ca })).items;
    expect(mine).toHaveLength(1);
    const theirs = (await listBusinessRecords(web.db, b, { connectionId: cb })).items;
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.id).not.toBe(mine[0]!.id);
    await expect(getBusinessRecord(web.db, a, theirs[0]!.id)).rejects.toEqual(code('NOT_FOUND'));
    expect(rb).not.toBe(ra);
    for (const externalId of ['page-2', 'page-3']) {
      await apply(a, page(ca, externalId));
      await mapped(a, ca, a.membershipId, externalId);
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const p = await listBusinessRecords(web.db, a, {
        connectionId: ca,
        limit: 1,
        ...(cursor ? { after: cursor } : {}),
      });
      ids.push(...p.items.map((r) => r.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    await expect(listBusinessRecords(web.db, a, { after: 'invalid' })).rejects.toEqual(
      code('INVALID_INPUT'),
    );
  });
  it('refuses human/service inversions, wrong connections, hashes and field shapes without partial writes', async () => {
    const a = people.a.owner.context,
      connectionId = await source(),
      input = page(connectionId);
    await expect(applyBusinessRecordPage(web.db, a, input)).rejects.toEqual(code('FORBIDDEN'));
    await expect(
      listBusinessRecords(web.db, createServiceContext(a.organizationId), {}),
    ).rejects.toEqual(code('FORBIDDEN'));
    await expect(
      applyBusinessRecordPage(web.db, createServiceContext(a.organizationId), input),
    ).rejects.toEqual(code('FORBIDDEN'));
    await expect(
      applyBusinessRecordPage(agent.db, createServiceContext(a.organizationId), input),
    ).rejects.toEqual(code('FORBIDDEN'));
    await expect(
      applyBusinessRecordPage(
        connector.db,
        createServiceContext(people.b.owner.context.organizationId),
        input,
      ),
    ).rejects.toEqual(code('NOT_FOUND'));
    await expect(apply(a, { ...input, connectorType: 'accounting_http' })).rejects.toEqual(
      code('INVALID_INPUT'),
    );
    await expect(
      apply(a, { ...input, records: [{ ...input.records[0]!, fieldsSha256: '0'.repeat(64) }] }),
    ).rejects.toEqual(code('INVALID_INPUT'));
    await expect(
      apply(a, { ...input, records: [{ ...input.records[0]!, fields: { name: 123 } }] }),
    ).rejects.toEqual(code('INVALID_INPUT'));
    expect((await listBusinessRecords(web.db, a, { connectionId })).items).toEqual([]);
  });
  it('clears deleted and revoked content and refuses borrowing the platform purge path', async () => {
    const a = people.a.owner.context,
      connectionId = await source();
    await apply(a, page(connectionId));
    await mapped(a, connectionId, a.membershipId);
    const first = (await listBusinessRecords(web.db, a, { connectionId })).items[0]!;
    await apply(a, { ...page(connectionId), records: [], deletedExternalIds: ['same-source-id'] });
    await expect(getBusinessRecord(web.db, a, first.id)).rejects.toEqual(code('NOT_FOUND'));
    await apply(a, page(connectionId));
    await withTenantTx(web.db, a, (tx) =>
      tx
        .update(connections)
        .set({ state: 'revoked', version: 2, revokedAt: new Date() })
        .where(eq(connections.id, connectionId)),
    );
    await expect(getBusinessRecord(web.db, a, first.id)).rejects.toEqual(code('NOT_FOUND'));
    expect(
      await withTenantTx(connector.db, createServiceContext(a.organizationId), async (tx) => {
        await tx.execute(sql`select set_config('app.business_connection_id',${connectionId},true)`);
        return tx.select().from(businessRecords).where(eq(businessRecords.id, first.id));
      }),
    ).toEqual([]);
    await expect(
      purgeRevokedBusinessRecords(web.db, createServiceContext(a.organizationId)),
    ).rejects.toEqual(code('FORBIDDEN'));
    await expect(
      purgeRevokedBusinessRecords(agent.db, createServiceContext(a.organizationId)),
    ).rejects.toEqual(code('FORBIDDEN'));
    expect(
      await purgeRevokedBusinessRecords(worker.db, createServiceContext(a.organizationId)),
    ).toBe(1);
    expect(
      await purgeRevokedBusinessRecords(worker.db, createServiceContext(a.organizationId)),
    ).toBe(0);
    const kept = await withTenantTx(
      worker.db,
      createServiceContext(a.organizationId),
      async (tx) => {
        await tx.execute(sql`select set_config('app.business_record_purge','true',true)`);
        return tx
          .select()
          .from(businessRecords)
          .where(
            and(eq(businessRecords.connectionId, connectionId), eq(businessRecords.id, first.id)),
          );
      },
    );
    expect(kept[0]!.fields).toEqual({});
    expect(kept[0]!.displayName).toBeNull();
    expect(kept[0]!.deletedAt).not.toBeNull();
  });
});
