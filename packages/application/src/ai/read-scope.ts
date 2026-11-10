// Immutable manifest grants narrow the initiator's fresh ACL; they never replace it. This module
// reads no Work, file, source or private transcript body and never synthesizes read observations.
import { agentSpecV1Schema } from '@ensemus/contracts/ai';
import {
  agentRuns,
  agentVersions,
  withTenantTx,
  type AgentContext,
  type AppDatabase,
  type Tx,
} from '@ensemus/database';
import { CLASSIFICATIONS, type AiClassification } from '@ensemus/domain/ai';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { currentRunCompanyClassInTx } from './input-class';
import { bindAgentAuthorityProtocolInTx } from './read-authority';

export type AgentReadScope = { sourceIds: readonly string[]; ceiling: AiClassification | null };
/** Studio/simulation semantics: highest explicitly declared class includes the lower classes. Legacy
 * manifests without data scopes retain M4 ABAC. There is no implied tenant-wide Knowledge grant. */
export function parseAgentReadScope(scopes: readonly string[]): AgentReadScope {
  if (scopes.length > 1000) throw new AppError('POLICY_DENIED');
  let ceiling: AiClassification | null = null;
  const sourceIds = new Set<string>();
  for (const scope of scopes) {
    const category = scope.trim().toLowerCase();
    if (category === 'data' || category.startsWith('data.')) {
      const match = /^data\.(public|internal|confidential|restricted)\.read$/.exec(scope);
      if (!match) throw new AppError('POLICY_DENIED');
      const classification = match[1] as AiClassification;
      if (
        ceiling === null ||
        CLASSIFICATIONS.indexOf(classification) > CLASSIFICATIONS.indexOf(ceiling)
      )
        ceiling = classification;
    } else if (category === 'knowledge' || category.startsWith('knowledge.')) {
      const match = /^knowledge\.([0-9a-fA-F-]{36})\.read$/.exec(scope);
      const parsed = idSchema.safeParse(match?.[1]);
      if (!parsed.success) throw new AppError('POLICY_DENIED');
      sourceIds.add(parsed.data);
    }
  }
  if (sourceIds.size > 200) throw new AppError('POLICY_DENIED');
  return { sourceIds: [...sourceIds].sort(), ceiling };
}
export function assertWithinAgentCeiling(scope: AgentReadScope, classification: AiClassification) {
  if (
    !CLASSIFICATIONS.includes(classification) ||
    (scope.ceiling !== null &&
      CLASSIFICATIONS.indexOf(classification) > CLASSIFICATIONS.indexOf(scope.ceiling))
  )
    throw new AppError('POLICY_DENIED');
}
/** A manifest/policy-containing prompt or derived response has at least internal protection. This
 * does not authorize internal company material under a public ceiling: actual inputs need the
 * separate exhaustive current + historical company-material proof first. */
export function assertWithinAgentProtection(
  scope: AgentReadScope,
  classification: AiClassification,
) {
  const ceiling = scope.ceiling === 'public' ? 'internal' : scope.ceiling;
  assertWithinAgentCeiling({ ...scope, ceiling }, classification);
}
export function intersectAgentReadScopes(
  child: AgentReadScope,
  parent: AgentReadScope,
): AgentReadScope {
  const ceiling =
    child.ceiling === null
      ? parent.ceiling
      : parent.ceiling === null
        ? child.ceiling
        : CLASSIFICATIONS.indexOf(child.ceiling) <= CLASSIFICATIONS.indexOf(parent.ceiling)
          ? child.ceiling
          : parent.ceiling;
  return { ceiling, sourceIds: child.sourceIds.filter((id) => parent.sourceIds.includes(id)) };
}
export async function loadAgentReadScopeInTx(
  tx: Tx,
  context: AgentContext,
  expected?: { workUnitId: string; agentVersionId: string },
  options: { lockRun?: boolean } = {},
) {
  if (context.actorType !== 'agent') throw new AppError('FORBIDDEN');
  // Clear first: failure after an earlier admission must not leave success authority behind.
  await tx.execute(sql`select set_config('app.agent_scope_protocol','',true)`);
  const preflight = await tx.execute<{ admitted: boolean }>(
    sql`select ai.run_scope_preflight(${context.agentRunId}::uuid) admitted`,
  );
  if (!preflight.rows[0]?.admitted) throw new AppError('POLICY_DENIED');
  let runId: string | null = context.agentRunId,
    scope: AgentReadScope | null = null;
  const seen = new Set<string>();
  let previousDepth: number | null = null;
  // M4's published max_delegation_depth is bounded at five: root plus at most five ancestors.
  while (runId !== null) {
    if (seen.has(runId) || seen.size >= 6) throw new AppError('POLICY_DENIED');
    seen.add(runId);
    const [row] = await tx
      .select({
        spec: agentVersions.spec,
        workUnitId: agentRuns.workUnitId,
        agentVersionId: agentRuns.agentVersionId,
        parentRunId: agentRuns.parentRunId,
        depth: agentRuns.depth,
      })
      .from(agentRuns)
      .innerJoin(
        agentVersions,
        and(
          eq(agentVersions.organizationId, agentRuns.organizationId),
          eq(agentVersions.id, agentRuns.agentVersionId),
        ),
      )
      .where(
        and(eq(agentRuns.id, runId), eq(agentRuns.initiatorMembershipId, context.membershipId)),
      );
    if (
      !row ||
      (seen.size === 1 &&
        expected &&
        (row.workUnitId !== expected.workUnitId || row.agentVersionId !== expected.agentVersionId))
    )
      throw new AppError('NOT_FOUND');
    if (
      row.depth < 0 ||
      row.depth > 5 ||
      (previousDepth !== null && row.depth !== previousDepth - 1) ||
      (row.parentRunId === null && row.depth !== 0)
    )
      throw new AppError('POLICY_DENIED');
    const parsed = agentSpecV1Schema.safeParse(row.spec);
    if (!parsed.success) throw new AppError('POLICY_DENIED');
    const current = parseAgentReadScope(parsed.data.context.allowed_scopes);
    scope = scope === null ? current : intersectAgentReadScopes(scope, current);
    previousDepth = row.depth;
    runId = row.parentRunId;
  }
  if (scope === null) throw new AppError('NOT_FOUND');
  // SQL preflight requires the actual 0419 birth receipt for every child (and preserves the old
  // unproven inventory fence). Ancestor scope intersection never creates read observations.
  // Ordinary reads do not take the run UPDATE lock before acquiring their new body locks. Content
  // recording takes it after those locks; dispatch/result publication requests the serialized proof.
  const company = await currentRunCompanyClassInTx(tx, context, options);
  assertWithinAgentCeiling(scope, company.classification);
  if (company.knowledgeSourceIds.some((id) => !scope.sourceIds.includes(id)))
    throw new AppError('POLICY_DENIED');
  await tx.execute(
    sql`select set_config('app.agent_scope_protocol',${`scoped-v1:${context.agentRunId}`},true)`,
  );
  await bindAgentAuthorityProtocolInTx(tx, context);
  const admitted = await tx.execute<{ admitted: boolean }>(
    sql`select ai.run_input_admitted(${context.agentRunId}::uuid) admitted`,
  );
  if (!admitted.rows[0]?.admitted) throw new AppError('POLICY_DENIED');
  return {
    ...scope,
    companyClassification: company.classification,
    inputCount: company.inputCount,
    hasTargetWork: company.hasTargetWork,
  };
}
export function loadAgentReadScope(
  database: AppDatabase,
  context: AgentContext,
  expected?: { workUnitId: string; agentVersionId: string },
) {
  return withTenantTx(database, context, (tx) => loadAgentReadScopeInTx(tx, context, expected));
}
