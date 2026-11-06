// AGENT-03, AI-TS-01, threats SEC-003, SEC-007, SEC-008, SEC-015: the tool gateway against the real roles,
// row-level security and triggers, with two tenants of the same name. Written and typechecked. It has not
// been run: it needs containers, and it needs the context, halt and approvals slices merged, because this
// branch has their fail-closed stubs. The scripted proposals below are what a model that obeyed every
// injection would ask for, so a pass proves the control and not a refusal.
import { randomUUID } from 'node:crypto';
import { addArtifact, createWorkUnit, type ObjectStore } from '@ensemus/application';
import { createContextSource } from '@ensemus/application/ai-context-source';
import { externalActionPort } from '@ensemus/application/ai-external-action-port';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import type { ApprovalBinder, ExternalActionPort } from '@ensemus/application/ai-ports';
import { createApprovalBinder } from '@ensemus/application/ai-tool-approvals';
import {
  createToolStepStore,
  loadProposal,
  storeProposal,
} from '@ensemus/application/ai-tool-steps';
import { createToolGateway, MAX_TOOL_OUTPUT_BYTES } from '@ensemus/agent-runtime/tools';
import {
  agentRuns,
  artifactEvidence,
  artifacts,
  auditEvents,
  executionSteps,
  externalActionAttempts,
  killSwitches,
  openAppDatabase,
  stepPayloads,
  toolProposals,
  usageLedger,
  withTenantTx,
  workUnits,
  type TenantContext,
} from '@ensemus/database';
import { createAgentContext, withRunLookupTx } from '@ensemus/database/agent';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdsCanary, tenantCanary } from '../helpers/ai/canaries';
import {
  openAgentTestDatabase,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  testAgentSpec,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { seedConnection, seedExternalAction, testEmailPayload } from '../helpers/integrations';
import { urls } from '../helpers/stack';

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('missing');
    return body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

const ALL_TOOLS = [
  'work.read',
  'artifact.read_text',
  'artifact.draft.create',
  'email.send',
  'agent.delegate',
];

describe('tool gateway, as the real roles', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let agent: ReturnType<typeof openAgentTestDatabase>;
  let su: pg.Client;
  let a: AiTenant;
  let b: AiTenant;
  const objects = new MemoryStore();

  beforeAll(async () => {
    app = openAppDatabase(urls.app(), { max: 3 });
    agent = openAgentTestDatabase(4);
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    a = await seedAiTenant(app.db);
    b = await seedAiTenant(app.db);
  });

  afterAll(async () => {
    await su.end();
    await app.close();
    await agent.close();
  });

  const source = () =>
    createContextSource({
      database: agent.db,
      readObject: async (key) => objects.get(key),
    });

  /** The real thing, end to end: M3's port and the approvals slice's binder. */
  const realGateway = () =>
    createToolGateway({
      source: source(),
      externalActions: externalActionPort,
      approvals: createApprovalBinder({
        externalActions: externalActionPort,
        halt: createHaltCheck(),
      }),
      halt: createHaltCheck(),
      store: createToolStepStore({ database: agent.db, objects }),
    });

  /** The same gateway over real storage, with the effect side scripted. */
  const gatewayOver = (externalActions: ExternalActionPort, approvals: ApprovalBinder) =>
    createToolGateway({
      source: source(),
      externalActions,
      approvals,
      halt: createHaltCheck(),
      store: createToolStepStore({ database: agent.db, objects }),
    });

  const work = async (
    context: TenantContext,
    classification: 'public' | 'internal' | 'confidential' | 'restricted' = 'internal',
    title = 'Agent work',
  ) => (await createWorkUnit(app.db, context, { title, objective: 'Do it.', classification })).id;

  /** A run moved to `running` as the agent role moves one, with its initiator's fresh context. */
  async function startRun(
    context: TenantContext,
    input: {
      workUnitId: string;
      allow?: readonly string[];
      deny?: readonly string[];
      delegated?: readonly string[];
      classification?: 'public' | 'internal' | 'confidential' | 'restricted';
      maxDelegationDepth?: number;
    },
  ) {
    const allow = input.allow ?? ALL_TOOLS;
    const version = await seedAgentVersion(
      app.db,
      context,
      testAgentSpec({ tools: { allow, deny: input.deny ?? [] } }),
    );
    const runId = await seedQueuedRun(app.db, context, {
      workUnitId: input.workUnitId,
      version,
      tools: input.delegated ?? allow,
      ...(input.classification ? { classification: input.classification } : {}),
      ...(input.maxDelegationDepth === undefined
        ? {}
        : { limits: { maxDelegationDepth: input.maxDelegationDepth } }),
    });
    await moveRun(context.organizationId, runId, 'preparing');
    await moveRun(context.organizationId, runId, 'running');
    const agentContext = await createAgentContext(agent.db, {
      organizationId: context.organizationId,
      initiatorMembershipId: context.membershipId,
      agentRunId: runId,
    });
    return {
      runId,
      agentContext,
      ref: (stepNumber: number) => ({
        runId,
        stepNumber,
        workUnitId: input.workUnitId,
        agentVersionId: version.versionId,
      }),
    };
  }

  const moveRun = (
    organizationId: string,
    runId: string,
    status: 'preparing' | 'running' | 'cancelled' | 'completed' | 'verifying',
  ) =>
    withRunLookupTx(agent.db, organizationId, (tx) =>
      tx.update(agentRuns).set({ status }).where(eq(agentRuns.id, runId)),
    );

  type Run = Awaited<ReturnType<typeof startRun>>;

  /** What a model turn does, then what the workflow does: store the proposal, then run the step. */
  async function ask(
    gateway: ReturnType<typeof realGateway>,
    run: Run,
    toolId: string,
    args: unknown,
    stepNumber = 1,
  ) {
    await storeProposal(agent.db, run.agentContext, {
      runId: run.runId,
      stepNumber,
      toolId,
      args,
    });
    return gateway.handle(run.agentContext, run.ref(stepNumber));
  }

  const runRow = async (organizationId: string, runId: string) => {
    const [row] = await withRunLookupTx(agent.db, organizationId, (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, runId)),
    );
    if (!row) throw new Error('No such run');
    return row;
  };

  const payloadsOf = (organizationId: string, runId: string) =>
    withRunLookupTx(agent.db, organizationId, (tx) =>
      tx
        .select({
          kind: stepPayloads.kind,
          content: stepPayloads.content,
          classification: stepPayloads.classification,
        })
        .from(stepPayloads)
        .innerJoin(executionSteps, eq(executionSteps.id, stepPayloads.stepId))
        .where(eq(executionSteps.runId, runId)),
    );

  const ledgerOf = (organizationId: string, runId: string) =>
    withRunLookupTx(agent.db, organizationId, (tx) =>
      tx.select().from(usageLedger).where(eq(usageLedger.runId, runId)),
    );

  describe('allowlist and parse', () => {
    it('refuses a tool outside the grants, and one the run was not delegated', async () => {
      const notAllowed = await startRun(a.owner, {
        workUnitId: await work(a.owner),
        allow: ['work.read'],
      });
      await expect(
        ask(realGateway(), notAllowed, 'artifact.draft.create', {
          name: 'n',
          text: 't',
          evidence: [],
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_NOT_GRANTED' });

      const notDelegated = await startRun(a.owner, {
        workUnitId: await work(a.owner),
        delegated: ['work.read'],
      });
      await expect(
        ask(realGateway(), notDelegated, 'artifact.draft.create', {
          name: 'n',
          text: 't',
          evidence: [],
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_NOT_GRANTED' });
    });

    it('lets deny win', async () => {
      const run = await startRun(a.owner, {
        workUnitId: await work(a.owner),
        deny: ['email.send'],
      });
      await expect(
        ask(realGateway(), run, 'email.send', {
          connection_id: randomUUID(),
          email: testEmailPayload(),
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_DENIED_BY_SPEC' });
    });

    it('refuses an invented tool, and its name reaches nothing the web tier can read', async () => {
      const canary = tenantCanary();
      const run = await startRun(a.owner, { workUnitId: await work(a.owner) });
      await expect(
        ask(realGateway(), run, `${canary}.exfiltrate`, { to: canary }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_UNKNOWN' });
      const visible = await withTenantTx(app.db, a.owner, async (tx) => ({
        proposals: await tx.select().from(toolProposals).where(eq(toolProposals.runId, run.runId)),
        steps: await tx.select().from(executionSteps).where(eq(executionSteps.runId, run.runId)),
        audit: await tx.select().from(auditEvents),
      }));
      expect(visible.proposals[0]?.toolId).toBe('unknown');
      expect(holdsCanary(JSON.stringify(visible), canary)).toBe(false);
    });

    it.each(['model.set_profile', 'grant.add', 'budget.raise', 'secrets.read'])(
      'has no tool %s, even when a stored spec and scope name it',
      async (toolId) => {
        const run = await startRun(a.owner, {
          workUnitId: await work(a.owner),
          allow: [toolId],
        });
        const before = await runRow(a.organizationId, run.runId);
        await expect(
          ask(realGateway(), run, toolId, { limit_micros: 999_999_999 }),
        ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_UNKNOWN' });
        const after = await runRow(a.organizationId, run.runId);
        expect(after.maxCostMicros).toBe(before.maxCostMicros);
        expect(after.delegatedScopes).toEqual(before.delegatedScopes);
        expect(after.boundProfileId).toBe(before.boundProfileId);
      },
    );

    it('refuses bad arguments and extra arguments', async () => {
      const unit = await work(a.owner);
      const bad = await startRun(a.owner, { workUnitId: unit });
      await expect(
        ask(realGateway(), bad, 'work.read', { work_unit_id: 'nope' }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_ARGS_INVALID' });
      await expect(
        ask(realGateway(), bad, 'work.read', { work_unit_id: unit, budget: 1 }, 2),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_ARGS_INVALID' });
    });

    it('records a refusal for arguments too large to store, and keeps no copy', async () => {
      const run = await startRun(a.owner, { workUnitId: await work(a.owner) });
      await expect(
        ask(realGateway(), run, 'work.read', { padding: 'x'.repeat(2_000_000) }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_ARGS_INVALID' });
      expect(await payloadsOf(a.organizationId, run.runId)).toEqual([]);
    });

    it('keeps the first proposal when a retried turn stores another', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit });
      const first = await storeProposal(agent.db, run.agentContext, {
        runId: run.runId,
        stepNumber: 1,
        toolId: 'work.read',
        args: { work_unit_id: unit },
      });
      const again = await storeProposal(agent.db, run.agentContext, {
        runId: run.runId,
        stepNumber: 1,
        toolId: 'email.send',
        args: { connection_id: randomUUID(), email: testEmailPayload() },
      });
      expect(again.proposalId).toBe(first.proposalId);
      const stored = await loadProposal(agent.db, run.agentContext, {
        runId: run.runId,
        stepNumber: 1,
      });
      expect(stored).toMatchObject({ toolId: 'work.read', args: { work_unit_id: unit } });
    });

    it('refuses a payload altered after it was stored', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit });
      await storeProposal(agent.db, run.agentContext, {
        runId: run.runId,
        stepNumber: 1,
        toolId: 'work.read',
        args: { work_unit_id: unit },
      });
      await su.query(
        `update ai.step_payloads set content = $1
          where step_id in (select id from ai.execution_steps where run_id = $2)`,
        [JSON.stringify({ work_unit_id: randomUUID() }), run.runId],
      );
      await expect(realGateway().handle(run.agentContext, run.ref(1))).resolves.toMatchObject({
        outcome: 'denied',
        decisionCode: 'TOOL_ARGS_INVALID',
      });
    });
  });

  describe('principal and resource ACL', () => {
    it('reads as the initiator: restricted work the agent role could see is not found', async () => {
      const own = await work(a.owner);
      const closed = await work(a.owner, 'confidential');
      const run = await startRun(a.member, { workUnitId: own, allow: ['work.read'] });
      await expect(
        ask(realGateway(), run, 'work.read', { work_unit_id: closed }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'RESOURCE_NOT_PERMITTED' });
      // The role could read that row: this is the check that the context, and not RLS, said no.
      const rows = await withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx.select({ id: workUnits.id }).from(workUnits).where(eq(workUnits.id, closed)),
      );
      expect(rows).toHaveLength(1);
    });

    it('refuses a resource in another tenant, with the same names on both sides', async () => {
      const theirs = await work(b.owner, 'internal', 'Agent work');
      const run = await startRun(a.owner, { workUnitId: await work(a.owner) });
      await expect(
        ask(realGateway(), run, 'work.read', { work_unit_id: theirs }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'RESOURCE_NOT_PERMITTED' });
      const theirFile = await addArtifact(app.db, objects, b.owner, {
        workUnitId: theirs,
        name: 'theirs.txt',
        mimeType: 'text/plain',
        body: Buffer.from('theirs'),
      });
      await expect(
        ask(realGateway(), run, 'artifact.read_text', { artifact_id: theirFile.id }, 2),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'RESOURCE_NOT_PERMITTED' });
      await expect(
        ask(
          realGateway(),
          run,
          'artifact.draft.create',
          {
            name: 'n',
            text: 't',
            evidence: [{ source_type: 'artifact', source_id: theirFile.id }],
          },
          3,
        ),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'RESOURCE_NOT_PERMITTED' });
    });

    it('cannot act on another tenant’s run, even with its ID', async () => {
      const unit = await work(a.owner);
      const victim = await startRun(a.owner, { workUnitId: unit });
      await storeProposal(agent.db, victim.agentContext, {
        runId: victim.runId,
        stepNumber: 1,
        toolId: 'work.read',
        args: { work_unit_id: unit },
      });
      const attacker = await createAgentContext(agent.db, {
        organizationId: b.organizationId,
        initiatorMembershipId: b.owner.membershipId,
        agentRunId: victim.runId,
      });
      await expect(realGateway().handle(attacker, victim.ref(1))).resolves.toMatchObject({
        outcome: 'denied',
        decisionCode: 'POLICY_UNREADABLE',
      });
      expect(await payloadsOf(a.organizationId, victim.runId)).toHaveLength(1);
    });

    it('cannot store or load a proposal for a run that is not this context’s', async () => {
      const unit = await work(a.owner);
      const one = await startRun(a.owner, { workUnitId: unit });
      const other = await startRun(a.owner, { workUnitId: await work(a.owner) });
      await expect(
        storeProposal(agent.db, other.agentContext, {
          runId: one.runId,
          stepNumber: 1,
          toolId: 'work.read',
          args: {},
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        loadProposal(agent.db, other.agentContext, { runId: one.runId, stepNumber: 1 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('stops when the initiator is disabled mid-run', async () => {
      const tenant = await seedAiTenant(app.db);
      const unit = await work(tenant.member);
      const run = await startRun(tenant.member, { workUnitId: unit, allow: ['work.read'] });
      await su.query(`update org.memberships set status = 'disabled' where id = $1`, [
        tenant.member.membershipId,
      ]);
      await expect(
        ask(realGateway(), run, 'work.read', { work_unit_id: unit }),
      ).resolves.toMatchObject({ outcome: 'stopped', decisionCode: 'INITIATOR_INACTIVE' });
      expect(
        (await payloadsOf(tenant.organizationId, run.runId)).filter(
          (payload) => payload.kind === 'tool_output',
        ),
      ).toEqual([]);
    });

    it('does not let a person who is only allowed to read create a draft', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.member, {
        workUnitId: unit,
        allow: ['artifact.draft.create'],
      });
      await expect(
        ask(realGateway(), run, 'artifact.draft.create', { name: 'n', text: 't', evidence: [] }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'RESOURCE_NOT_PERMITTED' });
    });
  });

  describe('class', () => {
    it('raises the run’s class to what a tool read, in the same commit', async () => {
      const higher = await work(a.owner, 'confidential');
      const run = await startRun(a.owner, { workUnitId: await work(a.owner) });
      await expect(
        ask(realGateway(), run, 'work.read', { work_unit_id: higher }),
      ).resolves.toMatchObject({ outcome: 'done' });
      expect((await runRow(a.organizationId, run.runId)).effectiveClassification).toBe(
        'confidential',
      );
      const output = (await payloadsOf(a.organizationId, run.runId)).find(
        (payload) => payload.kind === 'tool_output',
      );
      expect(output?.classification).toBe('confidential');
    });

    it('never lowers it', async () => {
      const lower = await work(a.owner, 'public');
      const run = await startRun(a.owner, {
        workUnitId: await work(a.owner),
        classification: 'confidential',
      });
      await ask(realGateway(), run, 'work.read', { work_unit_id: lower });
      expect((await runRow(a.organizationId, run.runId)).effectiveClassification).toBe(
        'confidential',
      );
    });

    it('writes a draft at the run’s class, on work of a lower one, and it proves nothing', async () => {
      const unit = await work(a.owner, 'public');
      const run = await startRun(a.owner, {
        workUnitId: unit,
        classification: 'confidential',
      });
      await expect(
        ask(realGateway(), run, 'artifact.draft.create', {
          name: 'Draft',
          text: 'The draft',
          evidence: [{ source_type: 'work_unit', source_id: unit }],
        }),
      ).resolves.toMatchObject({ outcome: 'done' });
      const [draft] = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(artifactEvidence)
          .innerJoin(artifacts, eq(artifacts.id, artifactEvidence.artifactId))
          .where(eq(artifactEvidence.runId, run.runId)),
      );
      expect(draft?.artifacts.classification).toBe('confidential');
      expect(draft?.artifacts.createdByMembershipId).toBeNull();
      expect(draft?.artifact_evidence).toMatchObject({ sourceType: 'work_unit', sourceId: unit });
      expect(objects.objects.get(draft?.artifacts.objectKey ?? '')?.toString()).toBe('The draft');
    });

    it('refuses a citation of something the initiator cannot read', async () => {
      const closed = await work(a.owner, 'confidential');
      const unit = await work(a.member);
      const run = await startRun(a.member, {
        workUnitId: unit,
        allow: ['artifact.draft.create'],
      });
      await expect(
        ask(realGateway(), run, 'artifact.draft.create', {
          name: 'n',
          text: 't',
          evidence: [{ source_type: 'work_unit', source_id: closed }],
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'RESOURCE_NOT_PERMITTED' });
    });
  });

  describe('caps and the record', () => {
    it('refuses a file over the output cap', async () => {
      const unit = await work(a.owner);
      const big = await addArtifact(app.db, objects, a.owner, {
        workUnitId: unit,
        name: 'big.txt',
        mimeType: 'text/plain',
        body: Buffer.alloc(MAX_TOOL_OUTPUT_BYTES + 1, 'x'),
      });
      const run = await startRun(a.owner, { workUnitId: unit });
      await expect(
        ask(realGateway(), run, 'artifact.read_text', { artifact_id: big.id }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'RESOURCE_NOT_PERMITTED' });
    });

    it('keeps tool output where the web role cannot read it, and only codes elsewhere', async () => {
      const canary = tenantCanary();
      const unit = await work(a.owner, 'internal', canary);
      const run = await startRun(a.owner, { workUnitId: unit });
      const answer = await ask(realGateway(), run, 'work.read', { work_unit_id: unit });
      expect(holdsCanary(JSON.stringify(answer), canary)).toBe(false);
      const stored = await payloadsOf(a.organizationId, run.runId);
      expect(holdsCanary(JSON.stringify(stored), canary)).toBe(true);
      await expect(
        withTenantTx(app.db, a.owner, (tx) => tx.select().from(stepPayloads)),
      ).rejects.toThrow();
      const visible = await withTenantTx(app.db, a.owner, async (tx) => ({
        steps: await tx.select().from(executionSteps).where(eq(executionSteps.runId, run.runId)),
        proposals: await tx.select().from(toolProposals).where(eq(toolProposals.runId, run.runId)),
      }));
      expect(holdsCanary(JSON.stringify(visible), canary)).toBe(false);
    });

    it('records one tool_call row, audit named for the agent, and one answer on a retry', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit });
      const gateway = realGateway();
      await ask(gateway, run, 'work.read', { work_unit_id: unit });
      await expect(gateway.handle(run.agentContext, run.ref(1))).resolves.toMatchObject({
        outcome: 'done',
      });
      const ledger = await ledgerOf(a.organizationId, run.runId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        meter: 'tool_call',
        quantity: 1,
        costMicros: 0,
        billable: false,
        idempotencyKey: `tool:${run.runId}:1`,
      });
      const outputs = (await payloadsOf(a.organizationId, run.runId)).filter(
        (payload) => payload.kind === 'tool_output',
      );
      expect(outputs).toHaveLength(1);
      const audit = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.action, 'ai.tool_done'), eq(auditEvents.actorId, run.runId))),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorType).toBe('agent');
    });

    it('finds a proposal from the turn’s own number or the tool step after it', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit });
      await withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx.insert(executionSteps).values({
          organizationId: a.organizationId,
          runId: run.runId,
          stepNumber: 4,
          kind: 'model_turn',
          state: 'completed',
          labelCode: 'THINKING',
        }),
      );
      await storeProposal(agent.db, run.agentContext, {
        runId: run.runId,
        stepNumber: 4,
        toolId: 'work.read',
        args: { work_unit_id: unit },
      });
      await expect(realGateway().handle(run.agentContext, run.ref(5))).resolves.toMatchObject({
        outcome: 'done',
      });
      // The turn stays a turn. The tool has its own row, and step 6 finds nothing to run.
      const steps = await withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx.select().from(executionSteps).where(eq(executionSteps.runId, run.runId)),
      );
      expect(steps.map((row) => [row.stepNumber, row.kind]).sort()).toEqual([
        [4, 'model_turn'],
        [5, 'tool_call'],
      ]);
      await expect(realGateway().handle(run.agentContext, run.ref(6))).resolves.toMatchObject({
        outcome: 'denied',
        decisionCode: 'POLICY_UNREADABLE',
      });
    });
  });

  describe('stopping', () => {
    it('stops a tool once a person’s stop is committed, with no signal at all', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit });
      await su.query(
        `insert into ai.run_controls (organization_id, run_id, kind, by_membership_id)
         values ($1, $2, 'stop', $3)`,
        [a.organizationId, run.runId, a.owner.membershipId],
      );
      await expect(
        ask(realGateway(), run, 'work.read', { work_unit_id: unit }),
      ).resolves.toMatchObject({ outcome: 'stopped' });
      expect(await ledgerOf(a.organizationId, run.runId)).toEqual([]);
    });

    it('stops for a kill switch on this version, and not for another tenant’s', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit });
      await withTenantTx(app.db, b.owner, (tx) =>
        tx.insert(killSwitches).values({
          organizationId: b.organizationId,
          scope: 'organization',
          reasonCode: 'INCIDENT',
          engagedByMembershipId: b.owner.membershipId,
        }),
      );
      await expect(
        ask(realGateway(), run, 'work.read', { work_unit_id: unit }),
      ).resolves.toMatchObject({ outcome: 'done' });
      const halted = await startRun(a.owner, { workUnitId: await work(a.owner) });
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.insert(killSwitches).values({
          organizationId: a.organizationId,
          scope: 'agent_version',
          targetRef: halted.ref(1).agentVersionId,
          reasonCode: 'INCIDENT',
          engagedByMembershipId: a.owner.membershipId,
        }),
      );
      await expect(
        ask(realGateway(), halted, 'work.read', { work_unit_id: halted.ref(1).workUnitId }),
      ).resolves.toMatchObject({ outcome: 'stopped', decisionCode: 'HALTED' });
    });

    it('stops a tool on a run that ended', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit });
      await moveRun(a.organizationId, run.runId, 'cancelled');
      await expect(
        ask(realGateway(), run, 'work.read', { work_unit_id: unit }),
      ).resolves.toMatchObject({ outcome: 'stopped' });
    });

    it('stops a tool whose run was cancelled while its file was being read', async () => {
      const unit = await work(a.owner);
      const file = await addArtifact(app.db, objects, a.owner, {
        workUnitId: unit,
        name: 'a.txt',
        mimeType: 'text/plain',
        body: Buffer.from('text'),
      });
      const run = await startRun(a.owner, { workUnitId: unit });
      const gateway = createToolGateway({
        source: createContextSource({
          database: agent.db,
          readObject: async (key) => {
            await moveRun(a.organizationId, run.runId, 'cancelled');
            return objects.get(key);
          },
        }),
        externalActions: externalActionPort,
        approvals: createApprovalBinder({
          externalActions: externalActionPort,
          halt: createHaltCheck(),
        }),
        halt: createHaltCheck(),
        store: createToolStepStore({ database: agent.db, objects }),
      });
      await expect(
        ask(gateway, run, 'artifact.read_text', { artifact_id: file.id }),
      ).resolves.toMatchObject({ outcome: 'stopped' });
      expect(await ledgerOf(a.organizationId, run.runId)).toEqual([]);
    });
  });

  describe('email.send, with M3', () => {
    const scripted = async (context: TenantContext, workUnitId: string) => {
      const connectionId = await seedConnection(app.db, context);
      const seeded = await seedExternalAction(app.db, context, {
        workUnitId,
        connectionId,
        approverMembershipId: context.membershipId,
        status: 'awaiting_approval',
      });
      const approvals: ApprovalBinder = {
        request: async () => ({
          approvalId: seeded.approvalId,
          externalActionId: seeded.id,
          requestHash: seeded.requestHash,
        }),
        recheck: async () => ({ ok: true }),
      };
      return { connectionId, seeded, approvals };
    };

    it('does not send twice when a send timed out: AI-TS-01 with a fake port', async () => {
      const unit = await work(a.owner);
      const { connectionId, seeded, approvals } = await scripted(a.owner, unit);
      const run = await startRun(a.owner, { workUnitId: unit });
      const statuses = ['sending', 'reconciling', 'sent'] as const;
      let reads = 0;
      let proposed = 0;
      const gateway = gatewayOver(
        {
          propose: () => Promise.reject(new Error('The binder proposes')),
          readState: async () => ({
            status: statuses[reads++] ?? 'sent',
            approvalId: seeded.approvalId,
          }),
        },
        {
          ...approvals,
          request: (...args) => {
            proposed += 1;
            return approvals.request(...args);
          },
        },
      );
      await expect(
        ask(gateway, run, 'email.send', {
          connection_id: connectionId,
          email: testEmailPayload(),
        }),
      ).resolves.toMatchObject({ outcome: 'needs_approval' });
      await expect(gateway.handle(run.agentContext, run.ref(1))).resolves.toMatchObject({
        outcome: 'needs_approval',
      });
      await expect(gateway.handle(run.agentContext, run.ref(1))).resolves.toMatchObject({
        outcome: 'needs_approval',
      });
      await expect(gateway.handle(run.agentContext, run.ref(1))).resolves.toMatchObject({
        outcome: 'done',
      });
      expect(proposed).toBe(1);
      expect(await ledgerOf(a.organizationId, run.runId)).toHaveLength(1);
    });

    it('stops as unknown, says so on the row, and never asks again', async () => {
      const unit = await work(a.owner);
      const { connectionId, seeded, approvals } = await scripted(a.owner, unit);
      const run = await startRun(a.owner, { workUnitId: unit });
      let reads = 0;
      const gateway = gatewayOver(
        {
          propose: () => Promise.reject(new Error('The binder proposes')),
          readState: async () => {
            reads += 1;
            return { status: 'unknown', approvalId: seeded.approvalId };
          },
        },
        approvals,
      );
      await ask(gateway, run, 'email.send', {
        connection_id: connectionId,
        email: testEmailPayload(),
      });
      await expect(gateway.handle(run.agentContext, run.ref(1))).resolves.toMatchObject({
        outcome: 'unknown_external_state',
      });
      await expect(gateway.handle(run.agentContext, run.ref(1))).resolves.toMatchObject({
        outcome: 'unknown_external_state',
      });
      expect(reads).toBe(1);
      const [proposal] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(toolProposals).where(eq(toolProposals.runId, run.runId)),
      );
      expect(proposal?.status).toBe('unknown_external_state');
      const [row] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(executionSteps).where(eq(executionSteps.runId, run.runId)),
      );
      expect(row?.state).toBe('completed');
      expect(row?.outcome).toBe('unknown_external_state');
    });

    it('proposes through the real port and binder, with an approver from policy', async () => {
      // The member answers for this work and started the run, so the approver has to be someone else.
      const unit = await work(a.member);
      const connectionId = await seedConnection(app.db, a.owner, {
        config: { fromAddress: 'sender@example.invalid' },
      });
      const run = await startRun(a.member, { workUnitId: unit });
      await expect(
        ask(realGateway(), run, 'email.send', {
          connection_id: connectionId,
          email: testEmailPayload(),
        }),
      ).resolves.toMatchObject({ outcome: 'needs_approval', decisionCode: 'APPROVAL_REQUIRED' });
      const [proposal] = await withTenantTx(app.db, a.owner, (tx) =>
        tx.select().from(toolProposals).where(eq(toolProposals.runId, run.runId)),
      );
      expect(proposal?.externalActionId).toBeTruthy();
      expect(proposal?.approvalId).toBeTruthy();
    });

    it('refuses a sender other than the connection’s, as M3 does', async () => {
      const unit = await work(a.member);
      const connectionId = await seedConnection(app.db, a.owner, {
        config: { fromAddress: 'sender@example.invalid' },
      });
      const run = await startRun(a.member, { workUnitId: unit });
      await expect(
        ask(realGateway(), run, 'email.send', {
          connection_id: connectionId,
          email: testEmailPayload({ from: { address: 'spoofed@example.invalid' } }),
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'TOOL_ARGS_INVALID' });
    });

    it('refuses restricted data before anything is proposed', async () => {
      const unit = await work(a.owner);
      const connectionId = await seedConnection(app.db, a.owner, {
        config: { fromAddress: 'sender@example.invalid' },
      });
      const run = await startRun(a.owner, { workUnitId: unit, classification: 'restricted' });
      await expect(
        ask(realGateway(), run, 'email.send', {
          connection_id: connectionId,
          email: testEmailPayload(),
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'CLASS_DENIED' });
    });

    it('has its attempt refused by the trigger once the run has ended', async () => {
      const unit = await work(a.owner);
      const connectionId = await seedConnection(app.db, a.owner);
      const action = await seedExternalAction(app.db, a.owner, {
        workUnitId: unit,
        connectionId,
        approverMembershipId: a.owner.membershipId,
        status: 'ready',
      });
      const run = await startRun(a.owner, { workUnitId: unit });
      await storeProposal(agent.db, run.agentContext, {
        runId: run.runId,
        stepNumber: 1,
        toolId: 'email.send',
        args: { connection_id: connectionId, email: testEmailPayload() },
      });
      await withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx
          .update(toolProposals)
          .set({
            externalActionId: action.id,
            approvalId: action.approvalId,
            status: 'approved',
          })
          .where(eq(toolProposals.runId, run.runId)),
      );
      await moveRun(a.organizationId, run.runId, 'cancelled');

      const attempt = () =>
        withTenantTx(app.db, a.owner, (tx) =>
          tx.insert(externalActionAttempts).values({
            organizationId: a.organizationId,
            externalActionId: action.id,
            attemptNo: 1,
            requestHash: action.requestHash,
            idempotencyKey: `ensemus-${action.id}`,
            runId: 'temporal-run',
          }),
        );
      await expect(attempt()).rejects.toEqual(sqlState('EN007'));
    });

    it('has its attempt let through while the run is still going', async () => {
      const unit = await work(a.owner);
      const connectionId = await seedConnection(app.db, a.owner);
      const action = await seedExternalAction(app.db, a.owner, {
        workUnitId: unit,
        connectionId,
        approverMembershipId: a.owner.membershipId,
        status: 'ready',
      });
      const run = await startRun(a.owner, { workUnitId: unit });
      await storeProposal(agent.db, run.agentContext, {
        runId: run.runId,
        stepNumber: 1,
        toolId: 'email.send',
        args: { connection_id: connectionId, email: testEmailPayload() },
      });
      await withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx
          .update(toolProposals)
          .set({ externalActionId: action.id, approvalId: action.approvalId, status: 'approved' })
          .where(eq(toolProposals.runId, run.runId)),
      );
      await withTenantTx(app.db, a.owner, (tx) =>
        tx.insert(externalActionAttempts).values({
          organizationId: a.organizationId,
          externalActionId: action.id,
          attemptNo: 1,
          requestHash: action.requestHash,
          idempotencyKey: `ensemus-${action.id}`,
          runId: 'temporal-run',
        }),
      );
    });
  });

  describe('agent.delegate', () => {
    it('creates nothing itself', async () => {
      const unit = await work(a.owner);
      const run = await startRun(a.owner, { workUnitId: unit, maxDelegationDepth: 1 });
      await expect(
        ask(realGateway(), run, 'agent.delegate', {
          agent_version_id: randomUUID(),
          title: 'Child',
          tools: ['work.read'],
          max_cost_micros: 10,
        }),
      ).resolves.toEqual({ outcome: 'done', decisionCode: null, delegationRequested: true });
      const children = await withRunLookupTx(agent.db, a.organizationId, (tx) =>
        tx.select().from(agentRuns).where(eq(agentRuns.parentRunId, run.runId)),
      );
      expect(children).toEqual([]);
    });

    it('refuses at depth zero, and refuses asking for more than the run holds', async () => {
      const unit = await work(a.owner);
      const flat = await startRun(a.owner, { workUnitId: unit });
      await expect(
        ask(realGateway(), flat, 'agent.delegate', {
          agent_version_id: randomUUID(),
          title: 'Child',
          tools: [],
          max_cost_micros: 0,
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'DELEGATION_DEPTH' });

      const narrow = await startRun(a.owner, {
        workUnitId: await work(a.owner),
        allow: ['agent.delegate'],
        maxDelegationDepth: 1,
      });
      await expect(
        ask(realGateway(), narrow, 'agent.delegate', {
          agent_version_id: randomUUID(),
          title: 'Child',
          tools: ['email.send'],
          max_cost_micros: 0,
        }),
      ).resolves.toMatchObject({ outcome: 'denied', decisionCode: 'DELEGATION_WIDENED' });
    });
  });
});
