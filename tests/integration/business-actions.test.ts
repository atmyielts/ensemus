// EXP-02: actual native SQL, exact proposals and the existing external-action state machine.
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  openAppDatabase,
  withTenantTx,
  businessRecords,
  externalResources,
  externalResourceAcl,
  externalActions,
  approvals,
  connections,
  teams,
  teamMemberships,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  createWorkUnit,
  getWorkUnit,
  getApproval,
  listBusinessRecordReviewers,
  createBusinessRecordProposal,
  runIdempotent,
  requestHash,
  applyBusinessRecordPage,
  proposeRecordUpdate,
  proposeTicketComment,
  proposeInvoiceDraft,
  reviseBusinessAction,
  retryBusinessAction,
  decideApproval,
  beginAttempt,
  finishAttempt,
} from '@ensemus/application';
import { canonicalJson } from '@ensemus/domain/approval';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { seedConnection } from '../helpers/integrations';
import { urls } from '../helpers/stack';
const hash = (x: unknown) => createHash('sha256').update(canonicalJson(x)).digest('hex');
const code = (x: string) => expect.objectContaining({ code: x });
describe('human business changes through exact reviewed intents', () => {
  const web = openAppDatabase(urls.app()),
    connector = openAppDatabase(urls.connector());
  let people: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    people = await makeTwoTenants(web.db);
    await proveSecondFactor(people.a.owner);
  });
  afterAll(async () => {
    await web.close();
    await connector.close();
  });
  async function fixture(
    type: 'crm_http' | 'ticketing_http' | 'accounting_http' = 'crm_http',
    stream = type === 'crm_http'
      ? 'crm.accounts'
      : type === 'ticketing_http'
        ? 'ticketing.tickets'
        : 'accounting.invoices',
  ) {
    const owner = people.a.owner.context,
      approver = people.a.admin.context;
    const fields =
      type === 'crm_http'
        ? { name: 'Generated account', status: 'open' }
        : type === 'ticketing_http'
          ? { subject: 'Generated ticket', status: 'open' }
          : { number: 'GENERATED-INV', memo: 'Generated invoice' };
    const classification =
      type === 'accounting_http' ? ('confidential' as const) : ('internal' as const);
    const connectionId = await seedConnection(web.db, owner, {
      connectorType: type,
      config: { streams: [stream], scopes: [type + '.read', type + '.write'] },
      grantedScopes: [type + '.read', type + '.write'],
    });
    const externalId = randomUUID();
    const service = createServiceContext(owner.organizationId);
    await applyBusinessRecordPage(connector.db, service, {
      connectionId,
      connectorType: type,
      stream,
      records: [
        {
          externalId,
          externalVersion: 'source-v1',
          displayName: null,
          fields,
          fieldsSha256: hash(fields),
          classification,
        },
      ],
      deletedExternalIds: [],
    });
    const record = await withTenantTx(connector.db, service, async (tx) => {
      await tx.execute(sql`select set_config('app.business_connection_id',${connectionId},true)`);
      const [resource] = await tx
        .insert(externalResources)
        .values({
          organizationId: owner.organizationId,
          connectionId,
          stream,
          resourceType: stream,
          externalId,
          externalVersion: 'source-v1',
          contentSha256: hash(fields),
          classification,
          aclState: 'mapped',
        })
        .returning();
      for (const member of [owner, approver])
        await tx.insert(externalResourceAcl).values({
          organizationId: owner.organizationId,
          resourceId: resource!.id,
          principalKind: 'user',
          principalExternalId: member.membershipId,
          membershipId: member.membershipId,
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
      return { id: record!.id, resourceId: resource!.id };
    });
    const work = await createWorkUnit(web.db, owner, {
      title: 'Generated reviewed business change',
      classification,
    });
    return { owner, approver, connectionId, externalId, record, work, service };
  }
  const row = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
    withTenantTx(
      web.db,
      f.owner,
      async (tx) => (await tx.select().from(externalActions).where(eq(externalActions.id, id)))[0]!,
    );
  const propose = (f: Awaited<ReturnType<typeof fixture>>, changes = { status: 'qualified' }) =>
    proposeRecordUpdate(web.db, f.owner, {
      recordId: f.record.id,
      workUnitId: f.work.id,
      expectedVersion: 'source-v1',
      changes,
      approverMembershipId: f.approver.membershipId,
    });
  it('binds the exact version and writable fields, asks an independent person and sends only after approval', async () => {
    const f = await fixture(),
      p = await propose(f);
    const intent = await row(f, p.externalActionId);
    expect(intent).toMatchObject({
      status: 'awaiting_approval',
      toolName: 'crm.record.update',
      requiresApproval: true,
      requestHash: p.requestHash,
      payload: {
        record: {
          stream: 'crm.accounts',
          external_id: f.externalId,
          expected_version: 'source-v1',
        },
        changes: { status: 'qualified' },
      },
    });
    await expect(
      beginAttempt(connector.db, f.service, {
        externalActionId: intent.id,
        runId: 'generated-run',
      }),
    ).resolves.toMatchObject({ kind: 'stop' });
    await expect(
      decideApproval(web.db, f.owner, {
        approvalId: p.approvalId,
        decision: 'approve',
        shownHash: p.requestHash,
      }),
    ).rejects.toEqual(code('APPROVAL_WRONG_APPROVER'));
    await decideApproval(web.db, f.approver, {
      approvalId: p.approvalId,
      decision: 'approve',
      shownHash: p.requestHash,
    });
    const begun = await beginAttempt(connector.db, f.service, {
      externalActionId: intent.id,
      runId: 'generated-run',
    });
    expect(begun).toMatchObject({ kind: 'send' });
  });
  it('refuses stale versions and non-writable fields without leaving a proposal', async () => {
    const f = await fixture();
    await expect(
      proposeRecordUpdate(web.db, f.owner, {
        recordId: f.record.id,
        workUnitId: f.work.id,
        expectedVersion: 'old',
        changes: { status: 'qualified' },
        approverMembershipId: f.approver.membershipId,
      }),
    ).rejects.toEqual(code('RECORD_VERSION_STALE'));
    await expect(propose(f, { name: 'Change a read-only name' } as never)).rejects.toEqual(
      code('INVALID_INPUT'),
    );
    expect(
      await withTenantTx(web.db, f.owner, (tx) =>
        tx.select().from(approvals).where(eq(approvals.workUnitId, f.work.id)),
      ),
    ).toEqual([]);
  });
  it('denies foreign records, ungranted administrators, borrowed native human bindings and an ungranted reviewer', async () => {
    const f = await fixture();
    for (const context of [people.a.member.context, people.b.owner.context])
      await expect(
        proposeRecordUpdate(web.db, context, {
          recordId: f.record.id,
          workUnitId: f.work.id,
          expectedVersion: 'source-v1',
          changes: { status: 'qualified' },
          approverMembershipId: f.approver.membershipId,
        }),
      ).rejects.toEqual(code('NOT_FOUND'));
    await expect(
      proposeRecordUpdate(connector.db, f.owner, {
        recordId: f.record.id,
        workUnitId: f.work.id,
        expectedVersion: 'source-v1',
        changes: { status: 'qualified' },
        approverMembershipId: f.approver.membershipId,
      }),
    ).rejects.toEqual(code('FORBIDDEN'));
    await withTenantTx(connector.db, f.service, (tx) =>
      tx
        .delete(externalResourceAcl)
        .where(
          and(
            eq(externalResourceAcl.resourceId, f.record.resourceId),
            eq(externalResourceAcl.membershipId, f.approver.membershipId),
          ),
        ),
    );
    await expect(propose(f)).rejects.toEqual(code('NOT_FOUND'));
  });
  it('a revision cancels the old decision and makes a new exact approval', async () => {
    const f = await fixture(),
      p = await propose(f),
      old = await row(f, p.externalActionId);
    const next = await reviseBusinessAction(web.db, f.owner, {
      externalActionId: old.id,
      expectedVersion: old.version,
      payload: { ...(old.payload as object), changes: { status: 'closed' } },
      approverMembershipId: f.approver.membershipId,
    });
    expect(next.externalActionId).not.toBe(old.id);
    expect(next.requestHash).not.toBe(p.requestHash);
    expect(await row(f, old.id)).toMatchObject({ status: 'cancelled', statusReason: 'SUPERSEDED' });
    await expect(
      decideApproval(web.db, f.approver, {
        approvalId: p.approvalId,
        decision: 'approve',
        shownHash: p.requestHash,
      }),
    ).rejects.toEqual(code('APPROVAL_NOT_PENDING'));
    expect(await row(f, next.externalActionId)).toMatchObject({
      status: 'awaiting_approval',
      supersedesId: old.id,
    });
  });
  it('ticket notes stay internal and invoice drafts cannot post or pay', async () => {
    const f = await fixture('ticketing_http');
    const note = await proposeTicketComment(web.db, f.owner, {
      recordId: f.record.id,
      workUnitId: f.work.id,
      body: 'Generated internal note',
      approverMembershipId: f.approver.membershipId,
    });
    expect((await row(f, note.externalActionId)).payload).toEqual({
      ticket: { external_id: f.externalId },
      visibility: 'internal',
      body: 'Generated internal note',
    });
    const a = await fixture('accounting_http');
    const invoice = {
      customer_ref: 'generated-customer',
      currency: 'USD',
      lines: [{ description: 'Generated service', quantity: '1', unit_price: '10.00' }],
    };
    await expect(
      proposeInvoiceDraft(web.db, a.owner, {
        workUnitId: a.work.id,
        connectionId: a.connectionId,
        invoice: { ...invoice, status: 'paid' },
        approverMembershipId: a.approver.membershipId,
      }),
    ).rejects.toEqual(code('INVALID_INPUT'));
    const draft = await proposeInvoiceDraft(web.db, a.owner, {
      workUnitId: a.work.id,
      connectionId: a.connectionId,
      invoice,
      approverMembershipId: a.approver.membershipId,
    });
    expect(await row(a, draft.externalActionId)).toMatchObject({
      toolName: 'accounting.invoice_draft.create',
      requiresApproval: true,
      status: 'awaiting_approval',
      payload: invoice,
    });
  });
  it('revocation or scope loss cancels before any attempt row can be made', async () => {
    for (const change of ['source', 'scope', 'version'] as const) {
      const f = await fixture(),
        p = await propose(f);
      await decideApproval(web.db, f.approver, {
        approvalId: p.approvalId,
        decision: 'approve',
        shownHash: p.requestHash,
      });
      if (change === 'source')
        await withTenantTx(connector.db, f.service, (tx) =>
          tx
            .delete(externalResourceAcl)
            .where(
              and(
                eq(externalResourceAcl.resourceId, f.record.resourceId),
                eq(externalResourceAcl.membershipId, f.owner.membershipId),
              ),
            ),
        );
      else if (change === 'scope')
        await withTenantTx(web.db, f.owner, (tx) =>
          tx
            .update(connections)
            .set({ grantedScopes: ['crm_http.read'] })
            .where(eq(connections.id, f.connectionId)),
        );
      else
        await withTenantTx(connector.db, f.service, async (tx) => {
          await tx.execute(
            sql`select set_config('app.business_connection_id',${f.connectionId},true)`,
          );
          await tx
            .update(businessRecords)
            .set({ externalVersion: 'source-v2' })
            .where(eq(businessRecords.id, f.record.id));
        });
      expect(
        await beginAttempt(connector.db, f.service, {
          externalActionId: p.externalActionId,
          runId: 'generated-run',
        }),
      ).toMatchObject({ kind: 'stop', status: 'cancelled' });
      const state = await withTenantTx(connector.db, f.service, async (tx) => {
        const [action] = await tx
          .select({ status: externalActions.status })
          .from(externalActions)
          .where(eq(externalActions.id, p.externalActionId));
        const count = await tx.execute<{ n: number }>(
          sql`select count(*)::int n from integrations.external_action_attempts where external_action_id=${p.externalActionId}::uuid`,
        );
        return { status: action?.status, attempts: count.rows[0]?.n };
      });
      expect(state).toEqual({ status: 'cancelled', attempts: 0 });
      if (change === 'source' || change === 'version') {
        expect(await row(f, p.externalActionId)).toBeUndefined();
        expect(
          await withTenantTx(web.db, f.owner, (tx) =>
            tx
              .select({ action: approvals.action })
              .from(approvals)
              .where(eq(approvals.id, p.approvalId)),
          ),
        ).toEqual([]);
      }
    }
  });
  it('holds a web snapshot lock without permitting a source update or borrowed native lock purpose', async () => {
    const f = await fixture();
    const facts = await withTenantTx(connector.db, f.service, async (tx) => {
      await tx.execute(sql`select set_config('app.business_connection_id',${f.connectionId},true)`);
      return (
        await tx.select().from(businessRecords).where(eq(businessRecords.id, f.record.id))
      )[0]!;
    });
    const lock = (
      database: typeof web,
      context: typeof f.owner,
      recordId = f.record.id,
      version = facts.externalVersion,
    ) =>
      withTenantTx(database.db, context, async (tx) => {
        await tx.execute(
          sql`select set_config('integrations.business_proposal_lock_record','outer-selector',true)`,
        );
        const r = await tx.execute<{ allowed: boolean }>(
          sql`select integrations.lock_business_proposal_record(${recordId}::uuid,${version}::text,${facts.fieldsSha256}::text,${facts.classification}::text) allowed`,
        );
        const selector = await tx.execute<{ value: string }>(
          sql`select current_setting('integrations.business_proposal_lock_record',true) value`,
        );
        expect(selector.rows[0]?.value).toBe('outer-selector');
        return r.rows[0]?.allowed;
      });
    expect(await lock(web, f.owner)).toBe(true);
    expect(await lock(web, f.owner, f.record.id, 'old')).toBe(false);
    expect(await lock(web, people.a.member.context)).toBe(false);
    expect(await lock(web, people.b.owner.context)).toBe(false);
    expect(await lock(connector, f.owner)).toBe(false);
    expect(await lock(connector, f.service)).toBe(false);
    expect(
      await withTenantTx(web.db, f.owner, (tx) =>
        tx
          .update(businessRecords)
          .set({ displayName: 'FORBIDDEN-SOURCE-UPDATE' })
          .where(eq(businessRecords.id, f.record.id))
          .returning({ id: businessRecords.id }),
      ),
    ).toEqual([]);
  });
  it('one retried human form creates one Work and review atomically, while an invalid change leaves neither', async () => {
    const f = await fixture();
    const title = 'Generated atomic business proposal ' + randomUUID();
    const input = {
      recordId: f.record.id,
      title,
      approverMembershipId: f.approver.membershipId,
      kind: 'update' as const,
      expectedVersion: 'source-v1',
      changes: { status: 'qualified' },
    };
    const request = { key: randomUUID(), requestHash: requestHash([JSON.stringify(input)]) };
    const perform = () =>
      runIdempotent(
        web.db,
        f.owner,
        request,
        (joined) => createBusinessRecordProposal(joined, f.owner, input),
        (row) => ({ status: 201, body: row }),
      );
    const [first, second] = await Promise.all([perform(), perform()]);
    expect(first).toMatchObject({ status: 201 });
    expect(second).toMatchObject({ status: 201 });
    if (first.kind === 'conflict' || second.kind === 'conflict')
      throw Error('EXPECTED_MATCHING_REPLAY');
    expect(first.body).toEqual(second.body);
    const count = await withTenantTx(web.db, f.owner, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int n from work.work_units where title=${title}`,
      ),
    );
    expect(count.rows[0]?.n).toBe(1);
    const invalidTitle = 'Generated rolled back proposal ' + randomUUID();
    await expect(
      createBusinessRecordProposal(web.db, f.owner, {
        ...input,
        title: invalidTitle,
        changes: { name: 'Read-only' },
      }),
    ).rejects.toEqual(code('INVALID_INPUT'));
    const absent = await withTenantTx(web.db, f.owner, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int n from work.work_units where title=${invalidTitle}`,
      ),
    );
    expect(absent.rows[0]?.n).toBe(0);
  });
  it('shares the new confidential Work with an actual independent source reader before asking for review', async () => {
    const f = await fixture('accounting_http');
    const member = people.a.member.context;
    await withTenantTx(connector.db, f.service, (tx) =>
      tx.insert(externalResourceAcl).values({
        organizationId: f.owner.organizationId,
        resourceId: f.record.resourceId,
        principalKind: 'user',
        principalExternalId: member.membershipId,
        membershipId: member.membershipId,
        access: 'read',
      }),
    );
    expect(
      (await listBusinessRecordReviewers(web.db, f.owner, f.record.id)).map(
        (row) => row.membershipId,
      ),
    ).toContain(member.membershipId);
    const p = await createBusinessRecordProposal(web.db, f.owner, {
      recordId: f.record.id,
      title: 'Generated annotation review',
      approverMembershipId: member.membershipId,
      kind: 'update',
      expectedVersion: 'source-v1',
      changes: { memo: 'Generated reviewed annotation' },
    });
    expect(await getWorkUnit(web.db, member, p.workUnitId)).toMatchObject({
      classification: 'confidential',
    });
    await expect(
      decideApproval(web.db, member, {
        approvalId: p.approvalId,
        decision: 'approve',
        shownHash: p.requestHash,
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });
  it('refuses an update without a source version before creating an approval', async () => {
    const f = await fixture();
    await withTenantTx(connector.db, f.service, async (tx) => {
      await tx.execute(sql`select set_config('app.business_connection_id',${f.connectionId},true)`);
      await tx
        .update(businessRecords)
        .set({ externalVersion: null })
        .where(eq(businessRecords.id, f.record.id));
      await tx
        .update(externalResources)
        .set({ externalVersion: null })
        .where(eq(externalResources.id, f.record.resourceId));
    });
    await expect(
      proposeRecordUpdate(web.db, f.owner, {
        recordId: f.record.id,
        workUnitId: f.work.id,
        expectedVersion: null,
        changes: { status: 'qualified' },
        approverMembershipId: f.approver.membershipId,
      }),
    ).rejects.toEqual(code('RECORD_VERSION_REQUIRED'));
    expect(
      await withTenantTx(web.db, f.owner, (tx) =>
        tx.select().from(approvals).where(eq(approvals.workUnitId, f.work.id)),
      ),
    ).toEqual([]);
  });
  it('admits actual team grants through the fixed lock and hides the review after team access is removed', async () => {
    const f = await fixture();
    const team = await withTenantTx(web.db, f.owner, async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({
          organizationId: f.owner.organizationId,
          name: 'Generated business source reviewers',
        })
        .returning();
      for (const person of [f.owner, f.approver])
        await tx.insert(teamMemberships).values({
          organizationId: f.owner.organizationId,
          teamId: team!.id,
          membershipId: person.membershipId,
        });
      return team!.id;
    });
    await withTenantTx(connector.db, f.service, async (tx) => {
      await tx
        .delete(externalResourceAcl)
        .where(eq(externalResourceAcl.resourceId, f.record.resourceId));
      await tx.insert(externalResourceAcl).values({
        organizationId: f.owner.organizationId,
        resourceId: f.record.resourceId,
        principalKind: 'group',
        principalExternalId: 'generated-source-review-team',
        teamId: team,
        access: 'read',
      });
    });
    const p = await propose(f);
    expect(await getApproval(web.db, f.approver, p.approvalId)).toMatchObject({
      approval: { id: p.approvalId },
    });
    await decideApproval(web.db, f.approver, {
      approvalId: p.approvalId,
      decision: 'approve',
      shownHash: p.requestHash,
    });
    let release!: () => void, ready!: (value: void) => void, fail!: (reason: unknown) => void;
    const holding = new Promise<void>((resolve) => (release = resolve)),
      locked = new Promise<void>((resolve, reject) => {
        ready = resolve;
        fail = reject;
      });
    const rollback = new Error('GENERATED_TEAM_DELETE_ROLLBACK');
    const deletion = withTenantTx(web.db, f.owner, async (tx) => {
      await tx
        .delete(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, team),
            eq(teamMemberships.membershipId, f.owner.membershipId),
          ),
        );
      ready();
      await holding;
      throw rollback;
    }).catch((error) => {
      if (error !== rollback) {
        fail(error);
        throw error;
      }
    });
    await locked;
    try {
      await expect(
        beginAttempt(connector.db, f.service, {
          externalActionId: p.externalActionId,
          runId: 'generated-busy-team',
        }),
      ).rejects.toEqual(code('VERSION_CONFLICT'));
      expect(await row(f, p.externalActionId)).toMatchObject({ status: 'ready' });
      const attempts = await withTenantTx(connector.db, f.service, (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int n from integrations.external_action_attempts where external_action_id=${p.externalActionId}::uuid`,
        ),
      );
      expect(attempts.rows[0]?.n).toBe(0);
    } finally {
      release();
      await deletion;
    }
    const attempted = await beginAttempt(connector.db, f.service, {
      externalActionId: p.externalActionId,
      runId: 'generated-team-after-rollback',
    });
    expect(attempted.kind).toBe('send');
    if (attempted.kind === 'send')
      await finishAttempt(connector.db, f.service, {
        attemptId: attempted.attempt.attemptId,
        result: { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER' },
      });

    await withTenantTx(web.db, f.owner, (tx) =>
      tx
        .delete(teamMemberships)
        .where(
          and(
            eq(teamMemberships.teamId, team),
            eq(teamMemberships.membershipId, f.approver.membershipId),
          ),
        ),
    );
    await expect(getApproval(web.db, f.approver, p.approvalId)).rejects.toEqual(code('NOT_FOUND'));
  });
  it('only a proven failed effect can be retried and the retry needs a new approval', async () => {
    const f = await fixture(),
      p = await propose(f);
    await expect(
      retryBusinessAction(web.db, f.owner, {
        externalActionId: p.externalActionId,
        approverMembershipId: f.approver.membershipId,
      }),
    ).rejects.toEqual(code('EXTERNAL_ACTION_NOT_RETRYABLE'));
    await decideApproval(web.db, f.approver, {
      approvalId: p.approvalId,
      decision: 'approve',
      shownHash: p.requestHash,
    });
    const begun = await beginAttempt(connector.db, f.service, {
      externalActionId: p.externalActionId,
      runId: 'generated-run',
    });
    if (begun.kind !== 'send') throw Error('EXPECTED_REAL_ATTEMPT');
    await finishAttempt(connector.db, f.service, {
      attemptId: begun.attempt.attemptId,
      result: { outcome: 'rejected', code: 'REFUSED_BY_PROVIDER' },
    });
    const retry = await retryBusinessAction(web.db, f.owner, {
      externalActionId: p.externalActionId,
      approverMembershipId: f.approver.membershipId,
    });
    expect(await row(f, retry.externalActionId)).toMatchObject({
      status: 'awaiting_approval',
      retryOfId: p.externalActionId,
    });
  });
});
