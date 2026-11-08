// Owned by the tools slice (AGENT-03). The storage side of the tool gateway. See
// docs/06-delivery/m4-slices.md and ADR-028 FD-18. Only agent-worker uses this: it reads and writes
// `ai.step_payloads`, which no other role can reach.
//
// `@ensemus/agent-runtime` has no database import, by lint, so the gateway names what it needs in
// `ToolStepStore` below and `createToolStepStore` supplies it. Each write takes the caller's transaction,
// so everything one tool step decides commits together or not at all, and a retry finds it whole.
import { createHash, randomUUID } from 'node:crypto';
import {
  actorOf,
  agentRuns,
  agentVersions,
  appendAudit,
  approvals,
  artifactEvidence,
  artifacts,
  blobLifecycle,
  executionSteps,
  externalActions,
  memberships,
  modelProposalInputs,
  organizations,
  runControls,
  runInputCheckpoints,
  stepPayloads,
  toolProposals,
  usageLedger,
  withTenantTx,
  workArtifacts,
  workUnits,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import {
  strongestClassification,
  toolLedgerKey,
  type AgentRunStatus,
  type AiClassification,
  type StepLabelCode,
  type StepState,
  type ToolOutcome,
} from '@ensemus/domain/ai';
import { toolManifest } from '@ensemus/domain/ai-tools';
import { canChangeContent, type WorkState } from '@ensemus/domain/work-unit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type ObjectStore, objectKey } from '../artifacts';
import { AppError } from '../errors';
import { emit } from '../events';
import { canonicalId } from '../ids';
import { idFromRequest } from '../request-id';
import { closeOutdatedReviews, loadChangeable } from '../work';
import {
  createArtifactProvenance,
  recordFulfilledGeneratedPutFailure,
  type GeneratedArtifactWrite,
} from '../knowledge/artifact-provenance';
import {
  lockRunInputsForContent,
  assertRunInputsReadable,
  createRunInputInventory,
} from './input-ledger';
import { claimGeneratedPut, settleGeneratedPut } from '../knowledge/generated-writer';
import { bindModelResultWriteInTx } from './model-admission';

export type StoredProposal = {
  id: string;
  runId: string;
  stepId: string;
  toolId: string;
  toolVersion: string;
  payloadHash: string;
  idempotencyKey: string;
  status: string;
  decisionCode: string | null;
  approvalId: string | null;
  externalActionId: string | null;
  /**
   * From `ai.step_payloads`. This is why only the agent role can run this. Undefined when the payload is
   * gone or no longer matches `payloadHash`, which the gateway's parse then refuses.
   */
  args: unknown;
  /** Exact frozen original model attempt, absent for legacy/scripted proposals. */
  inputSnapshotId?: string | null;
};

/**
 * What `tool_id` holds for a name no manifest has. `ai.tool_proposals` is readable by the web tier, and a
 * tool name a model made up is the model's own words, so it never reaches that row. The name itself stays
 * in the agent-only payload, and the gateway refuses `unknown` like any other tool that does not exist.
 */
export const UNKNOWN_TOOL_ID = 'unknown';

/**
 * Far above what any tool's schema accepts, and below the 4 MiB the table's check allows. A model that
 * sends more gets a recorded refusal, rather than an Activity that keeps failing on a constraint.
 */
export const MAX_TOOL_ARGS_BYTES = 1_048_576;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The key a proposal is stored under, so asking again for this run and step finds the same one. */
export const proposalKey = (runId: string, stepNumber: number) =>
  `proposal:${canonicalId(runId)}:${stepNumber}`;

function serializeArgs(args: unknown): string | null {
  try {
    return JSON.stringify(args ?? null);
  } catch {
    return null;
  }
}

/** Pure, so what may and may not reach a web-readable row can be tested without a database. */
export function proposalRecordFor(input: {
  runId: string;
  stepNumber: number;
  toolId: string;
  args: unknown;
}) {
  const manifest = toolManifest(input.toolId);
  const serialized = serializeArgs(input.args);
  const refused = serialized === null || Buffer.byteLength(serialized) > MAX_TOOL_ARGS_BYTES;
  return {
    toolId: manifest?.id ?? UNKNOWN_TOOL_ID,
    toolVersion: manifest?.version ?? '0',
    idempotencyKey: proposalKey(input.runId, input.stepNumber),
    payloadHash: sha256(serialized ?? ''),
    content: refused ? null : serialized,
    status: refused ? ('denied' as const) : ('proposed' as const),
    decisionCode: refused ? ('TOOL_ARGS_INVALID' as const) : null,
  };
}

const labelFor = (toolId: string): StepLabelCode => {
  switch (toolId) {
    case 'work.read':
      return 'READING_WORK';
    case 'artifact.read_text':
      return 'READING_FILE';
    case 'artifact.draft.create':
      return 'DRAFTING';
    case 'email.send':
      return 'PROPOSING_EMAIL';
    case 'agent.delegate':
      return 'DELEGATING';
    default:
      return 'CHECKING_RESULT';
  }
};

const assertOwnRun = (context: AgentContext, runId: string) => {
  if (canonicalId(context.agentRunId) !== canonicalId(runId)) throw new AppError('FORBIDDEN');
};

/** The run's step row at this number, made if nobody has made it yet. */
async function ensureStep(
  tx: Tx,
  context: AgentContext,
  input: { runId: string; stepNumber: number; labelCode: StepLabelCode },
) {
  await tx
    .insert(executionSteps)
    .values({
      organizationId: context.organizationId,
      runId: input.runId,
      stepNumber: input.stepNumber,
      kind: 'tool_call',
      state: 'in_flight',
      labelCode: input.labelCode,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: executionSteps.id, kind: executionSteps.kind })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.runId, input.runId), eq(executionSteps.stepNumber, input.stepNumber)),
    );
  if (!row) throw new AppError('NOT_FOUND');
  return row;
}

/**
 * Written by the model turn that proposed it, with its arguments in `ai.step_payloads`. `stepNumber` is
 * the turn's own number, or the number of the tool step that follows it: `loadProposal` finds it from
 * either. The first one stored stands, so a retried turn cannot change what was proposed.
 */
export async function storeProposal(
  database: AppDatabase,
  context: AgentContext,
  input: {
    runId: string;
    stepNumber: number;
    toolId: string;
    args: unknown;
    originatingModel?: { stepId: string; attempt: number; inputSnapshotId?: string };
  },
): Promise<{ proposalId: string }> {
  assertOwnRun(context, input.runId);
  const record = proposalRecordFor(input);
  return withTenantTx(database, context, async (tx) => {
    const [run] = await tx
      .select({ classification: agentRuns.effectiveClassification })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId));
    if (!run) throw new AppError('NOT_FOUND');
    if (input.originatingModel)
      await bindModelResultWriteInTx(tx, context, {
        ...input.originatingModel,
        classification: run.classification as AiClassification,
        stepNumber: input.stepNumber,
      });
    const step = await ensureStep(tx, context, {
      runId: input.runId,
      stepNumber: input.stepNumber,
      labelCode: labelFor(record.toolId),
    });
    const id = randomUUID();
    const [inserted] = await tx
      .insert(toolProposals)
      .values({
        organizationId: context.organizationId,
        id,
        runId: input.runId,
        stepId: step.id,
        toolId: record.toolId,
        toolVersion: record.toolVersion,
        payloadHash: record.payloadHash,
        idempotencyKey: record.idempotencyKey,
        status: record.status,
        decisionCode: record.decisionCode,
      })
      .onConflictDoNothing()
      .returning({ id: toolProposals.id });
    if (!inserted) {
      const [existing] = await tx
        .select({ id: toolProposals.id })
        .from(toolProposals)
        .where(eq(toolProposals.stepId, step.id));
      if (!existing) throw new AppError('NOT_FOUND');
      return { proposalId: existing.id };
    }
    if (record.content === null) {
      await appendAudit(tx, {
        organizationId: context.organizationId,
        ...actorOf(context),
        action: 'ai.tool_denied',
        targetRef: `tool_proposal:${id}`,
        decision: 'deny',
        safeReason: 'TOOL_ARGS_INVALID',
      });
      return { proposalId: id };
    }
    if (input.originatingModel?.inputSnapshotId)
      await tx
        .insert(modelProposalInputs)
        .values({
          organizationId: context.organizationId,
          proposalId: id,
          snapshotId: input.originatingModel.inputSnapshotId,
        });
    await tx.insert(stepPayloads).values({
      organizationId: context.organizationId,
      stepId: step.id,
      kind: 'tool_args',
      classification: run.classification,
      content: record.content,
      contentSha256: record.payloadHash,
    });
    return { proposalId: id };
  });
}

/** Parsed only if it is exactly what was stored. Anything else is undefined, which the parse refuses. */
function argsFrom(payload: { content: string } | undefined, payloadHash: string): unknown {
  if (!payload || sha256(payload.content) !== payloadHash) return undefined;
  try {
    return JSON.parse(payload.content) as unknown;
  } catch {
    return undefined;
  }
}

async function loadProposalInTx(
  tx: Tx,
  input: { runId: string; stepNumber: number },
  includeArguments = true,
): Promise<StoredProposal | null> {
  const rows = await tx
    .select({
      proposal: toolProposals,
      stepNumber: executionSteps.stepNumber,
      kind: executionSteps.kind,
    })
    .from(toolProposals)
    .innerJoin(executionSteps, eq(executionSteps.id, toolProposals.stepId))
    .where(
      and(
        eq(toolProposals.runId, input.runId),
        inArray(executionSteps.stepNumber, [input.stepNumber, input.stepNumber - 1]),
      ),
    );
  // Its own step, or the model turn just before it. A tool step before this one is someone else's.
  const found =
    rows.find((row) => row.stepNumber === input.stepNumber) ??
    rows.find((row) => row.kind === 'model_turn');
  if (!found) return null;
  const { proposal } = found;
  const [origin] = await tx
    .select({ snapshotId: modelProposalInputs.snapshotId })
    .from(modelProposalInputs)
    .where(eq(modelProposalInputs.proposalId, proposal.id));
  const [payload] = includeArguments
    ? await tx
        .select({ content: stepPayloads.content })
        .from(stepPayloads)
        .where(and(eq(stepPayloads.stepId, proposal.stepId), eq(stepPayloads.kind, 'tool_args')))
    : [];
  return {
    id: proposal.id,
    runId: proposal.runId,
    stepId: proposal.stepId,
    toolId: proposal.toolId,
    toolVersion: proposal.toolVersion,
    payloadHash: proposal.payloadHash,
    idempotencyKey: proposal.idempotencyKey,
    status: proposal.status,
    decisionCode: proposal.decisionCode,
    approvalId: proposal.approvalId,
    externalActionId: proposal.externalActionId,
    args: argsFrom(payload, proposal.payloadHash),
    inputSnapshotId: origin?.snapshotId ?? null,
  };
}

export async function loadProposal(
  database: AppDatabase,
  context: AgentContext,
  input: { runId: string; stepNumber: number },
): Promise<StoredProposal | null> {
  assertOwnRun(context, input.runId);
  return withTenantTx(database, context, async (tx) => {
    await lockRunInputsForContent(tx, context);
    return loadProposalInTx(tx, input);
  });
}

export const PROPOSAL_STATUSES = [
  'proposed',
  'denied',
  'awaiting_approval',
  'approved',
  'running',
  'done',
  'failed',
  'unknown_external_state',
  'cancelled',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Nothing moves a proposal out of these. An unknown state is resolved through M3, never from here. */
const SETTLED_PROPOSALS: readonly string[] = [
  'denied',
  'done',
  'failed',
  'unknown_external_state',
  'cancelled',
];

async function moveProposal(
  tx: Tx,
  input: { proposalId: string; status: ProposalStatus; decisionCode: string | null },
) {
  const [row] = await tx
    .select({ status: toolProposals.status })
    .from(toolProposals)
    .where(eq(toolProposals.id, input.proposalId))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status === input.status) return;
  if (SETTLED_PROPOSALS.includes(row.status)) throw new AppError('INVALID_STATE');
  await tx
    .update(toolProposals)
    .set({ status: input.status, decisionCode: input.decisionCode, updatedAt: new Date() })
    .where(eq(toolProposals.id, input.proposalId));
}

export function setProposalStatus(
  database: AppDatabase,
  context: AgentContext,
  input: { proposalId: string; status: string; decisionCode: string | null },
): Promise<void> {
  const status = z.enum(PROPOSAL_STATUSES).safeParse(input.status);
  if (!status.success) return Promise.reject(new AppError('INVALID_INPUT'));
  return withTenantTx(database, context, (tx) =>
    moveProposal(tx, {
      proposalId: input.proposalId,
      status: status.data,
      decisionCode: input.decisionCode,
    }),
  );
}

export type ToolWait =
  'waiting' | 'done' | 'denied' | 'expired' | 'failed' | 'unknown_external_state';

/** Pure. `unknown`, and anything not on this list, says unknown: never that it failed or was sent. */
export function toolWaitFor(actionStatus: string, approvalStatus: string | null): ToolWait {
  switch (actionStatus) {
    case 'awaiting_approval':
    case 'ready':
    case 'sending':
    case 'reconciling':
      return 'waiting';
    case 'sent':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return approvalStatus === 'expired' ? 'expired' : 'denied';
    default:
      return 'unknown_external_state';
  }
}

/**
 * Where a waiting tool step has got to, for `readToolWait`. It reads PostgreSQL and changes nothing, so it
 * is safe to poll. When it stops saying `waiting`, the workflow calls `ToolGateway.handle` for the same
 * step, which records the receipt and the output the next turn needs.
 */
export async function readToolWaitState(
  database: AppDatabase,
  context: AgentContext,
  input: { runId: string; stepNumber: number },
): Promise<ToolWait> {
  assertOwnRun(context, input.runId);
  return withTenantTx(database, context, async (tx) => {
    const proposal = await loadProposalInTx(tx, input);
    if (!proposal?.externalActionId) return 'unknown_external_state';
    const [row] = await tx
      .select({ status: externalActions.status, approval: approvals.status })
      .from(externalActions)
      .leftJoin(approvals, eq(approvals.id, externalActions.approvalId))
      .where(eq(externalActions.id, proposal.externalActionId));
    return row ? toolWaitFor(row.status, row.approval) : 'unknown_external_state';
  });
}

// --- What the gateway needs. It holds no database, so this is its whole view of storage.

/** Everything the pipeline checks about a run. Null lists mean the row could not be read as a policy. */
export type ToolRunFacts = {
  status: AgentRunStatus;
  workUnitId: string;
  agentVersionId: string;
  initiatorMembershipId: string;
  /** The membership as it stands now: null when it is missing or not active. */
  initiatorRole: string | null;
  stopRequested: boolean;
  workStopped: boolean;
  /** Metadata-only admission and fresh all-input access. False never permits loading arguments. */
  inputsOpen: boolean;
  classification: AiClassification;
  maxDelegationDepth: number;
  allow: readonly string[] | null;
  deny: readonly string[] | null;
  delegated: readonly string[] | null;
};

export type DraftEvidence = {
  sourceType: 'work_unit' | 'artifact';
  sourceId: string;
  sourceSha256: string | null;
};

export type ToolAudit = {
  action: 'ai.tool_done' | 'ai.tool_denied' | 'ai.tool_proposed' | 'ai.tool_stopped';
  targetRef: string;
  decision: 'allow' | 'deny';
  safeReason?: string;
};

export interface ToolStepStore {
  /** One short transaction under the agent's tenant. Never held across a network call. */
  withTx<T>(context: AgentContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** `lock` holds the run row, so nothing can end it between this check and the effect committing. */
  readRun(
    tx: Tx,
    context: AgentContext,
    runId: string,
    options: { lock: boolean },
  ): Promise<ToolRunFacts | null>;
  loadProposal(
    context: AgentContext,
    input: { runId: string; stepNumber: number },
  ): Promise<StoredProposal | null>;
  /** IDs/status only for closed-run reconciliation. Must never SELECT private argument payloads. */
  loadProposalMetadata(
    context: AgentContext,
    input: { runId: string; stepNumber: number },
  ): Promise<Omit<StoredProposal, 'args'> | null>;
  /** The tool step's row, made if needed. Null when this number belongs to some other kind of step. */
  openStep(
    tx: Tx,
    context: AgentContext,
    input: { runId: string; stepNumber: number; toolId: string },
  ): Promise<{ stepId: string } | null>;
  /** Locks the proposal, so two workers on one step run the effect once. */
  lockProposal(
    tx: Tx,
    proposalId: string,
  ): Promise<{ status: string; decisionCode: string | null } | null>;
  moveProposal(
    tx: Tx,
    input: { proposalId: string; status: ProposalStatus; decisionCode: string | null },
  ): Promise<void>;
  /** In the same transaction as M3's intent, so a retry either finds both or proposes from nothing. */
  attachExternalAction(
    tx: Tx,
    input: { proposalId: string; approvalId: string; externalActionId: string },
  ): Promise<void>;
  updateStep(
    tx: Tx,
    input: {
      stepId: string;
      state: StepState;
      outcome: ToolOutcome | null;
      decisionCode: string | null;
      labelCode?: StepLabelCode;
    },
  ): Promise<void>;
  writeOutput(
    tx: Tx,
    context: AgentContext,
    input: { stepId: string; classification: AiClassification; content: string },
  ): Promise<void>;
  /** Strongest of what the run has and `atLeast`. Answers the class it now holds. */
  raiseRunClass(
    tx: Tx,
    input: { runId: string; atLeast: AiClassification },
  ): Promise<AiClassification>;
  /** Same run and step twice is one row. Nothing is charged: a price for a tool call is not ours to set. */
  recordToolCall(
    tx: Tx,
    context: AgentContext,
    input: { runId: string; stepNumber: number; stepId: string; workUnitId: string },
  ): Promise<void>;
  audit(tx: Tx, context: AgentContext, entry: ToolAudit): Promise<void>;
  /** From the run and the step, so a retry writes the same object and the same row. */
  draftIdFor(context: AgentContext, input: { runId: string; stepNumber: number }): string;
  /** Checks the initiator may add to this work now, and notes the bytes that are about to exist. */
  noteDraftUpload(
    tx: Tx,
    context: AgentContext,
    input: { draftId: string; workUnitId: string; runId: string; text: string },
  ): Promise<GeneratedArtifactWrite>;
  /** Outside any transaction: this is a network call. */
  putDraft(
    context: AgentContext,
    input: { draftId: string; text: string; write: GeneratedArtifactWrite },
  ): Promise<void>;
  /** Only after fulfilled put and failed publication; unknown puts never settle through this path. */
  abandonDraftUpload(context: AgentContext, write: GeneratedArtifactWrite): Promise<void>;
  /** Answers the class written, which is never below `classification` or the work's own. */
  insertDraft(
    tx: Tx,
    context: AgentContext,
    input: {
      draftId: string;
      runId: string;
      stepId: string;
      workUnitId: string;
      name: string;
      text: string;
      classification: AiClassification;
      evidence: readonly DraftEvidence[];
      write: GeneratedArtifactWrite;
    },
  ): Promise<{ classification: AiClassification }>;
}

const specTools = z.object({
  tools: z.object({ allow: z.array(z.string()), deny: z.array(z.string()).optional() }),
});
const scopeTools = z.object({ tools: z.array(z.string()) });

const DRAFT_MIME_TYPE = 'text/plain';
/** The same grace as a person's upload: the sweep removes bytes whose row never arrived. */
const DRAFT_UPLOAD_GRACE_MS = 60 * 60 * 1000;

const STOPPED_WORK: readonly string[] = ['completed', 'failed', 'cancelled'];

export function createToolStepStore(deps: {
  database: AppDatabase;
  objects: Pick<ObjectStore, 'put'>;
}): ToolStepStore {
  const { database, objects } = deps;
  const provenance = createArtifactProvenance({ inventory: createRunInputInventory() });
  return {
    withTx: (context, fn) => withTenantTx(database, context, fn),

    async readRun(tx, context, runId, options) {
      assertOwnRun(context, runId);
      const query = tx.select().from(agentRuns).where(eq(agentRuns.id, runId));
      const [run] = await (options.lock ? query.for('update') : query);
      if (!run) return null;
      if (options.lock)
        await tx
          .select({ id: runInputCheckpoints.runId })
          .from(runInputCheckpoints)
          .where(eq(runInputCheckpoints.runId, runId))
          .for('share');
      const [version] = await tx
        .select({ spec: agentVersions.spec })
        .from(agentVersions)
        .where(eq(agentVersions.id, run.agentVersionId));
      const [initiator] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.id, run.initiatorMembershipId), eq(memberships.status, 'active')),
        );
      const [work] = await tx
        .select({ status: workUnits.status })
        .from(workUnits)
        .where(eq(workUnits.id, run.workUnitId));
      const [stop] = await tx
        .select({ id: runControls.id })
        .from(runControls)
        .where(and(eq(runControls.runId, runId), eq(runControls.kind, 'stop')))
        .limit(1);
      const spec = specTools.safeParse(version?.spec);
      const scopes = scopeTools.safeParse(run.delegatedScopes);
      const inputState = await tx.execute<{ allowed: boolean }>(
        sql`select ai.run_input_admitted(${runId}::uuid)
          and ai.run_inputs_readable(${runId}::uuid,${context.membershipId}::uuid) as allowed`,
      );
      return {
        status: run.status as AgentRunStatus,
        workUnitId: run.workUnitId,
        agentVersionId: run.agentVersionId,
        initiatorMembershipId: run.initiatorMembershipId,
        initiatorRole: initiator?.role ?? null,
        stopRequested: Boolean(stop),
        workStopped: !work || STOPPED_WORK.includes(work.status),
        inputsOpen: inputState.rows[0]?.allowed === true,
        classification: run.effectiveClassification as AiClassification,
        maxDelegationDepth: run.maxDelegationDepth,
        allow: spec.success ? spec.data.tools.allow : null,
        deny: spec.success ? (spec.data.tools.deny ?? []) : null,
        delegated: scopes.success ? scopes.data.tools : null,
      };
    },

    loadProposal: (context, input) => loadProposal(database, context, input),

    loadProposalMetadata(context, input) {
      assertOwnRun(context, input.runId);
      return withTenantTx(database, context, async (tx) => {
        const [run] = await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, input.runId),
              eq(agentRuns.initiatorMembershipId, context.membershipId),
            ),
          );
        if (!run) return null;
        const proposal = await loadProposalInTx(tx, input, false);
        if (!proposal) return null;
        const { args: _omitted, ...metadata } = proposal;
        return metadata;
      });
    },

    async openStep(tx, context, input) {
      const step = await ensureStep(tx, context, {
        runId: input.runId,
        stepNumber: input.stepNumber,
        labelCode: labelFor(input.toolId),
      });
      return step.kind === 'tool_call' ? { stepId: step.id } : null;
    },

    async lockProposal(tx, proposalId) {
      const [row] = await tx
        .select({ status: toolProposals.status, decisionCode: toolProposals.decisionCode })
        .from(toolProposals)
        .where(eq(toolProposals.id, proposalId))
        .for('update');
      return row ?? null;
    },

    moveProposal,

    async attachExternalAction(tx, input) {
      await tx
        .update(toolProposals)
        .set({
          approvalId: input.approvalId,
          externalActionId: input.externalActionId,
          status: 'awaiting_approval',
          decisionCode: 'APPROVAL_REQUIRED',
          updatedAt: new Date(),
        })
        .where(eq(toolProposals.id, input.proposalId));
    },

    async updateStep(tx, input) {
      const settled = input.state !== 'in_flight';
      await tx
        .update(executionSteps)
        .set({
          state: input.state,
          outcome: input.outcome,
          decisionCode: input.decisionCode,
          ...(input.labelCode ? { labelCode: input.labelCode } : {}),
          ...(settled ? { endedAt: new Date() } : {}),
        })
        .where(eq(executionSteps.id, input.stepId));
    },

    async writeOutput(tx, context, input) {
      await tx.insert(stepPayloads).values({
        organizationId: context.organizationId,
        stepId: input.stepId,
        kind: 'tool_output',
        classification: input.classification,
        content: input.content,
        contentSha256: sha256(input.content),
      });
    },

    async raiseRunClass(tx, input) {
      const [run] = await tx
        .select({ classification: agentRuns.effectiveClassification })
        .from(agentRuns)
        .where(eq(agentRuns.id, input.runId))
        .for('update');
      if (!run) throw new AppError('NOT_FOUND');
      const current = run.classification as AiClassification;
      const next = strongestClassification(current, input.atLeast);
      if (next !== current) {
        await tx
          .update(agentRuns)
          .set({ effectiveClassification: next })
          .where(eq(agentRuns.id, input.runId));
      }
      return next;
    },

    async recordToolCall(tx, context, input) {
      const [organization] = await tx
        .select({ commercialMode: organizations.commercialMode })
        .from(organizations)
        .where(eq(organizations.id, context.organizationId));
      if (!organization) throw new AppError('NOT_FOUND');
      await tx
        .insert(usageLedger)
        .values({
          organizationId: context.organizationId,
          idempotencyKey: toolLedgerKey(input.runId, input.stepNumber),
          meter: 'tool_call',
          quantity: 1,
          unit: 'call',
          costMicros: 0,
          billingPeriod: new Date().toISOString().slice(0, 7),
          commercialMode: organization.commercialMode,
          workUnitId: input.workUnitId,
          runId: input.runId,
          stepId: input.stepId,
          status: 'final',
          billable: false,
        })
        .onConflictDoNothing();
    },

    async audit(tx, context, entry) {
      await appendAudit(tx, {
        organizationId: context.organizationId,
        ...actorOf(context),
        action: entry.action,
        targetRef: entry.targetRef,
        decision: entry.decision,
        ...(entry.safeReason ? { safeReason: entry.safeReason } : {}),
      });
    },

    draftIdFor: (context, input) =>
      idFromRequest('agent_draft', context.membershipId, input.runId, [input.stepNumber]),

    async noteDraftUpload(tx, context, input) {
      assertOwnRun(context, input.runId);
      const body = Buffer.from(input.text, 'utf8');
      const started = await provenance.beginInTx(tx, context, {
        execution: { kind: 'agent_run', id: input.runId },
        artifactId: input.draftId,
        workUnitId: input.workUnitId,
        artifactSha256: sha256(input.text),
        sizeBytes: body.length,
      });
      if (started.alreadyPublished) throw new AppError('INVALID_STATE');
      const work = await loadChangeable(tx, context, input.workUnitId);
      if (!canChangeContent(work.status as WorkState)) throw new AppError('INVALID_STATE');
      await tx
        .insert(blobLifecycle)
        .values({
          organizationId: context.organizationId,
          artifactId: input.draftId,
          objectKey: objectKey(context.organizationId, input.draftId),
          state: 'uploading',
          purgeAfter: new Date(Date.now() + DRAFT_UPLOAD_GRACE_MS),
        })
        .onConflictDoNothing();
      return started.write;
    },

    async putDraft(context, input) {
      if (
        input.write.artifactId !== input.draftId ||
        input.write.artifactSha256 !== sha256(input.text)
      )
        throw new AppError('INVALID_STATE');
      await withTenantTx(database, context, (tx) => assertRunInputsReadable(tx, context));
      await claimGeneratedPut(database, context, input.write);
      await objects.put(
        objectKey(context.organizationId, input.draftId),
        Buffer.from(input.text, 'utf8'),
        DRAFT_MIME_TYPE,
      );
      await settleGeneratedPut(database, context, input.write);
    },

    abandonDraftUpload: (context, write) =>
      recordFulfilledGeneratedPutFailure(database, context, write),

    async insertDraft(tx, context, input) {
      assertOwnRun(context, input.runId);
      if (
        input.write.artifactId !== input.draftId ||
        input.write.artifactSha256 !== sha256(input.text)
      )
        throw new AppError('INVALID_STATE');
      await provenance.publishInTx(tx, context, input.write);
      const work = await loadChangeable(tx, context, input.workUnitId);
      if (!canChangeContent(work.status as WorkState)) throw new AppError('INVALID_STATE');
      const classification = input.write.classification;
      const body = Buffer.from(input.text, 'utf8');
      await tx.insert(artifacts).values({
        organizationId: context.organizationId,
        id: input.draftId,
        name: input.name,
        objectKey: objectKey(context.organizationId, input.draftId),
        sha256: createHash('sha256').update(body).digest('hex'),
        mimeType: DRAFT_MIME_TYPE,
        sizeBytes: body.length,
        classification,
        // Nobody added this. `evidenceFor` counts only files a person added, so a draft proves nothing.
        createdByMembershipId: null,
        provenanceState: 'bound',
      });
      await tx.insert(workArtifacts).values({
        organizationId: context.organizationId,
        workUnitId: input.workUnitId,
        artifactId: input.draftId,
      });
      await tx.delete(blobLifecycle).where(eq(blobLifecycle.artifactId, input.draftId));
      if (input.evidence.length > 0) {
        await tx.insert(artifactEvidence).values(
          input.evidence.map((source) => ({
            organizationId: context.organizationId,
            artifactId: input.draftId,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            sourceSha256: source.sourceSha256,
            runId: input.runId,
            stepId: input.stepId,
          })),
        );
      }
      await emit(tx, context, {
        eventType: 'work.artifact_added',
        aggregateType: 'work_unit',
        aggregateId: input.workUnitId,
        aggregateVersion: work.version,
        classification,
        payload: { work_unit_id: input.workUnitId, artifact_id: input.draftId },
      });
      await closeOutdatedReviews(tx, context, work);
      return { classification };
    },
  };
}
