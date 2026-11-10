// AGENT-12: actual M4 metadata, without provider calls or private transcript privileges.
import {
  agentRuns,
  artifactAclCatalog,
  artifactLineage,
  artifactWorkLinks,
  clientOnboardings,
  memberships,
  usageLedger,
} from '@ensemus/database';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { requestOnboardingAgentRunInTx } from '../ai/run-control';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { loadReadable } from '../work';
import type { AgentRuns } from './ports';

/** The SQL supplies up to two retained exact-run headers, not a filtered list of visible winners. */
export function assessOnboardingOutputs(outputs: readonly { id: string; readable: boolean }[]): {
  artifactState: 'none' | 'ready' | 'ambiguous' | 'unavailable';
  artifactIds: readonly string[];
} {
  if (outputs.length > 1) return { artifactState: 'ambiguous', artifactIds: [] };
  const only = outputs[0];
  if (!only) return { artifactState: 'none', artifactIds: [] };
  if (!only.readable) return { artifactState: 'unavailable', artifactIds: [] };
  return { artifactState: 'ready', artifactIds: [only.id] };
}

/** Each read remains in its supplied tenant transaction; no tenant-sensitive cache or fake default. */
export function createOnboardingAgentRuns(): AgentRuns {
  return {
    requestRun: requestOnboardingAgentRunInTx,
    async statusOf(tx, context, rawId) {
      if (context.actorType !== 'delegated') throw new AppError('FORBIDDEN');
      const id = idSchema.safeParse(rawId);
      if (!id.success) return null;
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.id, context.membershipId),
            eq(memberships.userId, context.userId),
            eq(memberships.status, 'active'),
          ),
        );
      if (!member) return null;
      const [bound] = await tx
        .select({ run: agentRuns })
        .from(clientOnboardings)
        .innerJoin(
          agentRuns,
          and(
            eq(agentRuns.organizationId, clientOnboardings.organizationId),
            eq(agentRuns.id, clientOnboardings.agentRunId),
            eq(agentRuns.workUnitId, clientOnboardings.briefWorkUnitId),
            eq(agentRuns.initiatorMembershipId, clientOnboardings.requestedByMembershipId),
          ),
        )
        .where(
          and(
            eq(clientOnboardings.requestedByMembershipId, context.membershipId),
            eq(agentRuns.id, id.data),
            isNull(agentRuns.parentRunId),
          ),
        )
        .limit(1);
      if (!bound) return null;
      try {
        await loadReadable(tx, { ...context, role: member.role }, bound.run.workUnitId);
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
        throw error;
      }
      // Signed ledger entries include corrections. A tool-only zero row does not establish measured
      // model cost. A measured zero-cost model call is still a real measurement, rather than a guess.
      const [ledger] = await tx
        .select({
          measured: sql<number>`count(*) filter(where ${usageLedger.meter} in ('model_input_tokens','model_output_tokens'))::integer`,
          total: sql<string>`coalesce(sum(${usageLedger.costMicros}),0)::text`,
        })
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.runId, bound.run.id),
            eq(usageLedger.workUnitId, bound.run.workUnitId),
          ),
        );
      const total = ledger ? Number(ledger.total) : NaN;
      const costMicros =
        ledger && ledger.measured > 0 && Number.isSafeInteger(total) && total >= 0 ? total : null;
      const readable = and(
        eq(artifactLineage.workUnitId, bound.run.workUnitId),
        eq(artifactLineage.viewerMembershipId, bound.run.initiatorMembershipId),
        eq(artifactLineage.state, 'bound'),
        eq(artifactLineage.writeState, 'settled'),
        eq(artifactLineage.inventoryComplete, true),
        eq(artifactLineage.structuredInventoryComplete, true),
        eq(artifactLineage.restoreReapplyPending, false),
        isNull(artifactLineage.physicalPurgedAt),
        eq(artifactAclCatalog.sha256, artifactLineage.artifactSha256),
        eq(artifactAclCatalog.provenanceState, 'bound'),
        eq(artifactAclCatalog.alive, true),
        sql`exists(select 1 from ${artifactWorkLinks} where ${artifactWorkLinks.organizationId}=${artifactLineage.organizationId}
          and ${artifactWorkLinks.artifactId}=${artifactLineage.artifactId} and ${artifactWorkLinks.workUnitId}=${bound.run.workUnitId}::uuid)`,
        sql`knowledge.artifact_readable(${artifactLineage.artifactId},${context.membershipId}::uuid)`,
      );
      const outputs = await tx
        .select({
          id: artifactLineage.artifactId,
          readable: sql<boolean>`coalesce(${readable},false)`,
        })
        .from(artifactLineage)
        .leftJoin(
          artifactAclCatalog,
          and(
            eq(artifactAclCatalog.organizationId, artifactLineage.organizationId),
            eq(artifactAclCatalog.artifactId, artifactLineage.artifactId),
          ),
        )
        .where(
          and(
            eq(artifactLineage.executionKind, 'agent_run'),
            eq(artifactLineage.executionId, bound.run.id),
            eq(artifactLineage.workUnitId, bound.run.workUnitId),
            eq(artifactLineage.viewerMembershipId, bound.run.initiatorMembershipId),
            // Mutable bound/blocked state cannot prove a header was never a published output.
            // Until a final-output authority exists, even abandoned/blocked attempts retain ambiguity.
          ),
        )
        // Two are enough to refuse ambiguity. Readability is a value, never a candidate WHERE filter.
        .orderBy(asc(artifactLineage.artifactId))
        .limit(2);
      return {
        status: bound.run.status,
        costMicros,
        workUnitId: bound.run.workUnitId,
        initiatorMembershipId: bound.run.initiatorMembershipId,
        ...assessOnboardingOutputs(outputs),
      };
    },
  };
}
