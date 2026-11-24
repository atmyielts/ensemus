// The connector worker's half of a suite read (ADR-038 D6, "D6 in detail"). The agent gateway has checked
// the rule and written a request in its gate transaction. This reloads that request by ID, checks the
// whole rule again under a lock before the read and again before keeping its output, and writes the output
// for the agent role to collect. Only codes come out of here: a provider's words stay in the row.
//
// Runs under the worker's service context. Migration 0563 lets that context, and the agent role, alone see
// a request, and lets only it answer one, once.
import {
  agentRuns,
  connections,
  externalResources,
  memberships,
  suiteReads,
  toolProposals,
  withTenantTx,
  workUnits,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import {
  AGENT_RUN_STATUSES,
  CLASSIFICATIONS,
  isTerminalAgentRun,
  strongestClassification,
  type AiClassification,
} from '@ensemus/domain/ai';
import { toolManifest, type ConnectionRule } from '@ensemus/domain/ai-tools';
import { decideConnectionUse } from '@ensemus/policy';
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { createHaltCheck } from './ai/halt';
import { AppError } from './errors';
import { canonicalId } from './ids';
import { lockConnectionFacts, permittedResources, resourceFacts } from './suite-connections';

/** The most any suite read may keep, whatever its manifest says: the table's own limit. */
export const MAX_SUITE_READ_BYTES = 1_048_576;

/** Everything the worker needs to do one read. Held in memory only, for the length of that read. */
export type PreparedSuiteRead = {
  proposalId: string;
  runId: string;
  toolId: string;
  toolVersion: string;
  /** A model's arguments, parsed by the tool's schema. Data for the connector, never instructions. */
  args: unknown;
  initiatorMembershipId: string;
  ownerKind: 'organization' | 'member';
  /** Each result must be checked against the initiator's source ACL (a search on the organization's). */
  checkEachResult: boolean;
  resourceAccess: 'read' | 'write' | null;
  maxOutputBytes: number;
  connection: {
    id: string;
    connectorType: string;
    config: unknown;
    credentialSecretId: string | null;
    grantedScopes: readonly string[];
  };
};

export type SuiteReadClaim =
  | { kind: 'read'; read: PreparedSuiteRead }
  /** Refused now, with this code written on the request. */
  | { kind: 'refused'; code: string }
  /** Already answered, collected, or not this run's. Nothing to do. */
  | { kind: 'gone' };

/** What the connector answered, as the worker hands it over. */
export type SuiteReadOutput = {
  bytes: Buffer;
  mediaType: string;
  classification: AiClassification;
  resourceExternalIds: readonly string[];
};

const LIVE_RUN: readonly string[] = ['running'];
const MEDIA_TYPES: readonly string[] = ['application/json', 'text/plain'];

type RequestRow = {
  proposalId: string;
  runId: string;
  connectionId: string;
  toolId: string;
  toolVersion: string;
  args: unknown;
  resourceExternalId: string | null;
  status: string;
};

async function lockRequest(tx: Tx, proposalId: string): Promise<RequestRow | null> {
  const [row] = await tx
    .select({
      proposalId: suiteReads.proposalId,
      runId: suiteReads.runId,
      connectionId: suiteReads.connectionId,
      toolId: suiteReads.toolId,
      toolVersion: suiteReads.toolVersion,
      args: suiteReads.args,
      resourceExternalId: suiteReads.resourceExternalId,
      status: suiteReads.status,
    })
    .from(suiteReads)
    .where(eq(suiteReads.proposalId, proposalId))
    .for('update');
  return row ?? null;
}

type Recheck =
  { ok: true; read: PreparedSuiteRead; dataClass: AiClassification } | { ok: false; code: string };

/**
 * ADR-038 D5 and D6's rule, read again now: the run is still running for an active initiator with no
 * switch engaged, the proposal is still this read, and the connection rule still passes. Under the
 * request's lock, with the connection share-locked, so revoking it waits for this or is seen by it.
 */
async function recheck(tx: Tx, context: TenantContext, row: RequestRow): Promise<Recheck> {
  const manifest = toolManifest(row.toolId);
  if (
    !manifest?.connection ||
    manifest.class !== 'read_only' ||
    manifest.version !== row.toolVersion
  ) {
    return { ok: false, code: 'TOOL_UNKNOWN' };
  }
  const rule: ConnectionRule = manifest.connection;
  const [run] = await tx
    .select({
      status: agentRuns.status,
      initiatorMembershipId: agentRuns.initiatorMembershipId,
      agentVersionId: agentRuns.agentVersionId,
      workUnitId: agentRuns.workUnitId,
      effectiveClassification: agentRuns.effectiveClassification,
    })
    .from(agentRuns)
    // Not locked: the agent's gate holds the run while it collects, and a lock here, taken after the
    // request's, would order the two the other way round. A run stopped meanwhile never collects this.
    .where(eq(agentRuns.id, row.runId));
  if (!run || !LIVE_RUN.includes(run.status)) return { ok: false, code: 'RUN_NOT_RUNNING' };
  const [initiator] = await tx
    .select({ status: memberships.status })
    .from(memberships)
    .where(eq(memberships.id, run.initiatorMembershipId));
  if (initiator?.status !== 'active') return { ok: false, code: 'INITIATOR_INACTIVE' };
  const [proposal] = await tx
    .select({
      status: toolProposals.status,
      runId: toolProposals.runId,
      toolId: toolProposals.toolId,
      externalActionId: toolProposals.externalActionId,
    })
    .from(toolProposals)
    .where(eq(toolProposals.id, row.proposalId));
  if (
    proposal?.status !== 'running' ||
    proposal.runId !== row.runId ||
    proposal.toolId !== row.toolId ||
    proposal.externalActionId !== null
  ) {
    return { ok: false, code: 'SUITE_READ_STALE' };
  }
  try {
    await createHaltCheck().assertRunning(tx, context, { agentVersionId: run.agentVersionId });
  } catch {
    // FD-15: switches that cannot be read count as engaged.
    return { ok: false, code: 'HALTED' };
  }
  const [work] = await tx
    .select({ classification: workUnits.classification })
    .from(workUnits)
    .where(eq(workUnits.id, run.workUnitId));
  const dataClass = strongestClassification(
    run.effectiveClassification as AiClassification,
    (work?.classification ?? 'restricted') as AiClassification,
  );

  const facts = await lockConnectionFacts(tx, row.connectionId);
  const resource =
    facts && facts.ownerMembershipId === null
      ? await resourceFacts(tx, {
          connectionId: row.connectionId,
          membershipId: run.initiatorMembershipId,
          externalId: row.resourceExternalId,
        })
      : null;
  const decision = decideConnectionUse({
    rule,
    toolClass: manifest.class,
    initiatorMembershipId: run.initiatorMembershipId,
    dataClass,
    connection: facts,
    resource,
  });
  if (!decision.ok) return { ok: false, code: decision.auditAs };

  const [connection] = await tx
    .select({
      config: connections.config,
      credentialSecretId: connections.credentialSecretId,
    })
    .from(connections)
    .where(eq(connections.id, row.connectionId));
  if (!connection || !facts) return { ok: false, code: 'CONNECTION_NOT_FOUND' };
  return {
    ok: true,
    dataClass,
    read: {
      proposalId: row.proposalId,
      runId: row.runId,
      toolId: row.toolId,
      toolVersion: row.toolVersion,
      args: row.args,
      initiatorMembershipId: run.initiatorMembershipId,
      ownerKind: decision.ownerKind,
      checkEachResult: decision.checkEachResult,
      resourceAccess: rule.resourceAccess,
      maxOutputBytes: Math.min(rule.maxOutputBytes, MAX_SUITE_READ_BYTES),
      connection: {
        id: facts.id,
        connectorType: facts.connectorType,
        config: connection.config,
        credentialSecretId: connection.credentialSecretId,
        grantedScopes: facts.grantedScopes,
      },
    },
  };
}

function refuseRow(tx: Tx, proposalId: string, code: string) {
  return tx
    .update(suiteReads)
    .set({ status: 'refused', resultCode: codeOf(code), updatedAt: new Date() })
    .where(and(eq(suiteReads.proposalId, proposalId), eq(suiteReads.status, 'requested')));
}

/** A code that fits the row's check, whatever was handed in. */
const codeOf = (code: string) =>
  /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'SUITE_READ_REFUSED';

const assertService = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};

/** Before the read: reloads the request by ID and checks everything again. */
export function claimSuiteRead(
  database: AppDatabase,
  context: TenantContext,
  input: { runId: string; proposalId: string },
): Promise<SuiteReadClaim> {
  assertService(context);
  return withTenantTx(database, context, async (tx) => {
    const row = await lockRequest(tx, canonicalId(input.proposalId));
    if (!row || row.runId !== canonicalId(input.runId) || row.status !== 'requested') {
      return { kind: 'gone' };
    }
    const checked = await recheck(tx, context, row);
    if (!checked.ok) {
      await refuseRow(tx, row.proposalId, checked.code);
      return { kind: 'refused', code: codeOf(checked.code) };
    }
    return { kind: 'read', read: checked.read };
  });
}

/**
 * Every class this tenant's syncs have given these resources, through any connection of this connector
 * type. A file has one ID at its provider whichever account reaches it: a Google Drive file ID is global,
 * and a Microsoft drive item is keyed by its drive and ID together. So a member's own connection, which
 * syncs nothing, still finds the class the organization's sync gave the same file, and reading it through
 * one's own account cannot launder it to that account's default. A copy the sync has since lost sight of
 * still counts, because losing sight of a file does not make it any less sensitive.
 */
export async function sourceClassesInTenant(
  tx: Tx,
  input: { connectorType: string; externalIds: readonly string[] },
): Promise<AiClassification[]> {
  const ids = [...new Set(input.externalIds)].slice(0, 1000);
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ classification: externalResources.classification })
    .from(externalResources)
    .innerJoin(
      connections,
      and(
        eq(connections.organizationId, externalResources.organizationId),
        eq(connections.id, externalResources.connectionId),
      ),
    )
    .where(
      and(
        eq(connections.connectorType, input.connectorType),
        inArray(externalResources.externalId, ids),
      ),
    );
  // A class the table does not know is read as the strongest, never skipped.
  return rows.map((row) =>
    (CLASSIFICATIONS as readonly string[]).includes(row.classification)
      ? (row.classification as AiClassification)
      : 'restricted',
  );
}

/**
 * The class a suite read's output is kept at: the strongest of what the handler started it at, the run's,
 * and every class any copy of its resources carries here. Never weaker than any of them.
 */
export function suiteOutputClass(input: {
  handlerClass: AiClassification;
  runClass: AiClassification;
  sourceClasses: readonly AiClassification[];
}): AiClassification {
  return input.sourceClasses.reduce<AiClassification>(
    (strongest, each) => strongestClassification(strongest, each),
    strongestClassification(input.handlerClass, input.runClass),
  );
}

/**
 * After the read: checks everything again, then that the output fits and that every resource it holds
 * from the organization's content is the initiator's to have, and keeps it at the strongest class of the
 * source, its resources and the run. A refusal keeps nothing.
 */
export function finishSuiteRead(
  database: AppDatabase,
  context: TenantContext,
  input: { runId: string; proposalId: string; output: SuiteReadOutput },
): Promise<'read' | 'refused' | 'gone'> {
  assertService(context);
  return withTenantTx(database, context, async (tx) => {
    const row = await lockRequest(tx, canonicalId(input.proposalId));
    if (!row || row.runId !== canonicalId(input.runId) || row.status !== 'requested') return 'gone';
    const checked = await recheck(tx, context, row);
    if (!checked.ok) {
      await refuseRow(tx, row.proposalId, checked.code);
      return 'refused';
    }
    const { read } = checked;
    const { output } = input;
    if (output.bytes.length > read.maxOutputBytes) {
      await refuseRow(tx, row.proposalId, 'TOOL_OUTPUT_TOO_LARGE');
      return 'refused';
    }
    if (!MEDIA_TYPES.includes(output.mediaType)) {
      await refuseRow(tx, row.proposalId, 'SUITE_READ_NOT_TEXT');
      return 'refused';
    }
    if (read.ownerKind === 'organization' && read.resourceAccess !== null) {
      const ids = [...new Set(output.resourceExternalIds)];
      // A search must say what it found, and a named resource must be the one it was asked for.
      if (read.checkEachResult || ids.length > 0) {
        const permitted = await permittedResources(tx, {
          connectionId: read.connection.id,
          membershipId: read.initiatorMembershipId,
          externalIds: ids,
          needed: read.resourceAccess,
        });
        if (ids.length > 1000 || !ids.every((id) => permitted.has(id))) {
          await refuseRow(tx, row.proposalId, 'SOURCE_ACL_DENIED');
          return 'refused';
        }
      }
    }
    // A restricted copy anywhere here makes the output restricted, and so the run: the agent's own read
    // ceiling then refuses it when it is collected, and nothing restricted leaves by a draft, a send or
    // a model outside this deployment's own.
    const named = row.resourceExternalId ? [row.resourceExternalId] : [];
    const classification = suiteOutputClass({
      handlerClass: output.classification,
      runClass: checked.dataClass,
      sourceClasses: await sourceClassesInTenant(tx, {
        connectorType: read.connection.connectorType,
        externalIds: [...output.resourceExternalIds, ...named],
      }),
    });
    await tx
      .update(suiteReads)
      .set({
        status: 'read',
        output: output.bytes,
        outputMediaType: output.mediaType,
        outputClassification: classification,
        updatedAt: new Date(),
      })
      .where(eq(suiteReads.proposalId, row.proposalId));
    return 'read';
  });
}

/** The read failed for good. The code is written on the request; the provider's words go nowhere. */
export function refuseSuiteRead(
  database: AppDatabase,
  context: TenantContext,
  input: { runId: string; proposalId: string; code: string },
): Promise<void> {
  assertService(context);
  return withTenantTx(database, context, async (tx) => {
    const row = await lockRequest(tx, canonicalId(input.proposalId));
    if (!row || row.runId !== canonicalId(input.runId) || row.status !== 'requested') return;
    await refuseRow(tx, row.proposalId, input.code);
  });
}

/** For a search on the organization's content: which results the initiator may have, read now. */
export function permittedSuiteResources(
  database: AppDatabase,
  context: TenantContext,
  input: {
    connectionId: string;
    membershipId: string;
    externalIds: readonly string[];
    needed: 'read' | 'write';
  },
): Promise<ReadonlySet<string>> {
  assertService(context);
  return withTenantTx(database, context, (tx) => permittedResources(tx, input));
}

// --- Reads nobody will collect (ADR-038 D6). A read is collected while its run is live, in seconds. One
// whose run has ended, or that is older than an hour, never will be, and its output is provider content
// with nowhere to go, so the suite upkeep deletes it. Migration 0564 lets only the worker's service
// context delete, and only rows this same rule allows.

/** How long an uncollected suite read is kept, whatever its run is doing. */
export const SUITE_READ_KEEP_MS = 3_600_000;

/** The run statuses that end a run. 0564's policy names the same list, and a unit test holds them equal. */
export const ENDED_RUN_STATUSES: readonly string[] = AGENT_RUN_STATUSES.filter(isTerminalAgentRun);

/** The most rows one sweep deletes. The next sweep takes the rest. */
const SWEEP_BATCH = 1000;

/**
 * Whether a suite read will never be collected: older than SUITE_READ_KEEP_MS, or its run has ended or
 * cannot be found. A run in any status not known to have ended counts as live.
 */
export function suiteReadIsSpent(
  read: { createdAt: Date; runStatus: string | null },
  now: Date,
): boolean {
  if (now.getTime() - read.createdAt.getTime() > SUITE_READ_KEEP_MS) return true;
  return read.runStatus === null || ENDED_RUN_STATUSES.includes(read.runStatus);
}

/** Deletes this tenant's spent suite reads, at most SWEEP_BATCH, and answers how many. */
export function sweepSuiteReads(
  database: AppDatabase,
  context: TenantContext,
  now: Date = new Date(),
): Promise<number> {
  assertService(context);
  return withTenantTx(database, context, async (tx) => {
    const candidates = await tx
      .select({
        proposalId: suiteReads.proposalId,
        createdAt: suiteReads.createdAt,
        runStatus: agentRuns.status,
      })
      .from(suiteReads)
      .leftJoin(agentRuns, eq(agentRuns.id, suiteReads.runId))
      .where(
        or(
          lt(suiteReads.createdAt, new Date(now.getTime() - SUITE_READ_KEEP_MS)),
          isNull(agentRuns.id),
          inArray(agentRuns.status, [...ENDED_RUN_STATUSES]),
        ),
      )
      .orderBy(asc(suiteReads.createdAt))
      .limit(SWEEP_BATCH);
    const spent = candidates
      .filter((read) => suiteReadIsSpent(read, now))
      .map((read) => read.proposalId);
    if (spent.length === 0) return 0;
    // 0564's policy checks each row again by the database's own clock, so nothing live is deleted.
    const deleted = await tx
      .delete(suiteReads)
      .where(inArray(suiteReads.proposalId, spent))
      .returning({ proposalId: suiteReads.proposalId });
    return deleted.length;
  });
}
