// Actual sharing-ledger and hypothetical policy readers. No provider, key, socket or body ports.
import {
  agentDefinitions,
  agentVersions,
  egressDecisions,
  serviceIdentities,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  AGENT_RUN_STATUSES,
  AGENT_TURN_PURPOSE,
  CLASSIFICATIONS,
  isTerminalAgentRun,
} from '@ensemus/domain/ai';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { decideEgress, type TenantPolicyBundle } from '@ensemus/policy';
import type { EgressPolicyPort } from '@ensemus/knowledge/ports';
import type { AgentWorkloads, RunEgressDecisions } from './ports';
import { loadTenantPolicyBundle } from '../ai/egress-log';
import { AppError } from '../errors';

export function createRunEgressDecisions(): RunEgressDecisions {
  return {
    async list(tx, { before, limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new AppError('INVALID_INPUT');
      const occurredAt = sql<Date>`date_trunc('milliseconds',${egressDecisions.createdAt})`.mapWith(
        egressDecisions.createdAt,
      );
      const rows = await tx
        .select({
          id: egressDecisions.id,
          occurredAt,
          purpose: egressDecisions.purpose,
          dataClass: egressDecisions.dataClass,
          modelProfileRef: egressDecisions.profileId,
          destinationHost: egressDecisions.destinationHost,
          decision: egressDecisions.decision,
          reasonCode: egressDecisions.reasonCode,
          policyVersion: egressDecisions.policyVersion,
          requestSha256: egressDecisions.requestHash,
          runId: egressDecisions.runId,
        })
        .from(egressDecisions)
        .where(
          and(
            isNotNull(egressDecisions.runId),
            before
              ? sql`(date_trunc('milliseconds',${egressDecisions.createdAt}),${egressDecisions.id})<(${before.occurredAt}::timestamptz,${before.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(sql`${occurredAt} desc`, sql`${egressDecisions.id} desc`)
        .limit(limit);
      // Historic rows lack provider kind. Today's mutable profile cannot establish its old value.
      return rows.map((row) => ({
        ...row,
        source: 'agent_run' as const,
        providerKind: null,
        decision: row.decision as 'allow' | 'deny',
      }));
    },
  };
}

export function createAgentWorkloads(): AgentWorkloads {
  const live = AGENT_RUN_STATUSES.filter((status) => !isTerminalAgentRun(status));
  return {
    async list(tx) {
      const rows = await tx
        .select({ version: agentVersions.versionNumber, slug: agentDefinitions.slug })
        .from(agentVersions)
        .innerJoin(
          agentDefinitions,
          and(
            eq(agentDefinitions.organizationId, agentVersions.organizationId),
            eq(agentDefinitions.id, agentVersions.definitionId),
          ),
        )
        .where(
          sql`exists(select 1 from ai.agent_runs r where r.organization_id=${agentVersions.organizationId}
          and r.agent_version_id=${agentVersions.id} and r.status in (${sql.join(
            live.map((status) => sql`${status}`),
            sql`,`,
          )}))
        or exists(select 1 from ai.agent_publications p join ${serviceIdentities} i
          on i.organization_id=p.organization_id and i.id=${agentDefinitions.serviceIdentityId}
          where p.organization_id=${agentVersions.organizationId} and p.version_id=${agentVersions.id}
          and p.active_from<=now() and (p.active_until is null or p.active_until>now())
          and i.status='active' and (i.expires_at is null or i.expires_at>now()))`,
        )
        .orderBy(agentDefinitions.slug, agentVersions.versionNumber)
        .limit(1001);
      if (rows.length > 1000) throw new AppError('INVALID_STATE');
      // Agent manifests have no Work classification ceiling. Compare every possible class, with the
      // shared policy deciding each, instead of reading private Work bodies to invent a ceiling.
      return rows.map((row) => ({
        key: `${row.slug}/v${row.version}`,
        kind: 'agent' as const,
        purpose: AGENT_TURN_PURPOSE,
        classes: CLASSIFICATIONS,
      }));
    },
  };
}

export function createEgressSimulationPolicy(options: {
  organizationId: string;
  bundle: TenantPolicyBundle | null;
}): EgressPolicyPort {
  return {
    evaluate(input) {
      if (input.organizationId !== options.organizationId)
        return { allow: false, reasonCode: 'UNKNOWN_INPUT', policyVersion: 'simulation' };
      const { proposal } = input;
      const decision = decideEgress({
        dataClass: input.classification,
        purpose: input.purpose,
        requiredRegion: null,
        bundle: options.bundle,
        now: new Date(),
        profile: {
          id: 'hypothetical-provider',
          version: 1,
          active: true,
          destination: proposal.destination,
          destinationHost: proposal.destinationHost,
          billingOwner: proposal.billingOwner,
          region: proposal.region,
          allowedClasses: proposal.allowedClasses,
          allowedPurposes: proposal.purposes,
          retentionBasis: proposal.retentionBasis,
          contractRef: proposal.contractRef,
        },
      });
      return {
        allow: decision.decision === 'allow',
        reasonCode: decision.reasonCode,
        policyVersion: decision.policyVersion,
      };
    },
  };
}

export async function createKnowledgeReadPorts(database: AppDatabase, context: TenantContext) {
  const bundle = await loadTenantPolicyBundle(database, context);
  return {
    coverage: 'complete' as const,
    runDecisions: createRunEgressDecisions(),
    agentWorkloads: createAgentWorkloads(),
    policy: createEgressSimulationPolicy({ organizationId: context.organizationId, bundle }),
  };
}
