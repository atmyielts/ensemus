// Owned by the delegation slice (AGENT-05). See docs/06-delivery/m4-slices.md and ADR-028 FD-16. Only
// agent-worker uses this. A child gets its own Work Unit, a queued run with the same initiator, one level
// deeper, the intersection of the tools, the parent's class as a floor, the parent's pinned profile and
// money carved from the parent. The rules are pure and in `decideDelegation`. This file reads what they need,
// under a lock on the parent, and writes what they say. Migration 0101 refuses a wider child even if it is
// wrong. Everything runs on the agent's context, so the initiator's access decides (FD-3).
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import { agentDelegateArgsSchema } from '@ensemus/contracts/ai-tools';
import {
  actorOf,
  agentDefinitions,
  agentPublications,
  agentRuns,
  agentVersions,
  appendAudit,
  auditEvents,
  policyBundles,
  runControls,
  withTenantTx,
  workAssignments,
  workUnits,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { isTerminalAgentRun, type AgentRunStatus, type AiClassification } from '@ensemus/domain/ai';
import { can } from '@ensemus/domain/policy';
import { isTerminal, type WorkState } from '@ensemus/domain/work-unit';
import { scanForSecrets } from '@ensemus/policy';
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
// By path, because @ensemus/agent-runtime depends on this package and a dependency back would be a cycle.
// That file is pure and imports only pure vocabulary, so this brings nothing else with it.
import {
  decideDelegation,
  readOrgDelegationLimits,
  type DelegationCode,
} from '../../../agent-runtime/src/delegation';
import { AppError, pgCode } from '../errors';
import { emit } from '../events';
import { idSchema } from '../ids';
import { idFromRequest } from '../request-id';
import { loadChangeable } from '../work';
import { createHaltCheck } from './halt';
import { loadProposal } from './tool-steps';

export type ChildRunResult =
  | { kind: 'created'; childWorkUnitId: string; childRunId: string; maxCostMicros: number }
  | { kind: 'denied'; code: DelegationCode };

const DELEGATE_TOOL = 'agent.delegate';
const DENIED_ACTION = 'agent_run.delegation_denied';
const CREATED_ACTION = 'agent_run.delegated';
/** The record that a child's spending is in its parent's counter. It is also what makes settling repeatable. */
const SETTLED_ACTION = 'agent_run.child_settled';
/** What migration 0101's triggers raise for a run that breaks a rule. */
const RUN_RULE_BROKEN = 'EN006';
/** A proposal the tool gateway turned down, or that went no further, authorizes nothing. */
const CLOSED_PROPOSALS: ReadonlySet<string> = new Set([
  'denied',
  'failed',
  'cancelled',
  'unknown_external_state',
]);
/** A parent in any other state is not at a step. A paused parent, for one, has been told to wait. */
const CAN_DELEGATE: ReadonlySet<string> = new Set<AgentRunStatus>(['running', 'waiting_for_child']);

const createInput = z.strictObject({ parentRunId: idSchema, stepNumber: z.int().min(0) });
const settleInput = z.strictObject({ parentRunId: idSchema, childRunId: idSchema });
const lookupInput = z.strictObject({ runId: idSchema });

const parseOrRefuse = <T>(schema: z.ZodType<T>, raw: unknown): T => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
};

const runRef = (runId: string) => `agent_run:${runId}`;

const isAgentFor = (context: AgentContext, runId: string) =>
  context.actorType === 'agent' && context.agentRunId === runId;

/**
 * One step of one parent always arrives at the same two IDs, so a retried Activity finds the child it made
 * and cannot make a second. The membership is in the hash, so nobody else can aim at these rows.
 */
const childIdsFor = (context: AgentContext, parentRunId: string, stepNumber: number) => ({
  workUnitId: idFromRequest('agent_child_work', context.membershipId, parentRunId, stepNumber),
  runId: idFromRequest('agent_child_run', context.membershipId, parentRunId, stepNumber),
});

const denyInTx = async (
  tx: Tx,
  context: AgentContext,
  parentRunId: string,
  code: DelegationCode,
  reason: string = code,
): Promise<ChildRunResult> => {
  await appendAudit(tx, {
    organizationId: context.organizationId,
    ...actorOf(context),
    action: DENIED_ACTION,
    targetRef: runRef(parentRunId),
    decision: 'deny',
    safeReason: reason,
  });
  return { kind: 'denied', code };
};

/** For a refusal found after the transaction it was found in has rolled back. */
const deny = (
  database: AppDatabase,
  context: AgentContext,
  parentRunId: string,
  code: DelegationCode,
  reason: string = code,
) => withTenantTx(database, context, (tx) => denyInTx(tx, context, parentRunId, code, reason));

/** A parent this context may not act for looks the same as one that does not exist, and is on the record. */
const refuseParent = async (database: AppDatabase, context: AgentContext, parentRunId: string) => {
  await withTenantTx(database, context, (tx) =>
    appendAudit(tx, {
      organizationId: context.organizationId,
      ...actorOf(context),
      action: DENIED_ACTION,
      targetRef: runRef(parentRunId),
      decision: 'deny',
      safeReason: 'NOT_FOUND',
    }),
  );
  return new AppError('NOT_FOUND');
};

const childSelection = {
  id: agentRuns.id,
  workUnitId: agentRuns.workUnitId,
  maxCostMicros: agentRuns.maxCostMicros,
};

const created = (child: {
  id: string;
  workUnitId: string;
  maxCostMicros: number;
}): ChildRunResult => ({
  kind: 'created',
  childWorkUnitId: child.workUnitId,
  childRunId: child.id,
  maxCostMicros: child.maxCostMicros,
});

type Settlement = {
  costMicros: number;
  /** Children still alive. They are what fan-out counts. */
  liveChildren: number;
  /** Children whose spending cannot be known yet, at what they may still cost. */
  holds: readonly { maxCostMicros: number; costMicros: number }[];
};

/** Which of these children already have their spending in their parent's counter. */
async function settledAmong(
  tx: Tx,
  children: readonly { id: string; createdAt: Date }[],
): Promise<ReadonlySet<string>> {
  const earliest = children.reduce(
    (first, child) => (child.createdAt < first ? child.createdAt : first),
    children[0]?.createdAt ?? new Date(),
  );
  const rows = await tx
    .select({ targetRef: auditEvents.targetRef })
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.occurredAt, earliest),
        eq(auditEvents.action, SETTLED_ACTION),
        inArray(
          auditEvents.targetRef,
          children.map((child) => runRef(child.id)),
        ),
      ),
    );
  return new Set(rows.map((row) => row.targetRef));
}

/**
 * Moves the spending of every finished child into this run's counter, from the bottom of the tree up. The
 * caller holds this run's row, and this takes each level's rows in one order, so two settles wait for each
 * other rather than both adding. A finished child with something still alive below it stays held at what it
 * was given: its final cost is not known, and adding it now would lose whatever that descendant goes on to
 * spend. The money stays taken until it can be counted properly, which over-counts and never under-counts.
 */
async function settleFinishedChildren(
  tx: Tx,
  context: AgentContext,
  run: { id: string; costMicros: number },
): Promise<Settlement> {
  const children = await tx
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      maxCostMicros: agentRuns.maxCostMicros,
      costMicros: agentRuns.costMicros,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.parentRunId, run.id))
    .orderBy(asc(agentRuns.id))
    .for('update');
  if (children.length === 0) return { costMicros: run.costMicros, liveChildren: 0, holds: [] };

  const settled = await settledAmong(tx, children);
  let added = 0;
  let liveChildren = 0;
  const holds: { maxCostMicros: number; costMicros: number }[] = [];
  for (const child of children) {
    if (settled.has(runRef(child.id))) continue;
    if (!isTerminalAgentRun(child.status as AgentRunStatus)) {
      liveChildren += 1;
      holds.push({ maxCostMicros: child.maxCostMicros, costMicros: child.costMicros });
      continue;
    }
    const below = await settleFinishedChildren(tx, context, child);
    if (below.holds.length > 0) {
      holds.push({ maxCostMicros: child.maxCostMicros, costMicros: below.costMicros });
      continue;
    }
    added += below.costMicros;
    await appendAudit(tx, {
      organizationId: context.organizationId,
      ...actorOf(context),
      action: SETTLED_ACTION,
      targetRef: runRef(child.id),
      decision: 'allow',
    });
  }
  if (added === 0) return { costMicros: run.costMicros, liveChildren, holds };
  await tx
    .update(agentRuns)
    .set({
      costMicros: sql`${agentRuns.costMicros} + ${added}`,
      version: sql`${agentRuns.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));
  return { costMicros: run.costMicros + added, liveChildren, holds };
}

/**
 * Whether this run or anything above it has been told to stop or has ended. This reads PostgreSQL, so a stop
 * whose signal was lost still counts. A run it cannot find counts too, since it cannot say otherwise.
 */
async function stopFromRunUpward(tx: Tx, startRunId: string | null): Promise<boolean> {
  const seen = new Set<string>();
  for (let runId = startRunId; runId !== null;) {
    if (seen.has(runId)) return true;
    seen.add(runId);
    const [run] = await tx
      .select({ status: agentRuns.status, parentRunId: agentRuns.parentRunId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    if (!run || isTerminalAgentRun(run.status as AgentRunStatus)) return true;
    const [stop] = await tx
      .select({ id: runControls.id })
      .from(runControls)
      .where(and(eq(runControls.runId, runId), eq(runControls.kind, 'stop')))
      .limit(1);
    if (stop) return true;
    runId = run.parentRunId;
  }
  return false;
}

const toolsIn = (scopes: unknown): readonly string[] => {
  const tools = (scopes as { tools?: unknown } | null)?.tools;
  // Scopes it cannot read hold nothing, so everything asked for is refused.
  return Array.isArray(tools) && tools.every((tool) => typeof tool === 'string') ? tools : [];
};

const scopesOf = (scopes: unknown) =>
  typeof scopes === 'object' && scopes !== null ? (scopes as Record<string, unknown>) : {};

/** Writes the child Work Unit and queued run, with scopes the intersection of what was asked and held. */
export async function createChildRun(
  database: AppDatabase,
  context: AgentContext,
  raw: { parentRunId: string; stepNumber: number },
): Promise<ChildRunResult> {
  const { parentRunId, stepNumber } = parseOrRefuse(createInput, raw);
  // A service context would skip every Work Unit check (FD-3), and a run can only ever delegate for itself.
  if (!isAgentFor(context, parentRunId)) throw await refuseParent(database, context, parentRunId);
  const ids = childIdsFor(context, parentRunId, stepNumber);

  const found = await withTenantTx(database, context, async (tx) => {
    const [parent] = await tx
      .select({
        workUnitId: agentRuns.workUnitId,
        initiatorMembershipId: agentRuns.initiatorMembershipId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, parentRunId));
    if (!parent) return null;
    const [child] = await tx
      .select(childSelection)
      .from(agentRuns)
      .where(and(eq(agentRuns.id, ids.runId), eq(agentRuns.parentRunId, parentRunId)));
    return { parent, child };
  });
  // Row-level security hides another tenant's run, so that is what this finds for a cross-tenant parent.
  if (!found || found.parent.initiatorMembershipId !== context.membershipId) {
    throw await refuseParent(database, context, parentRunId);
  }
  // A retry after the child was made. The rules are not asked again, because that child now counts against
  // them, and the proposal it came from may already be purged.
  if (found.child) return created(found.child);

  const proposal = await loadProposal(database, context, { runId: parentRunId, stepNumber });
  if (
    !proposal ||
    proposal.runId !== parentRunId ||
    proposal.toolId !== DELEGATE_TOOL ||
    CLOSED_PROPOSALS.has(proposal.status)
  ) {
    return deny(database, context, parentRunId, 'DELEGATION_WIDENED', 'TOOL_NOT_GRANTED');
  }
  // The gateway parsed these once already. What matters is what reaches this write, so it is parsed here too.
  const args = agentDelegateArgsSchema.safeParse(proposal.args);
  if (!args.success) {
    return deny(database, context, parentRunId, 'DELEGATION_WIDENED', 'TOOL_ARGS_INVALID');
  }
  // A model wrote this title, and people read it on a Work Unit, so a secret must not travel that way.
  if (scanForSecrets([{ id: 'title', text: args.data.title }]).hits.length > 0) {
    return deny(database, context, parentRunId, 'DELEGATION_WIDENED', 'SECRET_FOUND_IN_PAYLOAD');
  }

  try {
    return await withTenantTx(database, context, async (tx): Promise<ChildRunResult> => {
      const refuse = (code: DelegationCode, reason?: string) =>
        denyInTx(tx, context, parentRunId, code, reason);

      // The initiator's own access, read now. They may have lost it since the run began.
      if (!can(context.role, 'work.create') || !can(context.role, 'agent.run')) {
        return refuse('DELEGATION_WIDENED', 'RESOURCE_NOT_PERMITTED');
      }
      const parentWork = await loadChangeable(tx, context, found.parent.workUnitId);

      // Everything from here is one decision: this lock is why two children cannot share the same headroom.
      const [parent] = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, parentRunId))
        .for('update');
      if (!parent) throw new AppError('NOT_FOUND');
      const [raced] = await tx
        .select(childSelection)
        .from(agentRuns)
        .where(and(eq(agentRuns.id, ids.runId), eq(agentRuns.parentRunId, parentRunId)));
      if (raced) return created(raced);

      if (!CAN_DELEGATE.has(parent.status)) {
        return refuse('DELEGATION_WIDENED', 'RUN_NOT_RUNNING');
      }
      if (isTerminal(parentWork.status as WorkState)) {
        return refuse('DELEGATION_WIDENED', 'WORK_STOPPED');
      }
      if (await stopFromRunUpward(tx, parent.id)) {
        return refuse('DELEGATION_WIDENED', 'STOPPED_BY_PERSON');
      }

      const halt = createHaltCheck();
      await halt.assertRunning(tx, context, { agentVersionId: parent.agentVersionId });

      const settlement = await settleFinishedChildren(tx, context, parent);

      // A version with no live publication has been withdrawn. Another tenant's is simply not found. Either
      // way this run may not start it, and the code does not say which.
      const now = new Date();
      const [version] = await tx
        .select({
          spec: agentVersions.spec,
          maxCostMicros: agentVersions.maxCostMicros,
          serviceIdentityId: agentDefinitions.serviceIdentityId,
        })
        .from(agentVersions)
        .innerJoin(
          agentDefinitions,
          and(
            eq(agentDefinitions.organizationId, agentVersions.organizationId),
            eq(agentDefinitions.id, agentVersions.definitionId),
          ),
        )
        .innerJoin(
          agentPublications,
          and(
            eq(agentPublications.organizationId, agentVersions.organizationId),
            eq(agentPublications.versionId, agentVersions.id),
            lte(agentPublications.activeFrom, now),
            or(isNull(agentPublications.activeUntil), gt(agentPublications.activeUntil, now)),
          ),
        )
        .where(eq(agentVersions.id, args.data.agent_version_id))
        .limit(1);
      if (!version) return refuse('DELEGATION_WIDENED', 'AGENT_VERSION_NOT_AVAILABLE');
      const spec = agentSpecV1Schema.safeParse(version.spec);
      if (!spec.success) return refuse('DELEGATION_WIDENED', 'AGENT_SPEC_INVALID');
      await halt.assertRunning(tx, context, { agentVersionId: args.data.agent_version_id });

      const [bundle] = await tx
        .select({ document: policyBundles.document })
        .from(policyBundles)
        .where(eq(policyBundles.active, true));

      const decision = decideDelegation({
        parent: {
          depth: parent.depth,
          tools: toolsIn(parent.delegatedScopes),
          classification: parent.effectiveClassification as AiClassification,
          limits: {
            maxModelTurns: parent.maxModelTurns,
            maxToolCalls: parent.maxToolCalls,
            maxTotalTokens: parent.maxTotalTokens,
            maxCostMicros: parent.maxCostMicros,
            timeoutSeconds: parent.timeoutSeconds,
            maxDelegationDepth: parent.maxDelegationDepth,
          },
          costMicros: settlement.costMicros,
          boundToProfile: parent.boundProfileId !== null && parent.boundProfileVersion !== null,
        },
        workClassification: parentWork.classification as AiClassification,
        liveChildren: settlement.liveChildren,
        childHolds: settlement.holds,
        org: readOrgDelegationLimits(bundle?.document ?? null),
        asked: { tools: args.data.tools, maxCostMicros: args.data.max_cost_micros },
        childManifest: {
          allow: spec.data.tools.allow,
          deny: spec.data.tools.deny ?? [],
          limits: {
            maxModelTurns: spec.data.execution.max_model_turns,
            maxToolCalls: spec.data.execution.max_tool_calls,
            maxTotalTokens: spec.data.execution.max_total_tokens,
            maxCostMicros: version.maxCostMicros,
            timeoutSeconds: spec.data.execution.timeout_seconds,
            maxDelegationDepth: spec.data.execution.max_delegation_depth,
          },
        },
      });
      if (decision.kind === 'denied') return refuse(decision.code, decision.reason);

      // The accountable owner stays who answers for it, and the initiator is on it as they would be on any
      // work they made, so their own access is what lets this child read it at a raised class.
      await tx.insert(workUnits).values({
        organizationId: context.organizationId,
        id: ids.workUnitId,
        projectId: parentWork.projectId,
        parentId: parentWork.id,
        ownerMembershipId: parentWork.ownerMembershipId,
        createdByMembershipId: context.membershipId,
        title: args.data.title,
        classification: decision.classification,
      });
      await tx.insert(workAssignments).values({
        organizationId: context.organizationId,
        workUnitId: ids.workUnitId,
        membershipId: context.membershipId,
        responsibility: 'contributor',
        actorType: 'human',
      });
      await emit(tx, context, {
        eventType: 'work.created',
        aggregateType: 'work_unit',
        aggregateId: ids.workUnitId,
        aggregateVersion: 1,
        classification: decision.classification,
        payload: { work_unit_id: ids.workUnitId },
      });
      // No agent_run.requested here. The parent's workflow starts this as a native child under the standard
      // ID, so a stop reaches it and the parent can wait for it. The dispatcher starting it as well would
      // win that race with a workflow nothing is waiting for (FD-16).
      await tx.insert(agentRuns).values({
        organizationId: context.organizationId,
        id: ids.runId,
        workUnitId: ids.workUnitId,
        agentVersionId: args.data.agent_version_id,
        parentRunId: parent.id,
        depth: parent.depth + 1,
        initiatorMembershipId: parent.initiatorMembershipId,
        serviceIdentityId: version.serviceIdentityId,
        effectiveClassification: decision.classification,
        maxModelTurns: decision.limits.maxModelTurns,
        maxToolCalls: decision.limits.maxToolCalls,
        maxTotalTokens: decision.limits.maxTotalTokens,
        maxCostMicros: decision.maxCostMicros,
        timeoutSeconds: decision.limits.timeoutSeconds,
        maxDelegationDepth: decision.limits.maxDelegationDepth,
        // Anything else a parent's scopes narrow stays narrowed. Only the tools are worked out here.
        delegatedScopes: { ...scopesOf(parent.delegatedScopes), tools: decision.tools },
      });
      // A run starts unbound by trigger, so this is a second write. Pinned to what the parent uses, the child
      // cannot route to a provider its parent could not, and a profile that no longer qualifies stops it (FD-13).
      await tx
        .update(agentRuns)
        .set({
          boundProfileId: parent.boundProfileId,
          boundProfileVersion: parent.boundProfileVersion,
        })
        .where(eq(agentRuns.id, ids.runId));
      await appendAudit(tx, {
        organizationId: context.organizationId,
        ...actorOf(context),
        action: 'work.created',
        targetRef: `work_unit:${ids.workUnitId}`,
        decision: 'allow',
      });
      await appendAudit(tx, {
        organizationId: context.organizationId,
        ...actorOf(context),
        action: CREATED_ACTION,
        targetRef: runRef(ids.runId),
        decision: 'allow',
      });
      return created({
        id: ids.runId,
        workUnitId: ids.workUnitId,
        maxCostMicros: decision.maxCostMicros,
      });
    });
  } catch (error) {
    // The trigger holds even if the decision above was wrong, or a parent ended a moment ago. Either way
    // nothing was written, and that it was refused still goes on the record.
    if (pgCode(error) === RUN_RULE_BROKEN) {
      return deny(database, context, parentRunId, 'DELEGATION_WIDENED', 'TRIGGER_REFUSED');
    }
    if (error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) {
      return deny(database, context, parentRunId, 'DELEGATION_WIDENED', 'RESOURCE_NOT_PERMITTED');
    }
    throw error;
  }
}

/**
 * Child finished: gives what it did not use back to the parent's reservation. Safe to repeat. While a child
 * is unsettled its whole limit is held against the parent. Settling adds what it really spent to the
 * parent's cost, which is what the parent's own limit check reads, and lets go of the rest. A child still
 * alive stays held, so calling this early changes nothing. Either side's context may call it.
 */
export async function settleChildRun(
  database: AppDatabase,
  context: AgentContext,
  raw: { parentRunId: string; childRunId: string },
): Promise<void> {
  const { parentRunId, childRunId } = parseOrRefuse(settleInput, raw);
  if (!isAgentFor(context, parentRunId) && !isAgentFor(context, childRunId)) {
    throw await refuseParent(database, context, parentRunId);
  }
  const known = await withTenantTx(database, context, async (tx) => {
    const [parent] = await tx
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, parentRunId))
      .for('update');
    if (!parent || parent.initiatorMembershipId !== context.membershipId) return false;
    const [child] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, childRunId), eq(agentRuns.parentRunId, parentRunId)));
    if (!child) return false;
    await settleFinishedChildren(tx, context, parent);
    return true;
  });
  if (!known) throw await refuseParent(database, context, parentRunId);
}

/**
 * Whether anything above this run has been stopped or has ended. A native child is cancelled with its parent,
 * and that takes a signal, so a run's check before each step asks PostgreSQL too. It reads nothing about the
 * run itself: that is the caller's own check.
 */
export function ancestorStopRequested(
  database: AppDatabase,
  context: AgentContext,
  raw: { runId: string },
): Promise<boolean> {
  const { runId } = parseOrRefuse(lookupInput, raw);
  return withTenantTx(database, context, async (tx) => {
    const [run] = await tx
      .select({ parentRunId: agentRuns.parentRunId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    if (!run) throw new AppError('NOT_FOUND');
    return stopFromRunUpward(tx, run.parentRunId);
  });
}

/**
 * What this run's cost counter holds that is not in its own ledger rows: its settled children's spending. So
 * a reconciliation can compare like with like: the counter against the ledger plus this.
 */
export function settledChildrenMicros(
  database: AppDatabase,
  context: AgentContext,
  raw: { runId: string },
): Promise<number> {
  const { runId } = parseOrRefuse(lookupInput, raw);
  return withTenantTx(database, context, async (tx) => {
    const children = await tx
      .select({
        id: agentRuns.id,
        costMicros: agentRuns.costMicros,
        createdAt: agentRuns.createdAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.parentRunId, runId));
    if (children.length === 0) return 0;
    const settled = await settledAmong(tx, children);
    return children
      .filter((child) => settled.has(runRef(child.id)))
      .reduce((sum, child) => sum + child.costMicros, 0);
  });
}
