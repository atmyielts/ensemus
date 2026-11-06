// Owned by the tools slice (AGENT-03). See docs/06-delivery/m4-slices.md and ADR-028 FD-18. The model is
// untrusted, and this is what makes that safe: allowlist, parse, principal and resource ACL, class,
// approval policy, halt check, idempotent effect, receipt, audit, in that order. Nothing here asks a model
// anything or believes what one said: a proposal is only a request, and every check reads PostgreSQL.
//
// Only codes leave this file. A tool's output goes to `ai.step_payloads` and the result carries an outcome
// and a reason code, so nothing a document or a model said can reach Temporal, a row a page reads, or a log.
import type {
  AgentContext,
  ApprovalBinder,
  ExternalActionPort,
  HaltCheck,
  Tx,
} from '@ensemus/application/ai-ports';
import type { ContextSource, LoadedWork } from '@ensemus/application/ai-context-source';
import type {
  DraftEvidence,
  ProposalStatus,
  StoredProposal,
  ToolRunFacts,
  ToolStepStore,
} from '@ensemus/application/ai-tool-steps';
import {
  TOOL_ARGS_SCHEMAS,
  type agentDelegateArgsSchema,
  type artifactDraftCreateArgsSchema,
  type artifactReadTextArgsSchema,
  type emailSendArgsSchema,
  type workReadArgsSchema,
} from '@ensemus/contracts/ai-tools';
import type { AiClassification, AiReasonCode, ToolOutcome } from '@ensemus/domain/ai';
import { toolManifest, type ToolManifest } from '@ensemus/domain/ai-tools';
import { decideAction, strongest } from '@ensemus/policy';
import type { z } from 'zod';

export type ToolStepRef = {
  runId: string;
  stepNumber: number;
  workUnitId: string;
  agentVersionId: string;
};

/** In memory only. The tool's output goes to `ai.step_payloads`, and never crosses Temporal. */
export type ToolHandleResult = {
  outcome: ToolOutcome;
  decisionCode: AiReasonCode | null;
  /** Set for `agent.delegate` when the workflow should start a child. */
  delegationRequested: boolean;
};

export interface ToolGateway {
  handle(context: AgentContext, step: ToolStepRef): Promise<ToolHandleResult>;
}

/** The most one tool's output may put in front of the next turn. Larger is refused, never cut short. */
export const MAX_TOOL_OUTPUT_BYTES = 1_048_576;

const result = (
  outcome: ToolOutcome,
  decisionCode: AiReasonCode | null = null,
  delegationRequested = false,
): ToolHandleResult => ({ outcome, decisionCode, delegationRequested });

/** A check said no. Thrown so the transaction it was in rolls back, and recorded in a fresh one. */
class Refusal extends Error {
  constructor(
    readonly code: AiReasonCode,
    /** Says more than the reason code can, for the audit row only. */
    readonly auditAs?: string,
  ) {
    super(code);
  }
}

/** The run must not go on. No effect happens, and the workflow ends it. */
class Stop extends Error {
  constructor(readonly code: AiReasonCode | null) {
    super(code ?? 'STOPPED');
  }
}

/** Another attempt at this step got there first, so its answer is the answer. */
class AlreadyHandled extends Error {}

/** What an application error means here. Anything not listed is not a decision, so it is thrown on. */
const APP_ERROR_REASONS: Partial<Record<string, AiReasonCode>> = {
  NOT_FOUND: 'RESOURCE_NOT_PERMITTED',
  FORBIDDEN: 'RESOURCE_NOT_PERMITTED',
  INVALID_STATE: 'RESOURCE_NOT_PERMITTED',
  CONNECTION_NOT_ACTIVE: 'RESOURCE_NOT_PERMITTED',
  CONNECTOR_NOT_AVAILABLE: 'RESOURCE_NOT_PERMITTED',
  TOOL_DENIED: 'RESOURCE_NOT_PERMITTED',
  POLICY_DENIED: 'RESOURCE_NOT_PERMITTED',
  DELEGATION_DENIED: 'DELEGATION_WIDENED',
  INVALID_INPUT: 'TOOL_ARGS_INVALID',
  RESTRICTED_NOT_ALLOWED: 'CLASS_DENIED',
  NO_ELIGIBLE_APPROVER: 'APPROVAL_REQUIRED',
  REVIEW_ALREADY_OPEN: 'APPROVAL_REQUIRED',
  APPROVAL_SELF_APPROVAL: 'APPROVAL_REQUIRED',
  APPROVAL_WRONG_APPROVER: 'APPROVAL_REQUIRED',
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : '');
const appErrorCode = (error: unknown) =>
  errorName(error) === 'AppError' ? (error as { code?: unknown }).code : undefined;

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const classOfWork = (work: LoadedWork): AiClassification =>
  work.clientClassification
    ? strongest(work.classification, work.clientClassification)
    : work.classification;

/** A future tool might carry these. None does in M4, and a tool that does is denied by default. */
const isDestructive = (manifest: ToolManifest | undefined) => {
  const flags = manifest as { destructive?: unknown; financial?: unknown } | undefined;
  return flags?.destructive === true || flags?.financial === true;
};

type Deps = {
  source: ContextSource;
  externalActions: ExternalActionPort;
  approvals: ApprovalBinder;
  halt: HaltCheck;
  /** The gateway has no database, by lint. `createToolStepStore` in @ensemus/application/ai-tool-steps. */
  store: ToolStepStore;
};

/** One tool step, as it stands once the proposal and its row have been found. */
type Turn = {
  deps: Deps;
  context: AgentContext;
  step: ToolStepRef;
  proposal: StoredProposal;
  stepId: string;
};

/**
 * Whether this context still speaks for this run. The membership is read again here, and a role that moved
 * since the context was made counts: everything the ACL decides rests on that role, so a stale one must not
 * decide anything. A new context comes with the next Activity, for a run someone starts again.
 */
function principalStop(facts: ToolRunFacts, context: AgentContext): Stop | null {
  if (facts.initiatorRole === null || facts.initiatorRole !== context.role) {
    return new Stop('INITIATOR_INACTIVE');
  }
  if (facts.status !== 'running' || facts.stopRequested || facts.workStopped) return new Stop(null);
  return null;
}

/**
 * The recheck immediately before an effect (ADR-024 D3), in the transaction that commits it. A signal is
 * only a wake-up: a stop committed with its signal lost is found here, and so is a run that ended or a
 * switch engaged while a slow read was going on. The run row stays locked until the effect commits.
 */
async function gate(turn: Turn, tx: Tx): Promise<ToolRunFacts> {
  const { deps, context, step, proposal } = turn;
  try {
    await deps.halt.assertRunning(tx, context, { agentVersionId: step.agentVersionId });
  } catch {
    // FD-15: state that cannot be read counts as halted, so every failure here does.
    throw new Stop('HALTED');
  }
  const locked = await deps.store.lockProposal(tx, proposal.id);
  if (locked?.status !== 'proposed') throw new AlreadyHandled();
  const facts = await deps.store.readRun(tx, context, step.runId, { lock: true });
  if (!facts) throw new Refusal('POLICY_UNREADABLE');
  const stop = principalStop(facts, context);
  if (stop) throw stop;
  return facts;
}

const inGate = <T>(turn: Turn, body: (tx: Tx, facts: ToolRunFacts) => Promise<T>): Promise<T> =>
  turn.deps.store.withTx(turn.context, async (tx) => body(tx, await gate(turn, tx)));

const proposalRef = (proposal: StoredProposal) => `tool_proposal:${proposal.id}`;

/** Output, receipt, ledger and audit, in the effect's own transaction. They exist together or not at all. */
async function finishDone(
  turn: Turn,
  tx: Tx,
  input: { classification: AiClassification; content: string },
) {
  const { deps, context, step, proposal, stepId } = turn;
  await deps.store.writeOutput(tx, context, {
    stepId,
    classification: input.classification,
    content: input.content,
  });
  await deps.store.moveProposal(tx, {
    proposalId: proposal.id,
    status: 'done',
    decisionCode: null,
  });
  await deps.store.updateStep(tx, {
    stepId,
    state: 'completed',
    outcome: 'done',
    decisionCode: null,
  });
  await deps.store.recordToolCall(tx, context, {
    runId: step.runId,
    stepNumber: step.stepNumber,
    stepId,
    workUnitId: step.workUnitId,
  });
  await deps.store.audit(tx, context, {
    action: 'ai.tool_done',
    targetRef: proposalRef(proposal),
    decision: 'allow',
  });
}

/** Raises the run's class in the same commit as the output, so no later turn can see one without the other. */
function commitOutput(turn: Turn, classification: AiClassification, content: string) {
  if (Buffer.byteLength(content, 'utf8') > MAX_TOOL_OUTPUT_BYTES) {
    throw new Refusal('RESOURCE_NOT_PERMITTED', 'TOOL_OUTPUT_TOO_LARGE');
  }
  return inGate(turn, async (tx) => {
    const raised = await turn.deps.store.raiseRunClass(tx, {
      runId: turn.step.runId,
      atLeast: classification,
    });
    await finishDone(turn, tx, { classification: raised, content });
    return result('done');
  });
}

// --- The tools. Each does its own resource ACL and class, then its effect through the gate.

async function workRead(turn: Turn, args: z.infer<typeof workReadArgsSchema>) {
  const work = await turn.deps.source.loadWork(turn.context, args.work_unit_id.toLowerCase());
  const classification = classOfWork(work);
  return commitOutput(
    turn,
    classification,
    JSON.stringify({
      id: work.id,
      title: work.title,
      objective: work.objective,
      classification,
      artifact_ids: work.artifactIds,
    }),
  );
}

async function loadReadableText(turn: Turn, artifactId: string) {
  const loaded = await turn.deps.source.loadArtifactText(turn.context, {
    workUnitId: turn.step.workUnitId,
    artifactId: artifactId.toLowerCase(),
    maxBytes: MAX_TOOL_OUTPUT_BYTES,
  });
  if ('refused' in loaded) {
    throw new Refusal(
      'RESOURCE_NOT_PERMITTED',
      loaded.refused === 'TOO_LARGE' ? 'TOOL_OUTPUT_TOO_LARGE' : `ARTIFACT_${loaded.refused}`,
    );
  }
  return loaded;
}

async function artifactReadText(turn: Turn, args: z.infer<typeof artifactReadTextArgsSchema>) {
  const artifact = await loadReadableText(turn, args.artifact_id);
  return commitOutput(
    turn,
    artifact.classification,
    JSON.stringify({
      id: artifact.id,
      sha256: artifact.sha256,
      classification: artifact.classification,
      text: artifact.text,
    }),
  );
}

/** Every source must be one this initiator can read now: a citation of anything else is refused. */
async function checkedEvidence(
  turn: Turn,
  evidence: z.infer<typeof artifactDraftCreateArgsSchema>['evidence'],
) {
  const sources = new Map<string, DraftEvidence & { classification: AiClassification }>();
  for (const source of evidence) {
    const sourceId = source.source_id.toLowerCase();
    const key = `${source.source_type}:${sourceId}`;
    if (sources.has(key)) continue;
    if (source.source_type === 'work_unit') {
      const work = await turn.deps.source.loadWork(turn.context, sourceId);
      sources.set(key, {
        sourceType: 'work_unit',
        sourceId,
        sourceSha256: null,
        classification: classOfWork(work),
      });
    } else {
      const artifact = await loadReadableText(turn, sourceId);
      sources.set(key, {
        sourceType: 'artifact',
        sourceId,
        sourceSha256: artifact.sha256,
        classification: artifact.classification,
      });
    }
  }
  return [...sources.values()];
}

/**
 * A draft is at least the run's class, its work's class and every source's class. The arguments have no
 * class field, so a model has nothing to lower it with. Bytes go up outside any transaction, under an ID
 * from the run and the step, so a retry overwrites its own object, and the sweep removes them if the row
 * never arrives. Nothing here sends a draft anywhere, and `createdByMembershipId` stays null.
 */
async function artifactDraftCreate(
  turn: Turn,
  args: z.infer<typeof artifactDraftCreateArgsSchema>,
) {
  const { deps, context, step } = turn;
  const work = await deps.source.loadWork(context, step.workUnitId);
  const evidence = await checkedEvidence(turn, args.evidence);
  const classification = evidence.reduce<AiClassification>(
    (strongestSoFar, source) => strongest(strongestSoFar, source.classification),
    classOfWork(work),
  );
  const draftId = deps.store.draftIdFor(context, {
    runId: step.runId,
    stepNumber: step.stepNumber,
  });
  const write = await inGate(turn, (tx) =>
    deps.store.noteDraftUpload(tx, context, {
      draftId,
      workUnitId: step.workUnitId,
      runId: step.runId,
      text: args.text,
    }),
  );
  await deps.store.putDraft(context, { draftId, text: args.text, write });
  try {
    return await inGate(turn, async (tx, facts) => {
      const written = await deps.store.insertDraft(tx, context, {
        draftId,
        runId: step.runId,
        stepId: turn.stepId,
        workUnitId: step.workUnitId,
        name: args.name,
        text: args.text,
        classification: strongest(facts.classification, classification),
        evidence: evidence.map(({ sourceType, sourceId, sourceSha256 }) => ({
          sourceType,
          sourceId,
          sourceSha256,
        })),
        write,
      });
      const raised = await deps.store.raiseRunClass(tx, {
        runId: step.runId,
        atLeast: written.classification,
      });
      await finishDone(turn, tx, {
        classification: raised,
        content: JSON.stringify({
          status: 'draft_created',
          artifact_id: draftId,
          classification: written.classification,
        }),
      });
      return result('done');
    });
  } catch (error) {
    // This invocation's put fulfilled. Publication might have committed with its acknowledgement lost;
    // the exact-token helper preserves bound files and otherwise records a settled blocked writer.
    await deps.store.abandonDraftUpload(context, write).catch(() => undefined);
    throw error;
  }
}

/**
 * Proposes only. M3's own workflow sends it, once a person approved these exact bytes (ADR-027 D1). The
 * intent, its approval and this proposal's link to them commit together, so a retry either finds all of it
 * and never proposes again, or finds nothing and proposes for the first time.
 */
async function emailSend(
  turn: Turn,
  manifest: ToolManifest,
  args: z.infer<typeof emailSendArgsSchema>,
) {
  const { deps, context, step, proposal, stepId } = turn;
  const work = await deps.source.loadWork(context, step.workUnitId);
  return inGate(turn, async (tx, facts) => {
    if (strongest(facts.classification, classOfWork(work)) === 'restricted') {
      throw new Refusal('CLASS_DENIED');
    }
    const ref = await deps.approvals.request(tx, context, {
      proposalId: proposal.id,
      runId: step.runId,
      workUnitId: step.workUnitId,
      connectionId: args.connection_id.toLowerCase(),
      toolId: manifest.id,
      toolVersion: manifest.version,
      payload: args.email,
    });
    await deps.store.attachExternalAction(tx, {
      proposalId: proposal.id,
      approvalId: ref.approvalId,
      externalActionId: ref.externalActionId,
    });
    await deps.store.updateStep(tx, {
      stepId,
      state: 'in_flight',
      outcome: null,
      decisionCode: 'APPROVAL_REQUIRED',
      labelCode: 'WAITING_FOR_APPROVAL',
    });
    await deps.store.recordToolCall(tx, context, {
      runId: step.runId,
      stepNumber: step.stepNumber,
      stepId,
      workUnitId: step.workUnitId,
    });
    await deps.store.audit(tx, context, {
      action: 'ai.tool_proposed',
      targetRef: proposalRef(proposal),
      decision: 'allow',
      safeReason: 'APPROVAL_REQUIRED',
    });
    return result('needs_approval', 'APPROVAL_REQUIRED');
  });
}

/** Creates nothing. The workflow starts the child, and `createChildRun` makes the stored checks again. */
async function agentDelegate(
  turn: Turn,
  facts: ToolRunFacts,
  args: z.infer<typeof agentDelegateArgsSchema>,
) {
  await turn.deps.source.loadWork(turn.context, turn.step.workUnitId);
  if (facts.maxDelegationDepth < 1) throw new Refusal('DELEGATION_DEPTH');
  const held = facts.delegated ?? [];
  if (!args.tools.every((tool) => held.includes(tool))) throw new Refusal('DELEGATION_WIDENED');
  return inGate(turn, async (tx, current) => {
    await finishDone(turn, tx, {
      classification: current.classification,
      content: JSON.stringify({ status: 'delegation_requested' }),
    });
    return result('done', null, true);
  });
}

// --- The pipeline.

async function runPipeline(turn: Turn, facts: ToolRunFacts): Promise<ToolHandleResult> {
  const { proposal } = turn;

  // Allowlist. A name in no manifest does not exist, whatever the spec says about it.
  if (facts.allow === null || facts.deny === null || facts.delegated === null) {
    throw new Refusal('POLICY_UNREADABLE');
  }
  const manifest = toolManifest(proposal.toolId);
  const action = decideAction({
    toolId: proposal.toolId,
    toolClass: manifest?.class ?? null,
    allow: facts.allow,
    deny: facts.deny,
    delegated: facts.delegated,
    dataClass: facts.classification,
    destructive: isDestructive(manifest),
    requiresApproval: manifest?.requiresApproval ?? true,
  });
  if (action.decision === 'deny') throw new Refusal(action.reasonCode);
  if (!manifest) throw new Refusal('TOOL_UNKNOWN');
  if (manifest.version !== proposal.toolVersion) throw new Refusal('POLICY_UNREADABLE');

  // Parse, strictly: an extra argument is a refusal, not something ignored.
  const schema: z.ZodType | undefined =
    TOOL_ARGS_SCHEMAS[manifest.id as keyof typeof TOOL_ARGS_SCHEMAS];
  if (!schema) throw new Refusal('TOOL_UNKNOWN');
  const parsed = schema.safeParse(proposal.args);
  if (!parsed.success) throw new Refusal('TOOL_ARGS_INVALID');

  // Principal.
  const stop = principalStop(facts, turn.context);
  if (stop) throw stop;

  // Approval policy. `email.send` is the only path to a person, and it always takes it, even if a decision
  // said `allow`: that tool can do nothing else. Anything else that has to ask has no way to, so it stops.
  const mustAsk = manifest.requiresApproval || action.decision === 'require_approval';
  if (mustAsk && manifest.id !== 'email.send') throw new Refusal('APPROVAL_REQUIRED');

  // Resource ACL, class, then the gated effect, tool by tool.
  switch (manifest.id) {
    case 'work.read':
      return workRead(turn, parsed.data as z.infer<typeof workReadArgsSchema>);
    case 'artifact.read_text':
      return artifactReadText(turn, parsed.data as z.infer<typeof artifactReadTextArgsSchema>);
    case 'artifact.draft.create':
      return artifactDraftCreate(
        turn,
        parsed.data as z.infer<typeof artifactDraftCreateArgsSchema>,
      );
    case 'email.send':
      return emailSend(turn, manifest, parsed.data as z.infer<typeof emailSendArgsSchema>);
    case 'agent.delegate':
      return agentDelegate(turn, facts, parsed.data as z.infer<typeof agentDelegateArgsSchema>);
    default:
      throw new Refusal('TOOL_UNKNOWN');
  }
}

/** What a finished proposal said. Undefined when it has not finished. Nothing runs twice. */
function storedResult(proposal: { toolId: string; status: string; decisionCode: string | null }) {
  const code = proposal.decisionCode as AiReasonCode | null;
  switch (proposal.status) {
    case 'done':
      return result('done', null, proposal.toolId === 'agent.delegate');
    case 'denied':
    case 'failed':
      return result('denied', code);
    case 'cancelled':
      return result('stopped', code);
    case 'unknown_external_state':
      return result('unknown_external_state');
    default:
      return undefined;
  }
}

const isWaiting = (proposal: StoredProposal) =>
  proposal.externalActionId !== null || proposal.status !== 'proposed';

/** A refusal or a stop, in one fresh transaction. Whatever tried to happen has already rolled back. */
async function recordEnd(
  turn: Turn,
  ending: {
    outcome: 'denied' | 'stopped';
    code: AiReasonCode | null;
    auditAs?: string | undefined;
  },
): Promise<ToolHandleResult> {
  const { deps, context, step, proposal, stepId } = turn;
  const denied = ending.outcome === 'denied';
  const recorded = await deps.store.withTx(context, async (tx) => {
    const locked = await deps.store.lockProposal(tx, proposal.id);
    if (locked?.status !== 'proposed') return null;
    await deps.store.moveProposal(tx, {
      proposalId: proposal.id,
      status: denied ? 'denied' : 'cancelled',
      decisionCode: ending.code,
    });
    await deps.store.updateStep(tx, {
      stepId,
      state: denied ? 'failed' : 'cancelled',
      outcome: ending.outcome,
      decisionCode: ending.code,
    });
    if (denied) {
      // The next turn has to be able to read why. Our own words, and no echo of what was asked for.
      const facts = await deps.store.readRun(tx, context, step.runId, { lock: false });
      await deps.store.writeOutput(tx, context, {
        stepId,
        classification: facts?.classification ?? 'restricted',
        content: JSON.stringify({ status: 'denied', code: ending.code }),
      });
    }
    const reason = ending.auditAs ?? ending.code;
    await deps.store.audit(tx, context, {
      action: denied ? 'ai.tool_denied' : 'ai.tool_stopped',
      targetRef: proposalRef(proposal),
      decision: 'deny',
      ...(reason ? { safeReason: reason } : {}),
    });
    return result(ending.outcome, ending.code);
  });
  return recorded ?? resume(turn);
}

/** Another attempt at this step moved it on while this one was working, so this one takes its answer. */
async function resume(turn: Turn): Promise<ToolHandleResult> {
  const current = await turn.deps.store.loadProposal(turn.context, {
    runId: turn.step.runId,
    stepNumber: turn.step.stepNumber,
  });
  if (!current) return result('denied', 'POLICY_UNREADABLE');
  return storedResult(current) ?? reconcile({ ...turn, proposal: current });
}

async function finishWithDecision(
  turn: Turn,
  run: () => Promise<ToolHandleResult>,
): Promise<ToolHandleResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Refusal) {
      return recordEnd(turn, { outcome: 'denied', code: error.code, auditAs: error.auditAs });
    }
    if (error instanceof Stop) return recordEnd(turn, { outcome: 'stopped', code: error.code });
    if (error instanceof AlreadyHandled) return resume(turn);
    if (errorName(error) === 'TenantAccessDenied') {
      return recordEnd(turn, { outcome: 'stopped', code: 'INITIATOR_INACTIVE' });
    }
    const code = appErrorCode(error);
    if (code === 'AI_HALTED') return recordEnd(turn, { outcome: 'stopped', code: 'HALTED' });
    const reason = typeof code === 'string' ? APP_ERROR_REASONS[code] : undefined;
    if (typeof code === 'string' && reason) {
      return recordEnd(turn, { outcome: 'denied', code: reason, auditAs: code });
    }
    // Not a decision: the database went away, say. Nothing was committed, so the Activity's retry is safe.
    throw error;
  }
}

/** What M3 says, and what that makes this step. Anything not on this list is unknown. */
function fromExternalStatus(status: string | null): {
  proposal: ProposalStatus;
  outcome: ToolOutcome;
  code: AiReasonCode | null;
} {
  switch (status) {
    case 'awaiting_approval':
      return {
        proposal: 'awaiting_approval',
        outcome: 'needs_approval',
        code: 'APPROVAL_REQUIRED',
      };
    case 'ready':
      return { proposal: 'approved', outcome: 'needs_approval', code: 'APPROVAL_REQUIRED' };
    // Sending, or finding out what a send did. It can still go either way, so this step keeps waiting.
    case 'sending':
    case 'reconciling':
      return { proposal: 'running', outcome: 'needs_approval', code: 'APPROVAL_REQUIRED' };
    case 'sent':
      return { proposal: 'done', outcome: 'done', code: null };
    case 'failed':
      return { proposal: 'failed', outcome: 'denied', code: null };
    case 'cancelled':
      return { proposal: 'denied', outcome: 'denied', code: 'APPROVAL_REQUIRED' };
    default:
      return { proposal: 'unknown_external_state', outcome: 'unknown_external_state', code: null };
  }
}

/**
 * This step already proposed, so it only reads where M3 has got to, however it got here: a retry after a
 * timeout, a poll, or the end of an approval wait. It never proposes again, and it never sends: M3 does
 * that, with its own at-most-one rule. An `unknown` stays unknown for good here, and a person resolves it
 * through M3's own flow.
 */
function reconcile(turn: Turn): Promise<ToolHandleResult> {
  const { deps, context, step, proposal, stepId } = turn;
  return deps.store.withTx(context, async (tx) => {
    const locked = await deps.store.lockProposal(tx, proposal.id);
    const settled = storedResult({
      toolId: proposal.toolId,
      status: locked?.status ?? 'denied',
      decisionCode: locked ? locked.decisionCode : 'POLICY_UNREADABLE',
    });
    if (settled) return settled;
    let status: string | null = null;
    if (proposal.externalActionId) {
      try {
        status = (await deps.externalActions.readState(tx, context, proposal.externalActionId))
          .status;
      } catch (error) {
        // The intent cannot be found, so nobody here can say what it did. Any other failure says
        // nothing about the intent, so it is thrown on and the read is tried again.
        if (appErrorCode(error) !== 'NOT_FOUND') throw error;
      }
    }
    const next = fromExternalStatus(status);
    await deps.store.moveProposal(tx, {
      proposalId: proposal.id,
      status: next.proposal,
      decisionCode: next.code,
    });
    if (next.outcome === 'needs_approval') return result('needs_approval', next.code);

    // `completed` rather than `failed` for an unknown one: a page must not say it failed.
    await deps.store.updateStep(tx, {
      stepId,
      state:
        next.proposal === 'done' || next.proposal === 'unknown_external_state'
          ? 'completed'
          : 'failed',
      outcome: next.outcome,
      decisionCode: next.code,
    });
    const facts = await deps.store.readRun(tx, context, step.runId, { lock: false });
    await deps.store.writeOutput(tx, context, {
      stepId,
      classification: facts?.classification ?? 'restricted',
      content: JSON.stringify({ status: next.proposal, code: next.code }),
    });
    await deps.store.audit(tx, context, {
      action: next.outcome === 'done' ? 'ai.tool_done' : 'ai.tool_stopped',
      targetRef: proposalRef(proposal),
      decision: next.outcome === 'done' ? 'allow' : 'deny',
      ...(next.outcome === 'unknown_external_state'
        ? { safeReason: 'UNKNOWN_EXTERNAL_STATE' }
        : {}),
    });
    return result(next.outcome, next.code);
  });
}

/** Refused before there is a proposal or a step to write on: only the audit row can say so. */
async function refuseUnrecorded(deps: Deps, context: AgentContext, step: ToolStepRef) {
  await deps.store.withTx(context, (tx) =>
    deps.store.audit(tx, context, {
      action: 'ai.tool_denied',
      targetRef: `agent_run:${step.runId}`,
      decision: 'deny',
      safeReason: 'POLICY_UNREADABLE',
    }),
  );
  return result('denied', 'POLICY_UNREADABLE');
}

export function createToolGateway(deps: Deps): ToolGateway {
  const { store } = deps;
  return {
    async handle(context, step) {
      // A context speaks for one run. Nothing is read for any other, and nothing is written.
      if (context.actorType !== 'agent' || !sameId(context.agentRunId, step.runId)) {
        return result('denied', 'POLICY_UNREADABLE');
      }
      const facts = await store.withTx(context, (tx) =>
        store.readRun(tx, context, step.runId, { lock: false }),
      );
      // Row-level security makes another tenant's run look absent here, so it ends the same way.
      if (
        !facts ||
        !sameId(facts.initiatorMembershipId, context.membershipId) ||
        !sameId(facts.workUnitId, step.workUnitId) ||
        !sameId(facts.agentVersionId, step.agentVersionId)
      ) {
        return refuseUnrecorded(deps, context, step);
      }
      const proposal = await store.loadProposal(context, {
        runId: step.runId,
        stepNumber: step.stepNumber,
      });
      if (!proposal) return refuseUnrecorded(deps, context, step);

      const stored = storedResult(proposal);
      if (stored) return stored;

      const opened = await store.withTx(context, (tx) =>
        store.openStep(tx, context, {
          runId: step.runId,
          stepNumber: step.stepNumber,
          toolId: proposal.toolId,
        }),
      );
      if (!opened) return refuseUnrecorded(deps, context, step);

      const turn: Turn = { deps, context, step, proposal, stepId: opened.stepId };
      if (isWaiting(proposal)) return reconcile(turn);
      return finishWithDecision(turn, () => runPipeline(turn, facts));
    },
  };
}
