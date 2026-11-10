// Binds an agent's action to a person's consent (AGENT-04, QA-007 agent path, threat SEC-014, ADR-027 D1,
// ADR-028). That consent is the only thing authorizing an outside effect, so nothing here trusts a model, an
// earlier check, or anything a row said a moment ago.
//
// The approval and its hash are M3's: `proposeExternalActionInTx` writes the intent and the approval with one
// hash, and this file makes no second one. It reuses `actionHash` and `checkExecution`, and rewrites neither.
//
// Locks go work, then approval, then intent, the same order everything that closes an approval takes, and the
// run and members after those. The decisions are pure functions over what those locks returned, so what they
// looked at cannot change before the step acting on them commits.
import { emailSendPayloadSchema, type EmailSendPayload } from '@ensemus/contracts/external-actions';
import {
  agentDefinitions,
  agentRuns,
  agentVersions,
  approvalDecisions,
  approvals,
  externalActions,
  memberships,
  modelProfiles,
  toolProposals,
  users,
  withTenantTx,
  workAssignments,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  strongestClassification,
  type AiClassification,
  type ProviderKind,
} from '@ensemus/domain/ai';
import { toolManifest, type ToolManifest } from '@ensemus/domain/ai-tools';
import {
  actionHash,
  checkExecution,
  effectiveApprovalStatus,
  type ProposedAction,
} from '@ensemus/domain/approval';
import { connectionRef } from '@ensemus/domain/external-action';
import { canChangeWork, canReadWork, type Classification } from '@ensemus/domain/policy';
import { decideAction } from '@ensemus/policy';
import { and, eq, inArray } from 'drizzle-orm';
import { AppError } from '../errors';
import { onApprovalClosedInTx } from '../external-actions';
import { canonicalId, idSchema } from '../ids';
import {
  auditAction,
  clearApprovalNotifications,
  closeReviewsForLostAccess,
  loadReadable,
  notify,
} from '../work';
import type {
  ApprovalBinder,
  ApprovalRef,
  ExternalActionPort,
  HaltCheck,
  HaltTarget,
  RecheckResult,
} from './ports';

// --- The facts each decision is made from.

export type MemberFacts = { membershipId: string; role: string; status: string };

export type WorkFacts = {
  id: string;
  status: string;
  classification: string;
  ownerMembershipId: string | null;
};

export type ProposalFacts = {
  id: string;
  runId: string;
  toolId: string;
  toolVersion: string;
  approvalId: string | null;
  externalActionId: string | null;
  status: string;
};

export type RunFacts = {
  id: string;
  workUnitId: string;
  agentVersionId: string;
  status: string;
  initiatorMembershipId: string;
  effectiveClassification: string;
  delegatedScopes: unknown;
  boundProfileId: string | null;
};

export type ApprovalFacts = {
  id: string;
  workUnitId: string;
  status: string;
  expiresAt: Date;
  actionHash: string;
  action: unknown;
  approverMembershipId: string;
  requestedByMembershipId: string | null;
};

export type IntentFacts = {
  id: string;
  workUnitId: string;
  connectionId: string;
  approvalId: string | null;
  toolName: string;
  toolVersion: string;
  targetRef: string;
  payload: unknown;
  requestHash: string;
  status: string;
};

export type DecisionFacts = { actorMembershipId: string; decision: string; actionHash: string };

export type AgentGrants = { allow: readonly string[]; deny: readonly string[] };

// --- Who is asked. Pure, so every case runs without a database.

/**
 * The approver comes from policy and from nothing a model said: the Work Unit's accountable owner, unless
 * that is the initiator or they can no longer do it, and then another owner or admin who can read the work.
 * Null means nobody, which the caller refuses. It is deterministic, so a retry asks the same person.
 */
export function selectApprover(facts: {
  work: { classification: string; ownerMembershipId: string | null };
  initiatorMembershipId: string;
  /** The accountable owner's row, if there is one, and the organization's owners and admins. */
  members: readonly MemberFacts[];
  assigned: readonly string[];
}): string | null {
  const initiator = canonicalId(facts.initiatorMembershipId);
  const owner = facts.work.ownerMembershipId && canonicalId(facts.work.ownerMembershipId);
  const assigned = new Set(facts.assigned.map(canonicalId));
  const eligible = (member: MemberFacts) =>
    member.status === 'active' &&
    canonicalId(member.membershipId) !== initiator &&
    canReadWork(
      {
        classification: facts.work.classification as Classification,
        ownerMembershipId: owner,
        isAssigned: assigned.has(canonicalId(member.membershipId)),
      },
      { membershipId: canonicalId(member.membershipId), role: member.role },
    );

  const accountable = facts.members.find((member) => canonicalId(member.membershipId) === owner);
  if (accountable && eligible(accountable)) return accountable.membershipId;

  const rank = (member: MemberFacts) => (member.role === 'owner' ? 0 : 1);
  const [first] = facts.members
    .filter((member) => (member.role === 'owner' || member.role === 'admin') && eligible(member))
    .sort(
      (a, b) =>
        rank(a) - rank(b) || (canonicalId(a.membershipId) < canonicalId(b.membershipId) ? -1 : 1),
    );
  return first?.membershipId ?? null;
}

// --- The rules of a recheck, pure for the same reason.

/** The two statuses migration 0101's attempt trigger also accepts. A paused run may not act. */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting_for_approval']);
// Failed work can be reopened in the kernel, so it is not a terminal state there. Its current run
// has nevertheless stopped: an earlier approval cannot authorize another send until work resumes.
const STOPPED_WORK_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function delegatedTools(scopes: unknown): readonly string[] {
  return stringList((scopes as { tools?: unknown } | null)?.tools);
}

/** A stored spec is only read as far as it plainly says something. What it does not say grants nothing. */
function grantsFromSpec(spec: unknown): AgentGrants {
  const tools = (spec as { tools?: { allow?: unknown; deny?: unknown } } | null)?.tools;
  return { allow: stringList(tools?.allow), deny: stringList(tools?.deny) };
}

function dataClassOf(runClass: string, workClass: string): AiClassification {
  return strongestClassification(runClass as AiClassification, workClass as AiClassification);
}

/**
 * A send has to come out as "ask a person". `allow` would mean that a tool the manifest says always asks has
 * stopped asking, so it gets the same answer as a deny. Restricted data does not leave: M3 refuses restricted
 * work, and this also covers a run whose class rose above its work's by reading something.
 */
function policyPermits(
  manifest: ToolManifest,
  run: RunFacts,
  work: { classification: string },
  grants: AgentGrants,
): boolean {
  const dataClass = dataClassOf(run.effectiveClassification, work.classification);
  if (dataClass === 'restricted') return false;
  const decided = decideAction({
    toolId: manifest.id,
    toolClass: manifest.class,
    allow: grants.allow,
    deny: grants.deny,
    delegated: delegatedTools(run.delegatedScopes),
    dataClass,
    destructive: false,
    requiresApproval: manifest.requiresApproval,
  });
  return decided.decision === 'require_approval';
}

const isExternalWrite = (manifest: ToolManifest | undefined): manifest is ToolManifest =>
  manifest !== undefined && manifest.class === 'external_write' && manifest.requiresApproval;

type RecheckFacts = {
  callerMembershipId: string;
  proposal: ProposalFacts;
  run: RunFacts;
  work: WorkFacts | null;
  approval: ApprovalFacts | null;
  intent: IntentFacts | null;
  initiator: MemberFacts | null;
  approver: MemberFacts | null;
  assigned: readonly string[];
  decisions: readonly DecisionFacts[];
  grants: AgentGrants;
};

const refuse = (code: Extract<RecheckResult, { ok: false }>['code']): RecheckResult => ({
  ok: false,
  code,
});

function evaluateRecheck(facts: RecheckFacts, now: Date): RecheckResult {
  const { proposal, run, work, approval, intent } = facts;
  const notValid = refuse('APPROVAL_NOT_VALID');
  const assigned = new Set(facts.assigned);
  const accessOf = (subject: WorkFacts, membershipId: string) => ({
    classification: subject.classification as Classification,
    ownerMembershipId: subject.ownerMembershipId,
    isAssigned: assigned.has(membershipId),
  });

  // One intent, one approval, this run, this Work Unit. An approval that belongs to anything else is no
  // consent to this.
  if (!work || !approval || !intent) return notValid;
  if (
    approval.id !== proposal.approvalId ||
    intent.id !== proposal.externalActionId ||
    intent.approvalId !== approval.id ||
    approval.workUnitId !== run.workUnitId ||
    intent.workUnitId !== run.workUnitId ||
    work.id !== run.workUnitId
  ) {
    return notValid;
  }

  if (!LIVE_RUN_STATUSES.has(run.status) || STOPPED_WORK_STATUSES.has(work.status)) {
    return refuse('RUN_NOT_RUNNING');
  }

  // The initiator's authority as the database holds it now, not as the context was built a moment ago.
  const { initiator } = facts;
  const manifest = toolManifest(proposal.toolId);
  if (
    run.initiatorMembershipId !== facts.callerMembershipId ||
    initiator?.status !== 'active' ||
    !canChangeWork(accessOf(work, initiator.membershipId), {
      membershipId: initiator.membershipId,
      role: initiator.role,
    }) ||
    !isExternalWrite(manifest)
  ) {
    return refuse('POLICY_DENIED');
  }

  if (
    approval.requestedByMembershipId !== run.initiatorMembershipId ||
    approval.approverMembershipId === run.initiatorMembershipId
  ) {
    return notValid;
  }

  // Past its time it is over, whatever the row says and whoever can still read the work.
  const status = effectiveApprovalStatus(approval, now);
  if (status !== 'approved' && status !== 'pending' && status !== 'expired') return notValid;
  if (status === 'expired' || now >= approval.expiresAt) return refuse('APPROVAL_EXPIRED');
  // Its approval is spent or withdrawn. Asking again is a new intent with a new approval (ADR-027 D1).
  if (intent.status === 'cancelled' || intent.status === 'failed') return notValid;

  // Being asked is not an access grant, and neither is having agreed once.
  const { approver } = facts;
  const approverCanRead =
    approver?.status === 'active' &&
    canReadWork(accessOf(work, approver.membershipId), {
      membershipId: approver.membershipId,
      role: approver.role,
    });
  if (!approverCanRead) return refuse('APPROVER_LOST_ACCESS');

  // Closing stale consent is required even if a simultaneous class/policy change also forbids this
  // effect. Otherwise the earlier policy refusal leaves a once-approved intent spendable elsewhere.
  // The binding, initiator, lifecycle and expiry checks above still run before closing anything.
  if (!policyPermits(manifest, run, work, facts.grants)) return refuse('POLICY_DENIED');

  // Everything the hash covers is taken from the intent as stored now, including the target as written.
  const action: ProposedAction = {
    toolName: intent.toolName,
    toolVersion: intent.toolVersion,
    targetRef: intent.targetRef,
    payload: intent.payload,
  };
  const executable = checkExecution(
    {
      status: approval.status as 'approved',
      expiresAt: approval.expiresAt,
      boundHash: approval.actionHash,
    },
    { action, now },
  );
  if (!executable.ok) {
    if (executable.reason === 'EXPIRED') return refuse('APPROVAL_EXPIRED');
    if (executable.reason === 'HASH_MISMATCH') return refuse('PAYLOAD_CHANGED');
    return notValid;
  }
  if (
    intent.requestHash !== approval.actionHash ||
    intent.targetRef !== connectionRef(intent.connectionId) ||
    actionHash(approval.action as ProposedAction) !== approval.actionHash ||
    proposal.toolId !== intent.toolName ||
    proposal.toolVersion !== intent.toolVersion ||
    manifest.version !== intent.toolVersion
  ) {
    return refuse('PAYLOAD_CHANGED');
  }

  // A row saying `approved` is not the consent. The consent is the person's decision, on this hash.
  const decided = facts.decisions.some(
    (decision) =>
      decision.decision === 'approve' &&
      decision.actorMembershipId === approval.approverMembershipId &&
      decision.actionHash === approval.actionHash,
  );
  return decided ? { ok: true } : notValid;
}

// --- Storage. Every method takes the caller's transaction, and none of them can open another.

export type AgentActionRow = {
  toolId: string;
  toolVersion: string;
  runId: string;
  runWorkUnitId: string;
  agentVersionId: string;
  agentVersionNumber: number;
  agentName: string;
  initiatorMembershipId: string;
  initiatorName: string | null;
  effectiveClassification: string;
};

export interface ApprovalStore {
  findProposal(tx: Tx, proposalId: string): Promise<ProposalFacts | null>;
  lockProposal(tx: Tx, proposalId: string): Promise<ProposalFacts | null>;
  findRun(tx: Tx, runId: string): Promise<RunFacts | null>;
  /** Shared, so stopping the run waits for this transaction, or commits first and is seen by it. */
  lockRun(tx: Tx, runId: string): Promise<RunFacts | null>;
  /** Under the initiator's own access. Work they cannot read is NOT_FOUND. */
  lockReadableWork(tx: Tx, context: TenantContext, workUnitId: string): Promise<WorkFacts>;
  lockWork(tx: Tx, workUnitId: string): Promise<WorkFacts | null>;
  lockApproval(tx: Tx, approvalId: string): Promise<ApprovalFacts | null>;
  lockIntent(tx: Tx, externalActionId: string): Promise<IntentFacts | null>;
  /** Shared, so disabling or demoting this person waits, or commits first and is seen. */
  lockMember(tx: Tx, membershipId: string): Promise<MemberFacts | null>;
  listElevatedMembers(tx: Tx): Promise<readonly MemberFacts[]>;
  listAssigned(tx: Tx, workUnitId: string): Promise<readonly string[]>;
  listDecisions(tx: Tx, approvalId: string): Promise<readonly DecisionFacts[]>;
  readGrants(tx: Tx, agentVersionId: string): Promise<AgentGrants>;
  readProviderKind(tx: Tx, profileId: string): Promise<ProviderKind | null>;
  bindProposal(tx: Tx, proposalId: string, ref: ApprovalRef): Promise<void>;
  closeForLostAccess(
    tx: Tx,
    context: TenantContext,
    approval: ApprovalFacts,
    work: WorkFacts,
  ): Promise<void>;
  findApprovalForView(tx: Tx, approvalId: string): Promise<ApprovalFacts | null>;
  readableWork(tx: Tx, context: TenantContext, workUnitId: string): Promise<WorkFacts>;
  agentActionRow(tx: Tx, approvalId: string): Promise<AgentActionRow | null>;
}

const proposalColumns = {
  id: toolProposals.id,
  runId: toolProposals.runId,
  toolId: toolProposals.toolId,
  toolVersion: toolProposals.toolVersion,
  approvalId: toolProposals.approvalId,
  externalActionId: toolProposals.externalActionId,
  status: toolProposals.status,
};

const runColumns = {
  id: agentRuns.id,
  workUnitId: agentRuns.workUnitId,
  agentVersionId: agentRuns.agentVersionId,
  status: agentRuns.status,
  initiatorMembershipId: agentRuns.initiatorMembershipId,
  effectiveClassification: agentRuns.effectiveClassification,
  delegatedScopes: agentRuns.delegatedScopes,
  boundProfileId: agentRuns.boundProfileId,
};

const approvalColumns = {
  id: approvals.id,
  workUnitId: approvals.workUnitId,
  status: approvals.status,
  expiresAt: approvals.expiresAt,
  actionHash: approvals.actionHash,
  action: approvals.action,
  approverMembershipId: approvals.approverMembershipId,
  requestedByMembershipId: approvals.requestedByMembershipId,
};

const intentColumns = {
  id: externalActions.id,
  workUnitId: externalActions.workUnitId,
  connectionId: externalActions.connectionId,
  approvalId: externalActions.approvalId,
  toolName: externalActions.toolName,
  toolVersion: externalActions.toolVersion,
  targetRef: externalActions.targetRef,
  payload: externalActions.payload,
  requestHash: externalActions.requestHash,
  status: externalActions.status,
};

const memberColumns = {
  membershipId: memberships.id,
  role: memberships.role,
  status: memberships.status,
};

const workFactsOf = (row: WorkFacts): WorkFacts => ({
  id: row.id,
  status: row.status,
  classification: row.classification,
  ownerMembershipId: row.ownerMembershipId,
});

const postgresStore: ApprovalStore = {
  async findProposal(tx, proposalId) {
    const [row] = await tx
      .select(proposalColumns)
      .from(toolProposals)
      .where(eq(toolProposals.id, proposalId));
    return row ?? null;
  },
  async lockProposal(tx, proposalId) {
    const [row] = await tx
      .select(proposalColumns)
      .from(toolProposals)
      .where(eq(toolProposals.id, proposalId))
      .for('update');
    return row ?? null;
  },
  async findRun(tx, runId) {
    const [row] = await tx.select(runColumns).from(agentRuns).where(eq(agentRuns.id, runId));
    return row ?? null;
  },
  async lockRun(tx, runId) {
    const [row] = await tx
      .select(runColumns)
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for('share');
    return row ?? null;
  },
  async lockReadableWork(tx, context, workUnitId) {
    return workFactsOf(await loadReadable(tx, context, workUnitId, true));
  },
  async lockWork(tx, workUnitId) {
    const [row] = await tx
      .select()
      .from(workUnits)
      .where(eq(workUnits.id, workUnitId))
      .for('update');
    return row ? workFactsOf(row) : null;
  },
  async lockApproval(tx, approvalId) {
    const [row] = await tx
      .select(approvalColumns)
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .for('update');
    return row ?? null;
  },
  async lockIntent(tx, externalActionId) {
    const [row] = await tx
      .select(intentColumns)
      .from(externalActions)
      .where(eq(externalActions.id, externalActionId))
      .for('update');
    return row ?? null;
  },
  async lockMember(tx, membershipId) {
    const [row] = await tx
      .select(memberColumns)
      .from(memberships)
      .where(eq(memberships.id, membershipId))
      .for('share');
    return row ?? null;
  },
  async listElevatedMembers(tx) {
    return tx
      .select(memberColumns)
      .from(memberships)
      .where(and(eq(memberships.status, 'active'), inArray(memberships.role, ['owner', 'admin'])));
  },
  async listAssigned(tx, workUnitId) {
    const rows = await tx
      .select({ membershipId: workAssignments.membershipId })
      .from(workAssignments)
      .where(eq(workAssignments.workUnitId, workUnitId));
    return rows.map((row) => row.membershipId);
  },
  async listDecisions(tx, approvalId) {
    return tx
      .select({
        actorMembershipId: approvalDecisions.actorMembershipId,
        decision: approvalDecisions.decision,
        actionHash: approvalDecisions.actionHash,
      })
      .from(approvalDecisions)
      .where(eq(approvalDecisions.approvalId, approvalId));
  },
  async readGrants(tx, agentVersionId) {
    const [row] = await tx
      .select({ spec: agentVersions.spec })
      .from(agentVersions)
      .where(eq(agentVersions.id, agentVersionId));
    return grantsFromSpec(row?.spec);
  },
  async readProviderKind(tx, profileId) {
    const [row] = await tx
      .select({ providerKind: modelProfiles.providerKind })
      .from(modelProfiles)
      .where(eq(modelProfiles.id, profileId));
    return (row?.providerKind as ProviderKind | undefined) ?? null;
  },
  async bindProposal(tx, proposalId, ref) {
    await tx
      .update(toolProposals)
      .set({
        approvalId: ref.approvalId,
        externalActionId: ref.externalActionId,
        status: 'awaiting_approval',
        updatedAt: new Date(),
      })
      .where(eq(toolProposals.id, proposalId));
  },
  async closeForLostAccess(tx, context, approval, work) {
    // M2's own path for an open one: it tells people, wakes the workflow and ends a plan that needed it.
    if (approval.status === 'pending') {
      await closeReviewsForLostAccess(tx, context, { workUnitId: approval.workUnitId });
      return;
    }
    // An approved one has no such path, because it was resolved when it was decided. Closing it here is what
    // stops the decision being spent: M3's recheck at the attempt refuses an approval that is not approved.
    const closed = await tx
      .update(approvals)
      .set({ status: 'cancelled', decidedAt: new Date() })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, 'approved')))
      .returning({ id: approvals.id });
    if (closed.length === 0) return;
    await clearApprovalNotifications(tx, [approval.id]);
    await onApprovalClosedInTx(tx, context, { approvalId: approval.id, outcome: 'cancelled' });
    await auditAction(
      tx,
      context,
      'approval.closed',
      `approval:${approval.id}`,
      'APPROVER_LOST_ACCESS',
    );
    await notify(
      tx,
      context,
      [work.ownerMembershipId, approval.requestedByMembershipId],
      'approval.closed',
      `work_unit:${work.id}`,
    );
  },
  async findApprovalForView(tx, approvalId) {
    const [row] = await tx
      .select(approvalColumns)
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    return row ?? null;
  },
  async readableWork(tx, context, workUnitId) {
    return workFactsOf(await loadReadable(tx, context, workUnitId));
  },
  async agentActionRow(tx, approvalId) {
    const [row] = await tx
      .select({
        toolId: toolProposals.toolId,
        toolVersion: toolProposals.toolVersion,
        runId: agentRuns.id,
        runWorkUnitId: agentRuns.workUnitId,
        agentVersionId: agentVersions.id,
        agentVersionNumber: agentVersions.versionNumber,
        agentName: agentDefinitions.name,
        initiatorMembershipId: agentRuns.initiatorMembershipId,
        initiatorName: users.name,
        effectiveClassification: agentRuns.effectiveClassification,
      })
      .from(toolProposals)
      .innerJoin(agentRuns, eq(agentRuns.id, toolProposals.runId))
      .innerJoin(agentVersions, eq(agentVersions.id, agentRuns.agentVersionId))
      .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentVersions.definitionId))
      .innerJoin(memberships, eq(memberships.id, agentRuns.initiatorMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(eq(toolProposals.approvalId, approvalId));
    return row ?? null;
  },
};

// --- The binder.

function assertAgent(context: { actorType: string }) {
  if (context.actorType !== 'agent') throw new AppError('FORBIDDEN');
}

/** What is halted for this run: its agent version, and the provider it is pinned to if it has one. */
async function haltTargetOf(store: ApprovalStore, tx: Tx, run: RunFacts): Promise<HaltTarget> {
  const providerKind = run.boundProfileId
    ? await store.readProviderKind(tx, run.boundProfileId)
    : null;
  return { agentVersionId: run.agentVersionId, ...(providerKind ? { providerKind } : {}) };
}

/** The binder over any store. `createApprovalBinder` is this over PostgreSQL, and tests use a double. */
export function binderOver(
  store: ApprovalStore,
  deps: { externalActions: ExternalActionPort; halt: HaltCheck },
): ApprovalBinder {
  return {
    async request(tx, context, input) {
      assertAgent(context);
      if (canonicalId(input.runId) !== canonicalId(context.agentRunId)) {
        throw new AppError('FORBIDDEN');
      }
      const proposal = await store.findProposal(tx, input.proposalId);
      if (!proposal || proposal.runId !== canonicalId(input.runId)) {
        throw new AppError('NOT_FOUND');
      }
      const manifest = toolManifest(input.toolId);
      if (
        !isExternalWrite(manifest) ||
        manifest.version !== input.toolVersion ||
        proposal.toolId !== input.toolId ||
        proposal.toolVersion !== input.toolVersion
      ) {
        throw new AppError('TOOL_DENIED');
      }
      const found = await store.findRun(tx, proposal.runId);
      if (!found || found.workUnitId !== canonicalId(input.workUnitId)) {
        throw new AppError('NOT_FOUND');
      }
      if (found.initiatorMembershipId !== context.membershipId) throw new AppError('FORBIDDEN');

      const work = await store.lockReadableWork(tx, context, found.workUnitId);
      if (STOPPED_WORK_STATUSES.has(work.status)) throw new AppError('INVALID_STATE');
      const run = await store.lockRun(tx, found.id);
      if (!run || !LIVE_RUN_STATUSES.has(run.status)) throw new AppError('INVALID_STATE');
      await deps.halt.assertRunning(tx, context, await haltTargetOf(store, tx, run));

      const locked = await store.lockProposal(tx, proposal.id);
      if (!locked) throw new AppError('NOT_FOUND');
      // A retry of the same step finds what it already asked for. A person agreed, or will agree, to what
      // that intent froze, so a retry can never change what they see, and nobody is asked twice.
      if (locked.approvalId || locked.externalActionId) {
        const approval = locked.approvalId && (await store.lockApproval(tx, locked.approvalId));
        if (!approval || !locked.externalActionId) throw new AppError('INVALID_STATE');
        return {
          approvalId: approval.id,
          externalActionId: locked.externalActionId,
          requestHash: approval.actionHash,
        };
      }
      if (locked.status !== 'proposed') throw new AppError('INVALID_STATE');

      if (dataClassOf(run.effectiveClassification, work.classification) === 'restricted') {
        throw new AppError('RESTRICTED_NOT_ALLOWED');
      }
      if (!policyPermits(manifest, run, work, await store.readGrants(tx, run.agentVersionId))) {
        throw new AppError('POLICY_DENIED');
      }

      const accountable = work.ownerMembershipId
        ? await store.lockMember(tx, work.ownerMembershipId)
        : null;
      const approverMembershipId = selectApprover({
        work,
        initiatorMembershipId: run.initiatorMembershipId,
        members: [...(accountable ? [accountable] : []), ...(await store.listElevatedMembers(tx))],
        assigned: await store.listAssigned(tx, work.id),
      });
      if (!approverMembershipId) throw new AppError('NO_ELIGIBLE_APPROVER');

      // No expiry is named here: M3 decides how long a review lasts, the same for every approval.
      const proposed = await deps.externalActions.propose(tx, context, {
        workUnitId: work.id,
        connectionId: input.connectionId,
        toolName: input.toolId,
        toolVersion: input.toolVersion,
        payload: input.payload,
        approverMembershipId,
      });
      const ref: ApprovalRef = {
        approvalId: proposed.approvalId,
        externalActionId: proposed.externalActionId,
        requestHash: proposed.requestHash,
      };
      // In this transaction, because migration 0101's trigger finds the run through this link. An intent
      // committed without it would look like one no agent proposed, and that trigger would let it through.
      await store.bindProposal(tx, proposal.id, ref);
      return ref;
    },

    /**
     * Run in the same transaction as the step that acts on the approval. Its locks last until that
     * transaction ends, so nothing it checked can change before the step commits. An approver who lost
     * access also closes the approval here, so nothing else can spend it. A caller that rolls back undoes
     * that, and the next recheck does it again.
     */
    async recheck(tx, context, input) {
      assertAgent(context);
      const proposal = await store.findProposal(tx, input.proposalId);
      if (!proposal || proposal.runId !== canonicalId(context.agentRunId)) {
        return refuse('APPROVAL_NOT_VALID');
      }
      const found = await store.findRun(tx, proposal.runId);
      if (!found) return refuse('APPROVAL_NOT_VALID');

      const work = await store.lockWork(tx, found.workUnitId);
      const approval = proposal.approvalId
        ? await store.lockApproval(tx, proposal.approvalId)
        : null;
      const intent = proposal.externalActionId
        ? await store.lockIntent(tx, proposal.externalActionId)
        : null;
      const run = await store.lockRun(tx, found.id);
      if (!run) return refuse('APPROVAL_NOT_VALID');
      const initiator = await store.lockMember(tx, run.initiatorMembershipId);
      const approver = approval ? await store.lockMember(tx, approval.approverMembershipId) : null;
      const verdict = evaluateRecheck(
        {
          callerMembershipId: context.membershipId,
          proposal,
          run,
          work,
          approval,
          intent,
          initiator,
          approver,
          assigned: await store.listAssigned(tx, run.workUnitId),
          decisions: approval ? await store.listDecisions(tx, approval.id) : [],
          grants: await store.readGrants(tx, run.agentVersionId),
        },
        new Date(),
      );

      // Last of the reads: a failed read aborts the transaction, so this could not be followed by another.
      try {
        await deps.halt.assertRunning(tx, context, await haltTargetOf(store, tx, run));
      } catch (error) {
        if (error instanceof AppError && error.code === 'AI_HALTED') return refuse('HALTED');
        throw error;
      }

      if (!verdict.ok && verdict.code === 'APPROVER_LOST_ACCESS' && approval && work) {
        await store.closeForLostAccess(tx, context, approval, work);
      }
      return verdict;
    },
  };
}

export function createApprovalBinder(deps: {
  externalActions: ExternalActionPort;
  halt: HaltCheck;
}): ApprovalBinder {
  return binderOver(postgresStore, deps);
}

// --- What the approval page shows.

/** What the approval page shows beside an agent's action. Web may call this: it reads no prompt. */
export type AgentActionView = {
  initiatorMembershipId: string;
  initiatorName: string | null;
  agentVersionId: string;
  agentVersionNumber: number;
  agentName: string;
  agentRunId: string;
  toolId: string;
  toolVersion: string;
  /** The stronger of the run's class and the work's, since the run's rises with what it has read. */
  dataClass: string;
  riskLabel: 'external_write';
  expiresAt: Date;
  requestHash: string;
  /** Exactly what the approval binds. This is what a person agrees to, not what a model asked for. */
  action: ProposedAction;
  /** The same payload as stored, when it is an email, so each field can be shown as itself. */
  email: EmailSendPayload | null;
  /** False if the stored rows disagree with each other. Nobody should approve that. */
  consistent: boolean;
};

/** Parsed to check its shape only. The schema trims text, and a reviewer has to see it as it would go. */
function emailOf(action: ProposedAction): EmailSendPayload | null {
  return emailSendPayloadSchema.safeParse(action.payload).success
    ? (action.payload as EmailSendPayload)
    : null;
}

/**
 * The reading behind `getAgentActionForApproval`, on a transaction it was given. It takes the initiator, the
 * agent and the class from the proposal and its run, and the payload from the approval's own action.
 */
export async function readAgentAction(
  store: ApprovalStore,
  tx: Tx,
  context: TenantContext,
  approvalId: string,
): Promise<AgentActionView | null> {
  if (!idSchema.safeParse(approvalId).success) throw new AppError('NOT_FOUND');
  const approval = await store.findApprovalForView(tx, approvalId);
  if (!approval) throw new AppError('NOT_FOUND');
  // Someone who cannot see the work gets not found, the same as for the approval itself.
  const work = await store.readableWork(tx, context, approval.workUnitId);
  const row = await store.agentActionRow(tx, approval.id);
  if (!row) return null;
  const action = approval.action as ProposedAction;
  return {
    initiatorMembershipId: row.initiatorMembershipId,
    initiatorName: row.initiatorName,
    agentVersionId: row.agentVersionId,
    agentVersionNumber: row.agentVersionNumber,
    agentName: row.agentName,
    agentRunId: row.runId,
    toolId: row.toolId,
    toolVersion: row.toolVersion,
    dataClass: dataClassOf(row.effectiveClassification, work.classification),
    riskLabel: 'external_write',
    expiresAt: approval.expiresAt,
    requestHash: approval.actionHash,
    action,
    email: emailOf(action),
    consistent:
      actionHash(action) === approval.actionHash &&
      action.toolName === row.toolId &&
      action.toolVersion === row.toolVersion &&
      row.runWorkUnitId === approval.workUnitId,
  };
}

/** Null when this approval is not an agent's. Needs the same access as reading the approval itself. */
export function getAgentActionForApproval(
  database: AppDatabase,
  context: TenantContext,
  approvalId: string,
): Promise<AgentActionView | null> {
  return withTenantTx(database, context, (tx) =>
    readAgentAction(postgresStore, tx, context, approvalId),
  );
}

// Control characters other than tab and line breaks, soft hyphens, zero-width characters, and the marks that
// reorder text. None of them shows, and each can make an address or a file name read as something else.
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * Text a model wrote, made safe to read. React already stops it being markup. This stops a reviewer agreeing
 * to something other than what they think they read, by writing each hidden character out.
 */
export function showInvisible(text: string): string {
  return text.replace(
    INVISIBLE,
    (character) => `\\u{${(character.codePointAt(0) as number).toString(16).toUpperCase()}}`,
  );
}
