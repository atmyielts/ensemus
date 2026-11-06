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
      const outputs = await tx
        .select({ id: artifactLineage.artifactId })
        .from(artifactLineage)
        .innerJoin(
          artifactAclCatalog,
          and(
            eq(artifactAclCatalog.organizationId, artifactLineage.organizationId),
            eq(artifactAclCatalog.artifactId, artifactLineage.artifactId),
            eq(artifactAclCatalog.sha256, artifactLineage.artifactSha256),
          ),
        )
        .innerJoin(
          artifactWorkLinks,
          and(
            eq(artifactWorkLinks.organizationId, artifactLineage.organizationId),
            eq(artifactWorkLinks.artifactId, artifactLineage.artifactId),
            eq(artifactWorkLinks.workUnitId, bound.run.workUnitId),
          ),
        )
        .where(
          and(
            eq(artifactLineage.executionKind, 'agent_run'),
            eq(artifactLineage.executionId, bound.run.id),
            eq(artifactLineage.workUnitId, bound.run.workUnitId),
            eq(artifactLineage.viewerMembershipId, bound.run.initiatorMembershipId),
            eq(artifactLineage.state, 'bound'),
            eq(artifactLineage.writeState, 'settled'),
            eq(artifactLineage.inventoryComplete, true),
            eq(artifactLineage.structuredInventoryComplete, true),
            eq(artifactLineage.restoreReapplyPending, false),
            isNull(artifactLineage.physicalPurgedAt),
            eq(artifactAclCatalog.provenanceState, 'bound'),
            eq(artifactAclCatalog.alive, true),
            sql`knowledge.artifact_readable(${artifactLineage.artifactId},${context.membershipId}::uuid)`,
          ),
        )
        // The flagship accepts exactly one output; two are enough to report an ambiguity honestly.
        .orderBy(asc(artifactLineage.artifactId))
        .limit(2);
      return {
        status: bound.run.status,
        costMicros,
        workUnitId: bound.run.workUnitId,
        initiatorMembershipId: bound.run.initiatorMembershipId,
        artifactIds: outputs.map((output) => output.id),
      };
    },
  };
}
