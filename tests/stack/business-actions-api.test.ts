// Real production HTTP routes and sessions; generated records and SQL attempts, no provider contact.
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import {
  openAppDatabase,
  withTenantTx,
  businessRecords,
  externalResources,
  externalResourceAcl,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createWorkUnit,
  assignContributor,
  applyBusinessRecordPage,
  decideApproval,
  beginAttempt,
  finishAttempt,
} from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import { BASE, signUp, createOrganization, join, type Person } from '../helpers/forms';
import { nativePersonContext, proveSecondFactor } from '../helpers/product';
import { seedConnection } from '../helpers/integrations';
import { urls } from '../helpers/stack';
import { contractProblems } from '../helpers/openapi';
const hash = (x: unknown) => createHash('sha256').update(canonicalJson(x)).digest('hex');
describe('business proposals through the built production API', () => {
  const web = openAppDatabase(urls.app()),
    connector = openAppDatabase(urls.connector());
  let owner: Person, reviewer: Person, ungranted: Person, outsider: Person, organization: string;
  let author: Awaited<ReturnType<typeof nativePersonContext>>, reviewerContext: typeof author;
  const fixtures = new Map<
    string,
    { connectionId: string; recordId: string; resourceId: string }
  >();
  const root = () => `/api/v1/organizations/${organization}`;
  beforeAll(async () => {
    owner = await signUp('Generated business API owner');
    outsider = await signUp('Generated business API outsider');
    organization = await createOrganization(owner, 'Generated business proposals');
    reviewer = await join(owner, organization, 'Generated business reviewer');
    ungranted = await join(owner, organization, 'Generated ungranted member');
    const identity = async (person: Person) => {
      const r = (await (
        await fetch(BASE + '/api/auth/get-session', { headers: { cookie: person.jar.cookie } })
      ).json()) as { user: { id: string }; session: { id: string } };
      return { userId: r.user.id, sessionId: r.session.id };
    };
    const identityOwner = await identity(owner);
    await proveSecondFactor(identityOwner);
    author = await nativePersonContext(web.db, identityOwner, organization);
    reviewerContext = await nativePersonContext(web.db, await identity(reviewer), organization);
    for (const [type, stream, fields, classification] of [
      ['crm_http', 'crm.accounts', { name: 'Generated API account', status: 'open' }, 'internal'],
      [
        'ticketing_http',
        'ticketing.tickets',
        { subject: 'Generated API ticket', status: 'open' },
        'internal',
      ],
      [
        'accounting_http',
        'accounting.invoices',
        { number: 'Generated API invoice', memo: 'Initial memo' },
        'confidential',
      ],
    ] as const) {
      const connectionId = await seedConnection(web.db, author, {
        connectorType: type,
        config: { streams: [stream], scopes: [type + '.read', type + '.write'] },
        grantedScopes: [type + '.read', type + '.write'],
      });
      const externalId = randomUUID();
      const service = createServiceContext(organization);
      await applyBusinessRecordPage(connector.db, service, {
        connectionId,
        connectorType: type,
        stream,
        records: [
          {
            externalId,
            externalVersion: 'v1',
            displayName: null,
            fields,
            fieldsSha256: hash(fields),
            classification,
          },
        ],
        deletedExternalIds: [],
      });
      const f = await withTenantTx(connector.db, service, async (tx) => {
        await tx.execute(sql`select set_config('app.business_connection_id',${connectionId},true)`);
        const [resource] = await tx
          .insert(externalResources)
          .values({
            organizationId: organization,
            connectionId,
            stream,
            resourceType: stream,
            externalId,
            externalVersion: 'v1',
            contentSha256: hash(fields),
            classification,
            aclState: 'mapped',
          })
          .returning();
        for (const person of [author, reviewerContext])
          await tx.insert(externalResourceAcl).values({
            organizationId: organization,
            resourceId: resource!.id,
            principalKind: 'user',
            principalExternalId: person.membershipId,
            membershipId: person.membershipId,
            access: 'read',
          });
        const [record] = await tx
          .select()
          .from(businessRecords)
          .where(
            and(
              eq(businessRecords.connectionId, connectionId),
              eq(businessRecords.externalId, externalId),
            ),
          );
        return { connectionId, resourceId: resource!.id, recordId: record!.id };
      });
      fixtures.set(type, f);
    }
  });
  afterAll(async () => {
    await web.close();
    await connector.close();
  });
  async function work(classification: 'internal' | 'confidential' = 'internal') {
    const w = await createWorkUnit(web.db, author, {
      title: 'Generated API business change ' + randomUUID(),
      classification,
    });
    await assignContributor(web.db, author, {
      id: w.id,
      membershipId: reviewerContext.membershipId,
      responsibility: 'reviewer',
    });
    return w.id;
  }
  async function post(
    path: string,
    body: unknown,
    person: Person | null = owner,
    key: string = randomUUID(),
    extra: Record<string, string> = {},
  ) {
    const response = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        ...(person ? { cookie: person.jar.cookie } : {}),
        origin: BASE,
        'content-type': 'application/json',
        'idempotency-key': key,
        ...extra,
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await response.text();
    expect(
      contractProblems({
        method: 'POST',
        path,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      body: JSON.parse(text) as {
        id: string;
        approval_id: string;
        request_hash: string;
        status: string;
      },
      headers: response.headers,
    };
  }
  it('refuses anonymous, foreign, ungranted and changed-origin requests without a proposal', async () => {
    const f = fixtures.get('crm_http')!,
      path = root() + `/business-records/${f.recordId}/updates`;
    const body = {
      work_unit_id: await work(),
      expected_version: 'v1',
      changes: { status: 'qualified' },
      approver_membership_id: reviewerContext.membershipId,
    };
    expect((await post(path, body, null)).status).toBe(401);
    expect((await post(path, body, outsider)).status).toBe(404);
    expect((await post(path, body, ungranted)).status).toBe(404);
    expect(
      (await post(path, body, owner, randomUUID(), { origin: 'https://untrusted.example.invalid' }))
        .status,
    ).toBe(403);
    expect((await post(path, body, owner, '')).status).toBe(400);
    expect((await post(path, { ...body, changes: { name: 'Read-only' } })).status).toBe(400);
    expect((await post(path, { ...body, expected_version: 'stale' })).status).toBe(409);
  });
  it('replays an exact update, rejects changed bytes under its key and creates a distinct revision', async () => {
    const f = fixtures.get('crm_http')!,
      path = root() + `/business-records/${f.recordId}/updates`,
      key = randomUUID();
    const body = {
      work_unit_id: await work(),
      expected_version: 'v1',
      changes: { status: 'qualified' },
      approver_membership_id: reviewerContext.membershipId,
    };
    const first = await post(path, body, owner, key);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('awaiting_approval');
    expect(first.headers.get('etag')).toBe('"1"');
    expect((await post(path, body, owner, key)).body).toEqual(first.body);
    expect((await post(path, { ...body, changes: { status: 'closed' } }, owner, key)).status).toBe(
      409,
    );
    const current = await withTenantTx(web.db, author, async (tx) => {
      const r = await tx.execute<{ payload: unknown; version: number }>(
        sql`select payload,version from integrations.external_actions where id=${first.body.id}::uuid`,
      );
      return r.rows[0]!;
    });
    const changed = {
      approver_membership_id: reviewerContext.membershipId,
      payload: { ...(current.payload as object), changes: { status: 'closed' } },
    };
    const revisionPath = root() + `/business-actions/${first.body.id}/revisions`;
    expect((await post(revisionPath, changed)).status).toBe(428);
    const revised = await post(revisionPath, changed, owner, randomUUID(), {
      'if-match': String(current.version),
    });
    expect(revised.status).toBe(201);
    expect(revised.body.id).not.toBe(first.body.id);
    expect(revised.body.request_hash).not.toBe(first.body.request_hash);
  });
  it('creates only internal ticket notes and draft invoices, and rejects a payment field', async () => {
    const t = fixtures.get('ticketing_http')!;
    const note = await post(root() + `/business-records/${t.recordId}/ticket-comments`, {
      work_unit_id: await work(),
      approver_membership_id: reviewerContext.membershipId,
      body: 'Generated internal API note',
    });
    expect(note.status).toBe(201);
    const a = fixtures.get('accounting_http')!,
      body = {
        work_unit_id: await work('confidential'),
        connection_id: a.connectionId,
        approver_membership_id: reviewerContext.membershipId,
        invoice: {
          customer_ref: 'Generated customer',
          currency: 'UZS',
          lines: [{ description: 'Generated draft line', quantity: '1', unit_price: '100.00' }],
        },
      };
    expect(
      (
        await post(root() + '/invoice-drafts', {
          ...body,
          invoice: { ...body.invoice, pay_now: true },
        })
      ).status,
    ).toBe(400);
    expect((await post(root() + '/invoice-drafts', body)).status).toBe(201);
  });
  it('requires a proven failed action for retries, gives it a new approval, and replays the retry key', async () => {
    const f = fixtures.get('crm_http')!,
      body = {
        work_unit_id: await work(),
        expected_version: 'v1',
        changes: { status: 'qualified' },
        approver_membership_id: reviewerContext.membershipId,
      };
    const p = await post(root() + `/business-records/${f.recordId}/updates`, body);
    expect(p.status).toBe(201);
    const retryPath = root() + `/business-actions/${p.body.id}/retries`,
      retryBody = { approver_membership_id: reviewerContext.membershipId };
    expect((await post(retryPath, retryBody)).status).toBe(409);
    await decideApproval(web.db, reviewerContext, {
      approvalId: p.body.approval_id,
      decision: 'approve',
      shownHash: p.body.request_hash,
    });
    const service = createServiceContext(organization),
      attempt = await beginAttempt(connector.db, service, {
        externalActionId: p.body.id,
        runId: 'generated-api-attempt',
      });
    if (attempt.kind !== 'send') throw Error('EXPECTED_GENERATED_ATTEMPT');
    await finishAttempt(connector.db, service, {
      attemptId: attempt.attempt.attemptId,
      result: { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER' },
    });
    const key = randomUUID(),
      retried = await post(retryPath, retryBody, owner, key);
    expect(retried.status).toBe(201);
    expect(retried.body.id).not.toBe(p.body.id);
    expect(retried.body.approval_id).not.toBe(p.body.approval_id);
    expect((await post(retryPath, retryBody, owner, key)).body).toEqual(retried.body);
  });
  it('refuses unversioned updates and hides record-backed proposals when the requester loses source access', async () => {
    const f = fixtures.get('crm_http')!,
      service = createServiceContext(organization);
    const version = async (value: string | null) =>
      withTenantTx(connector.db, service, async (tx) => {
        await tx.execute(
          sql`select set_config('app.business_connection_id',${f.connectionId},true)`,
        );
        await tx
          .update(businessRecords)
          .set({ externalVersion: value })
          .where(eq(businessRecords.id, f.recordId));
        await tx
          .update(externalResources)
          .set({ externalVersion: value })
          .where(eq(externalResources.id, f.resourceId));
      });
    await version(null);
    const body = {
      work_unit_id: await work(),
      expected_version: null,
      changes: { status: 'qualified' },
      approver_membership_id: reviewerContext.membershipId,
    };
    expect((await post(root() + `/business-records/${f.recordId}/updates`, body)).status).toBe(409);
    await version('v1');
    const p = await post(root() + `/business-records/${f.recordId}/updates`, {
      ...body,
      expected_version: 'v1',
    });
    expect(p.status).toBe(201);
    await withTenantTx(connector.db, service, (tx) =>
      tx
        .delete(externalResourceAcl)
        .where(
          and(
            eq(externalResourceAcl.resourceId, f.resourceId),
            eq(externalResourceAcl.membershipId, author.membershipId),
          ),
        ),
    );
    for (const path of [
      root() + `/approvals/${p.body.approval_id}`,
      root() + `/external-actions/${p.body.id}`,
    ]) {
      const response = await fetch(BASE + path, {
          headers: { cookie: owner.jar.cookie },
          redirect: 'manual',
        }),
        text = await response.text();
      expect(response.status).toBe(404);
      expect(
        contractProblems({
          method: 'GET',
          path,
          status: response.status,
          headers: response.headers,
          text,
        }).problems,
      ).toEqual([]);
      expect(text).not.toContain('qualified');
    }
  });
});
