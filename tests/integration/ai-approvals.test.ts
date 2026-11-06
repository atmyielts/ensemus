// AGENT-04, QA-007 agent path, FAULT-06, threat SEC-014, as the real roles (ADR-028 FD-3, FD-4, ADR-027 D1).
//
// WRITTEN AND TYPECHECKED. NOT RUN: it needs the containers, the role provisioning in ADR-028, M3's real
// `proposeExternalActionInTx` and `onApprovalClosedInTx`, the halt slice's `createHaltCheck` and the
// policy-router slice's `decideAction`. On the foundation commit those are stubs that refuse, so every test
// here that reaches one fails until the final merge. Nobody should report it as passing before then.
import { randomUUID } from 'node:crypto';
import {
  createWorkUnit,
  decideApproval,
  requestApproval,
  requestWorkReview,
  transitionWorkUnit,
  unassign,
} from '@ensemus/application';
import { externalActionPort } from '@ensemus/application/ai-external-action-port';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import {
  createApprovalBinder,
  getAgentActionForApproval,
} from '@ensemus/application/ai-tool-approvals';
import {
  agentRuns,
  approvals,
  createOrganization,
  executionSteps,
  externalActions,
  killSwitches,
  openAppDatabase,
  resolveTenantContext,
  stepPayloads,
  toolProposals,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createAgentContext, withRunLookupTx, type AgentContext } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { actionHash } from '@ensemus/domain/approval';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeTestUser,
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  sha256Of,
  testAgentSpec,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { seedConnection, testEmailPayload } from '../helpers/integrations';
import { urls } from '../helpers/stack';

const code = (expected: string) => expect.objectContaining({ code: expected });

describe('binding an agent action to a person, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let a: AiTenant;
  let b: AiTenant;
  let connectionA: string;
  /** Another owner and an admin of tenant A, so there is someone to ask when the owner starts a run. */
  let secondOwner: TenantContext;
  let admin: TenantContext;

  const binder = () =>
    createApprovalBinder({ externalActions: externalActionPort, halt: createHaltCheck() });

  const addMember = async (organizationId: string, role: 'owner' | 'admin' | 'member') => {
    const userId = await makeTestUser(`ai-${role}`);
    const superuser = new pg.Client({ connectionString: urls.superuser() });
    await superuser.connect();
    try {
      await superuser.query(
        `insert into org.memberships (organization_id, user_id, role, status)
         values ($1, $2, $3, 'active')`,
        [organizationId, userId, role],
      );
    } finally {
      await superuser.end();
    }
    return resolveTenantContext(app.db, userId, organizationId);
  };

  const setMemberStatus = async (membershipId: string, status: string) => {
    const superuser = new pg.Client({ connectionString: urls.superuser() });
    await superuser.connect();
    try {
      await superuser.query('update org.memberships set status = $2 where id = $1', [
        membershipId,
        status,
      ]);
    } finally {
      await superuser.end();
    }
  };

  /** A run on its own Work Unit, moved to running by the agent role, with a proposal at step 0. */
  const seedProposal = async (
    tenant: AiTenant,
    initiator: TenantContext,
    input: {
      owner?: TenantContext;
      classification?: 'public' | 'internal' | 'confidential';
    } = {},
  ) => {
    const version = await seedAgentVersion(
      app.db,
      initiator,
      testAgentSpec({ tools: { allow: ['email.send'], deny: [] } }),
    );
    const work = await createWorkUnit(app.db, initiator, {
      title: 'Agent work',
      objective: 'Say something.',
      ...(input.classification ? { classification: input.classification } : {}),
      ...(input.owner ? { ownerMembershipId: input.owner.membershipId } : {}),
    });
    const ready = await transitionWorkUnit(app.db, initiator, {
      id: work.id,
      expectedVersion: work.version,
      to: 'ready',
    });
    await transitionWorkUnit(app.db, initiator, {
      id: work.id,
      expectedVersion: ready.version,
      to: 'running',
    });
    const runId = await seedQueuedRun(app.db, initiator, {
      workUnitId: work.id,
      version,
      tools: ['email.send'],
      ...(input.classification ? { classification: input.classification } : {}),
    });
    const stepId = randomUUID();
    const proposalId = randomUUID();
    const context = await prepareRunInputContext(agent.db, tenant.organizationId, runId);
    await withTenantTx(agent.db, context, async (tx) => {
      await tx.update(agentRuns).set({ status: 'preparing' }).where(eq(agentRuns.id, runId));
      await tx.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
      await tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId,
        stepNumber: 0,
        kind: 'tool_call',
        state: 'in_flight',
        labelCode: 'THINKING',
      });
      await tx.insert(toolProposals).values({
        organizationId: tenant.organizationId,
        id: proposalId,
        runId,
        stepId,
        toolId: 'email.send',
        toolVersion: '1',
        payloadHash: sha256Of(proposalId),
        idempotencyKey: `tool:${runId}:0`,
      });
    });
    return { workUnitId: work.id, runId, proposalId, stepId, version, context };
  };

  const ask = (
    seeded: { workUnitId: string; runId: string; proposalId: string; context: AgentContext },
    connectionId = connectionA,
    payload: unknown = testEmailPayload(),
  ) =>
    withTenantTx(agent.db, seeded.context, (tx) =>
      binder().request(tx, seeded.context, {
        proposalId: seeded.proposalId,
        runId: seeded.runId,
        workUnitId: seeded.workUnitId,
        connectionId,
        toolId: 'email.send',
        toolVersion: '1',
        payload,
      }),
    );

  const recheck = (seeded: { proposalId: string; context: AgentContext }) =>
    withTenantTx(agent.db, seeded.context, (tx) =>
      binder().recheck(tx, seeded.context, { proposalId: seeded.proposalId }),
    );

  const approvalRow = async (context: TenantContext, approvalId: string) => {
    const [row] = await withTenantTx(app.db, context, (tx) =>
      tx.select().from(approvals).where(eq(approvals.id, approvalId)),
    );
    return row;
  };

  const approve = async (context: TenantContext, approvalId: string, shownHash: string) =>
    decideApproval(app.db, context, { approvalId, decision: 'approve', shownHash });

  /** A member started it, the tenant's owner answers for it, and they have approved. */
  const approved = async () => {
    const seeded = await seedProposal(a, a.member, { owner: a.owner });
    const ref = await ask(seeded);
    await approve(a.owner, ref.approvalId, ref.requestHash);
    return { ...seeded, ref };
  };

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 4 });
    agent = openAgentTestDatabase(4);
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
    connectionA = await seedConnection(app.db, a.owner, {
      config: { fromAddress: 'sender@example.invalid' },
    });
    secondOwner = await addMember(a.organizationId, 'owner');
    admin = await addMember(a.organizationId, 'admin');
  });

  afterAll(async () => {
    await app.close();
    await agent.close();
  });

  describe('request', () => {
    it('asks the accountable owner, writes one hash on both rows, and links the proposal', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);

      const approval = await approvalRow(a.owner, ref.approvalId);
      expect(approval?.approverMembershipId).toBe(a.owner.membershipId);
      expect(approval?.requestedByMembershipId).toBe(a.member.membershipId);
      expect(approval?.actionHash).toBe(ref.requestHash);
      expect(actionHash(approval?.action as never)).toBe(ref.requestHash);

      await withTenantTx(app.db, a.owner, async (tx) => {
        const [intent] = await tx
          .select()
          .from(externalActions)
          .where(eq(externalActions.id, ref.externalActionId));
        expect(intent?.requestHash).toBe(ref.requestHash);
        expect(intent?.approvalId).toBe(ref.approvalId);
        const [proposal] = await tx
          .select()
          .from(toolProposals)
          .where(eq(toolProposals.id, seeded.proposalId));
        expect(proposal?.approvalId).toBe(ref.approvalId);
        expect(proposal?.externalActionId).toBe(ref.externalActionId);
        expect(proposal?.status).toBe('awaiting_approval');
      });
    });

    it('a retry finds the same approval and asks nobody twice', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const first = await ask(seeded);
      await expect(ask(seeded)).resolves.toEqual(first);
    });

    it('asks another owner or admin when the owner started the run, and never them', async () => {
      const seeded = await seedProposal(a, a.owner);
      const ref = await ask(seeded);
      const approval = await approvalRow(a.owner, ref.approvalId);
      expect(approval?.approverMembershipId).not.toBe(a.owner.membershipId);
      expect([secondOwner.membershipId, admin.membershipId]).toContain(
        approval?.approverMembershipId,
      );
    });

    it('refuses NO_ELIGIBLE_APPROVER in a tenant with one person, and writes nothing', async () => {
      const alone = await makeTestUser('alone');
      const { organizationId } = await createOrganization(app.db, {
        userId: alone,
        name: 'Same Name Ltd',
        commercialMode: 'byom',
      });
      const owner = await resolveTenantContext(app.db, alone, organizationId);
      const tenant = { organizationId, owner, member: owner };
      const connection = await seedConnection(app.db, owner, {
        config: { fromAddress: 'sender@example.invalid' },
      });
      const seeded = await seedProposal(tenant, owner);
      await expect(ask(seeded, connection)).rejects.toEqual(code('NO_ELIGIBLE_APPROVER'));
      const rows = await withTenantTx(app.db, owner, (tx) => tx.select().from(externalActions));
      expect(rows).toEqual([]);
    });

    it("cannot use another tenant's connection, proposal or run", async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const foreign = await seedConnection(app.db, b.owner, {
        config: { fromAddress: 'sender@example.invalid' },
      });
      await expect(ask(seeded, foreign)).rejects.toEqual(code('NOT_FOUND'));

      const theirs = await seedProposal(b, b.member, { owner: b.owner });
      await expect(
        withTenantTx(agent.db, seeded.context, (tx) =>
          binder().request(tx, seeded.context, {
            proposalId: theirs.proposalId,
            runId: seeded.runId,
            workUnitId: seeded.workUnitId,
            connectionId: connectionA,
            toolId: 'email.send',
            toolVersion: '1',
            payload: testEmailPayload(),
          }),
        ),
      ).rejects.toEqual(code('NOT_FOUND'));
    });

    it('an initiator without access to the work cannot get an approval asked for', async () => {
      const seeded = await seedProposal(a, a.member, {
        owner: a.owner,
        classification: 'confidential',
      });
      await unassign(app.db, a.owner, {
        id: seeded.workUnitId,
        membershipId: a.member.membershipId,
      });
      await expect(ask(seeded)).rejects.toEqual(code('NOT_FOUND'));
    });
  });

  describe('who may decide', () => {
    it('refuses naming the initiator as approver, through any path (APPROVAL_SELF_APPROVAL)', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      await expect(
        requestApproval(agent.db, seeded.context, {
          workUnitId: seeded.workUnitId,
          action: {
            toolName: 'email.send',
            toolVersion: '1',
            targetRef: `connection:${connectionA}`,
            payload: testEmailPayload(),
          },
          approverMembershipId: a.member.membershipId,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toEqual(code('APPROVAL_SELF_APPROVAL'));
    });

    it('refuses the initiator deciding what was asked of someone else', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);
      await expect(approve(a.member, ref.approvalId, ref.requestHash)).rejects.toEqual(
        code('APPROVAL_WRONG_APPROVER'),
      );
      const row = await approvalRow(a.owner, ref.approvalId);
      expect(row?.status).toBe('pending');
      expect(row?.requestedByMembershipId).toBe(a.member.membershipId);
    });

    it('refuses an agent context, so a model has no path to approve', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);
      await expect(approve(seeded.context, ref.approvalId, ref.requestHash)).rejects.toEqual(
        code('FORBIDDEN'),
      );
      // Even an agent acting for the person who was named.
      const asOwner = await createAgentContext(agent.db, {
        organizationId: a.organizationId,
        initiatorMembershipId: a.owner.membershipId,
        agentRunId: seeded.runId,
      });
      await expect(approve(asOwner, ref.approvalId, ref.requestHash)).rejects.toEqual(
        code('FORBIDDEN'),
      );
      expect((await approvalRow(a.owner, ref.approvalId))?.status).toBe('pending');
    });

    it('refuses a service context', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);
      await expect(
        approve(createServiceContext(a.organizationId), ref.approvalId, ref.requestHash),
      ).rejects.toEqual(code('FORBIDDEN'));
    });

    it('refuses a decision on anything but the hash that was shown', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);
      await expect(approve(a.owner, ref.approvalId, 'f'.repeat(64))).rejects.toEqual(
        code('APPROVAL_HASH_MISMATCH'),
      );
    });
  });

  describe('recheck', () => {
    it('passes after a real approval, and fails before one', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);
      await expect(recheck(seeded)).resolves.toEqual({ ok: false, code: 'APPROVAL_NOT_VALID' });
      await approve(a.owner, ref.approvalId, ref.requestHash);
      await expect(recheck(seeded)).resolves.toEqual({ ok: true });
    });

    it('refuses every role writing the payload of an intent or the action of an approval', async () => {
      const seeded = await approved();
      for (const database of [app.db, agent.db]) {
        await expect(
          withTenantTx(database, a.owner, (tx) =>
            tx
              .update(externalActions)
              .set({ payload: testEmailPayload({ to: ['attacker@example.invalid'] }) })
              .where(eq(externalActions.id, seeded.ref.externalActionId)),
          ),
        ).rejects.toThrow();
        await expect(
          withTenantTx(database, a.owner, (tx) =>
            tx
              .update(approvals)
              .set({ action: { toolName: 'email.send' } })
              .where(eq(approvals.id, seeded.ref.approvalId)),
          ),
        ).rejects.toThrow();
      }
    });

    it('denies after the payload is changed beneath it (FAULT-06), caught as the superuser would do it', async () => {
      const seeded = await approved();
      const superuser = new pg.Client({ connectionString: urls.superuser() });
      await superuser.connect();
      try {
        await superuser.query(
          `update integrations.external_actions set payload = $2::jsonb where id = $1`,
          [
            seeded.ref.externalActionId,
            JSON.stringify(testEmailPayload({ to: ['attacker@example.invalid'] })),
          ],
        );
      } finally {
        await superuser.end();
      }
      await expect(recheck(seeded)).resolves.toEqual({ ok: false, code: 'PAYLOAD_CHANGED' });
    });

    it('denies past its time, whatever the row says', async () => {
      const seeded = await approved();
      const superuser = new pg.Client({ connectionString: urls.superuser() });
      await superuser.connect();
      try {
        await superuser.query(
          `update work.approvals set expires_at = now() - interval '1 second' where id = $1`,
          [seeded.ref.approvalId],
        );
      } finally {
        await superuser.end();
      }
      await expect(recheck(seeded)).resolves.toEqual({ ok: false, code: 'APPROVAL_EXPIRED' });
    });

    it('sees a stop in the same transaction, and a stop has to wait for it to finish', async () => {
      const seeded = await approved();
      let stopped = false;
      const stopping = await withTenantTx(agent.db, seeded.context, async (tx) => {
        const first = await binder().recheck(tx, seeded.context, {
          proposalId: seeded.proposalId,
        });
        expect(first).toEqual({ ok: true });
        // Another connection's stop blocks on this transaction's share lock on the run.
        const stop = withRunLookupTx(agent.db, a.organizationId, (other) =>
          other
            .update(agentRuns)
            .set({ status: 'cancelled' })
            .where(eq(agentRuns.id, seeded.runId)),
        ).then(() => {
          stopped = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(stopped).toBe(false);
        // Handed out wrapped, because awaiting it in here would wait on this transaction itself.
        return { stop };
      });
      await stopping.stop;
      expect(stopped).toBe(true);
      await expect(recheck(seeded)).resolves.toEqual({ ok: false, code: 'RUN_NOT_RUNNING' });
    });

    it('stops at a kill switch engaged after the approval', async () => {
      const seeded = await approved();
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.insert(killSwitches).values({
          organizationId: a.organizationId,
          scope: 'agent_version',
          targetRef: seeded.version.versionId,
          reasonCode: 'TEST',
          engagedByMembershipId: a.owner.membershipId,
        }),
      );
      await expect(recheck(seeded)).resolves.toEqual({ ok: false, code: 'HALTED' });
    });

    it('cannot use an approval from another run or Work Unit', async () => {
      const mine = await seedProposal(a, a.member, { owner: a.owner });
      const other = await approved();
      await expect(
        recheck({ proposalId: other.proposalId, context: mine.context }),
      ).resolves.toEqual({ ok: false, code: 'APPROVAL_NOT_VALID' });
    });

    it("cannot use another tenant's proposal", async () => {
      const mine = await seedProposal(a, a.member, { owner: a.owner });
      const theirs = await seedProposal(b, b.member, { owner: b.owner });
      await expect(
        recheck({ proposalId: theirs.proposalId, context: mine.context }),
      ).resolves.toEqual({ ok: false, code: 'APPROVAL_NOT_VALID' });
    });

    it('closes the approval when the approver loses access, which stops M3 spending it', async () => {
      const seeded = await seedProposal(a, a.member, { owner: admin });
      const ref = await ask(seeded);
      await approve(admin, ref.approvalId, ref.requestHash);
      await setMemberStatus(admin.membershipId, 'disabled');
      try {
        await expect(recheck(seeded)).resolves.toEqual({
          ok: false,
          code: 'APPROVER_LOST_ACCESS',
        });
        const row = await approvalRow(a.owner, ref.approvalId);
        expect(row?.status).toBe('cancelled');
        const [intent] = await withTenantTx(app.db, a.owner, (tx) =>
          tx.select().from(externalActions).where(eq(externalActions.id, ref.externalActionId)),
        );
        expect(intent?.status).toBe('cancelled');
      } finally {
        await setMemberStatus(admin.membershipId, 'active');
      }
    });

    it('stops when the initiator is disabled mid-run', async () => {
      const seeded = await approved();
      await setMemberStatus(a.member.membershipId, 'disabled');
      try {
        await expect(recheck(seeded)).resolves.toEqual({ ok: false, code: 'POLICY_DENIED' });
      } finally {
        await setMemberStatus(a.member.membershipId, 'active');
      }
    });

    it('stops when the initiator is taken off confidential work', async () => {
      const seeded = await seedProposal(a, a.member, {
        owner: a.owner,
        classification: 'confidential',
      });
      const ref = await ask(seeded);
      await approve(a.owner, ref.approvalId, ref.requestHash);
      await unassign(app.db, a.owner, {
        id: seeded.workUnitId,
        membershipId: a.member.membershipId,
      });
      await expect(recheck(seeded)).resolves.toEqual({ ok: false, code: 'POLICY_DENIED' });
    });
  });

  describe('what the screen reads, as the web role', () => {
    it('gives the initiator, the agent, the exact payload, class, risk and expiry', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);
      const view = await getAgentActionForApproval(app.db, a.owner, ref.approvalId);
      expect(view).toMatchObject({
        initiatorMembershipId: a.member.membershipId,
        agentVersionId: seeded.version.versionId,
        agentRunId: seeded.runId,
        toolId: 'email.send',
        toolVersion: '1',
        dataClass: 'internal',
        riskLabel: 'external_write',
        requestHash: ref.requestHash,
        consistent: true,
      });
      expect(view?.email?.to).toEqual(testEmailPayload().to);
      expect(view?.expiresAt).toBeInstanceOf(Date);
    });

    it('is null for a review no agent asked for', async () => {
      const other = await createWorkUnit(app.db, a.member, { title: 'Plain', objective: 'Plain.' });
      const review = await requestWorkReview(app.db, a.member, {
        workUnitId: other.id,
        expectedVersion: other.version,
        approverMembershipId: a.owner.membershipId,
      });
      await expect(getAgentActionForApproval(app.db, a.owner, review.id)).resolves.toBeNull();
    });

    it('answers not found for an approval ID from another tenant', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      const ref = await ask(seeded);
      await expect(getAgentActionForApproval(app.db, b.owner, ref.approvalId)).rejects.toEqual(
        code('NOT_FOUND'),
      );
    });

    it('answers not found for someone in the tenant who cannot read the work', async () => {
      const seeded = await seedProposal(a, a.owner, { classification: 'confidential' });
      const ref = await ask(seeded);
      await expect(getAgentActionForApproval(app.db, a.member, ref.approvalId)).rejects.toEqual(
        code('NOT_FOUND'),
      );
    });

    it('never needs a prompt: the web role cannot read one, and this still works', async () => {
      const seeded = await seedProposal(a, a.member, { owner: a.owner });
      await withTenantTx(agent.db, seeded.context, (tx) =>
        tx.insert(stepPayloads).values({
          organizationId: a.organizationId,
          stepId: seeded.stepId,
          kind: 'prompt',
          classification: 'internal',
          content: 'a prompt',
          contentSha256: sha256Of('a prompt'),
        }),
      );
      const ref = await ask(seeded);
      await expect(
        withTenantTx(app.db, a.owner, (tx) => tx.select().from(stepPayloads)),
      ).rejects.toThrow();
      const view = await getAgentActionForApproval(app.db, a.owner, ref.approvalId);
      expect(JSON.stringify(view)).not.toContain('a prompt');
    });
  });
});
