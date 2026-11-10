// Read-only Pulse metadata, separately composed from the assistant control/publishing ports.
import { agentRuns, memberships, workUnits, type TenantContext, type Tx } from '@ensemus/database';
import { processRuns } from '@ensemus/database/product';
import type { PulseFacts } from '@ensemus/domain/pulse';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { visibleTo } from '../work';

export const PULSE_METADATA_LIMIT = 200;
export type PulseMetadataPage<Row> = { items: readonly Row[]; hasMore: boolean };
type ReadInput = { workIds: readonly string[]; limit: number; recordId?: string };
export interface PulseMetadataReaders {
  stoppedAgentRuns(
    tx: Tx,
    context: TenantContext,
    input: ReadInput,
  ): Promise<PulseMetadataPage<PulseFacts['agentRuns'][number]>>;
  failedProcessRuns(
    tx: Tx,
    context: TenantContext,
    input: ReadInput,
  ): Promise<PulseMetadataPage<PulseFacts['processRuns'][number]>>;
}

function person(context: TenantContext) {
  if (context.actorType !== 'user') throw new AppError('FORBIDDEN');
}
function limitOf(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError('INVALID_INPUT');
  return Math.min(value, PULSE_METADATA_LIMIT);
}
const viewer = (context: TenantContext) => sql`exists(select 1 from ${memberships}
  where ${memberships.id}=${context.membershipId}::uuid and ${memberships.userId}=${context.userId}::uuid
    and ${memberships.status}='active')`;

/** Real joined SQL; no unavailable/empty default and no private payload table privileges. */
export function createPulseMetadataReaders(): PulseMetadataReaders {
  return {
    async stoppedAgentRuns(tx, context, input) {
      person(context);
      const limit = limitOf(input.limit);
      if (!input.workIds.length) return { items: [], hasMore: false };
      const rows = await tx
        .select({
          id: agentRuns.id,
          workUnitId: agentRuns.workUnitId,
          stopCode: sql<string>`coalesce(${agentRuns.stopCode},'AGENT_RUN_STOPPED')`,
          at: sql<Date>`coalesce(${agentRuns.endedAt},${agentRuns.updatedAt})`.mapWith(
            agentRuns.updatedAt,
          ),
        })
        .from(agentRuns)
        .innerJoin(
          workUnits,
          and(
            eq(workUnits.organizationId, agentRuns.organizationId),
            eq(workUnits.id, agentRuns.workUnitId),
          ),
        )
        .where(
          and(
            viewer(context),
            visibleTo(context),
            sql`knowledge.can_read_work(${workUnits.id},${context.membershipId}::uuid)`,
            inArray(workUnits.id, [...input.workIds]),
            input.recordId ? eq(agentRuns.id, input.recordId) : undefined,
            inArray(agentRuns.status, [
              'failed',
              'cancelled',
              'budget_exhausted',
              'policy_denied',
              'timed_out',
              'outcome_unverified',
            ]),
          ),
        )
        .orderBy(desc(agentRuns.updatedAt), agentRuns.id)
        .limit(limit + 1);
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },
    async failedProcessRuns(tx, context, input) {
      person(context);
      const limit = limitOf(input.limit);
      if (!input.workIds.length) return { items: [], hasMore: false };
      const rows = await tx
        .select({
          id: processRuns.id,
          rootWorkUnitId: processRuns.rootWorkUnitId,
          stopCode: processRuns.stopCode,
          at: sql<Date>`coalesce(${processRuns.finishedAt},${processRuns.updatedAt})`.mapWith(
            processRuns.updatedAt,
          ),
        })
        .from(processRuns)
        .innerJoin(
          workUnits,
          and(
            eq(workUnits.organizationId, processRuns.organizationId),
            eq(workUnits.id, processRuns.rootWorkUnitId),
          ),
        )
        .where(
          and(
            viewer(context),
            visibleTo(context),
            sql`knowledge.can_read_work(${workUnits.id},${context.membershipId}::uuid)`,
            inArray(workUnits.id, [...input.workIds]),
            eq(processRuns.status, 'failed'),
            input.recordId ? eq(processRuns.id, input.recordId) : undefined,
          ),
        )
        .orderBy(desc(processRuns.updatedAt), processRuns.id)
        .limit(limit + 1);
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    },
  };
}
