// Real M4/M5 metadata and effect adapters. Neither model transport nor credentials live here.
import {
  agentPublications,
  agentRuns,
  agentVersions,
  knowledgeSources,
  memberships,
  modelProfiles,
  rateCards,
  usageLedger,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { AGENT_RUN_STATUSES, STOP_CODES } from '@ensemus/domain/ai';
import { TOOL_MANIFESTS } from '@ensemus/domain/ai-tools';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { loadReadable } from '../work';
import { databaseInTransaction } from '../transaction-database';
import {
  getAgentPublicationPolicy,
  getAgentPolicyVersion,
  listAgentVersions,
  pinAgentVersion,
  publishAgentVersion,
} from '../ai/agents';
import {
  controlAgentRun,
  mayControlRun,
  requestProcessAgentRun,
  requestProcessAgentStop,
} from '../ai/run-control';
import { getRunTimeline, loadReadableRun } from '../ai/timeline';
import type { DelegatedRun, ProductPorts } from './ports';

const LIVE = new Set([
  'queued',
  'preparing',
  'running',
  'paused',
  'waiting_for_approval',
  'waiting_for_child',
  'verifying',
]);
const KNOWN_STOPS: ReadonlySet<string> = new Set(STOP_CODES);
const LABELS: ReadonlyMap<string, string> = new Map([
  ['prepare', 'PREPARING'],
  ['model_turn', 'THINKING'],
  ['tool_call', 'USING_TOOL'],
  ['approval_wait', 'WAITING_FOR_APPROVAL'],
  ['delegation', 'DELEGATING'],
  ['verification', 'CHECKING_RESULT'],
]);

/** Saved roles, a service actor, and another member's context cannot become display authority. */
async function viewer(tx: Tx, context: TenantContext, delegated = false): Promise<TenantContext> {
  if (context.actorType !== 'user' && !(delegated && context.actorType === 'delegated'))
    throw new AppError('FORBIDDEN');
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.id, context.membershipId),
        eq(memberships.userId, context.userId),
        eq(memberships.status, 'active'),
      ),
    )
    .for('share');
  if (!member) throw new AppError('FORBIDDEN');
  return { ...context, role: member.role };
}

// Existing services keep their own authorization while sharing this actual transaction.
const inTx = databaseInTransaction;

async function measuredCost(tx: Tx, condition: SQL) {
  const [row] = await tx
    .select({
      total: sql<string>`coalesce(sum(${usageLedger.costMicros}),0)::text`,
      modelRows: sql<number>`count(*) filter(where ${usageLedger.meter} in ('model_input_tokens','model_output_tokens'))::integer`,
      pricedRows: sql<number>`count(*) filter(where ${usageLedger.meter} in ('model_input_tokens','model_output_tokens') and ${rateCards.id} is not null)::integer`,
      estimated: sql<number>`count(*) filter(where ${usageLedger.meter} in ('model_input_tokens','model_output_tokens')
      and (${usageLedger.status}='estimated' or ${usageLedger.commercialMode}<>'cloud' or ${rateCards.source} is distinct from 'ensemus_card'))::integer`,
    })
    .from(usageLedger)
    .leftJoin(
      rateCards,
      and(
        eq(rateCards.organizationId, usageLedger.organizationId),
        eq(rateCards.id, usageLedger.rateCardId),
      ),
    )
    .where(condition);
  if (!row || row.modelRows === 0 || row.pricedRows !== row.modelRows) return null;
  const costMicros = Number(row.total);
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new AppError('INVALID_STATE');
  return { costMicros, isEstimate: row.estimated > 0 };
}

function identifier(value: string) {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new AppError('NOT_FOUND');
  return parsed.data.toLowerCase();
}

function cursorOf(value: string | undefined) {
  if (value === undefined) return null;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new AppError('INVALID_INPUT');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      new Date(parsed[0]).toISOString() !== parsed[0]
    )
      throw new Error('INVALID_CURSOR');
    return { at: parsed[0], id: identifier(parsed[1]) };
  } catch {
    throw new AppError('INVALID_INPUT');
  }
}

async function delegatedRun(tx: Tx, context: TenantContext, rawId: string): Promise<DelegatedRun> {
  const id = identifier(rawId);
  const { run } = await loadReadableRun(tx, context, id);
  const timeline = await getRunTimeline(inTx(tx), context, run.workUnitId, { runId: id });
  const selected = timeline.selected;
  if (!selected || selected.view.id !== id) throw new AppError('NOT_FOUND');
  const cost = await measuredCost(tx, eq(usageLedger.runId, id));
  return {
    id,
    workUnitId: run.workUnitId,
    workTitle: timeline.work.title,
    agentName: selected.agentName,
    status: run.status,
    stopCode: run.stopCode && KNOWN_STOPS.has(run.stopCode) ? run.stopCode : null,
    turnsUsed: run.modelTurns,
    toolCallsUsed: run.toolCalls,
    costMicros: cost?.costMicros ?? null,
    costIsEstimate: cost?.isEstimate ?? true,
    startedAt: run.createdAt,
    finishedAt: run.endedAt,
    canStop: LIVE.has(run.status) && mayControlRun(context, run, 'stop'),
    // Only fixed labels from the runtime kind leave this adapter; arbitrary database codes cannot.
    steps: timeline.steps.map((step) => ({
      labelCode: LABELS.get(step.kind) ?? 'CHECKING_RESULT',
      state: step.state,
      at: new Date(step.started_at),
    })),
  };
}

export function createRuntimeProductPorts(database: AppDatabase): ProductPorts {
  return {
    agentRegistry: {
      async publishInTransaction(tx, context, input) {
        const joined = inTx(tx);
        const version = await publishAgentVersion(joined, context, {
          ...input,
          policyVersion: await getAgentPolicyVersion(joined, context),
        });
        return {
          definitionId: version.definition_id,
          versionId: version.id,
          versionNumber: version.version_number,
          specSha256: version.spec_sha256,
        };
      },
      async publish(context, input) {
        const version = await publishAgentVersion(database, context, {
          ...input,
          policyVersion: await getAgentPolicyVersion(database, context),
        });
        return {
          definitionId: version.definition_id,
          versionId: version.id,
          versionNumber: version.version_number,
          specSha256: version.spec_sha256,
        };
      },
      list: (context) =>
        withTenantTx(database, context, async (tx) => {
          const actor = await viewer(tx, context);
          return (await listAgentVersions(inTx(tx), actor)).map((version) => ({
            definitionId: version.definition_id,
            versionId: version.id,
            versionNumber: version.version_number,
            specSha256: version.spec_sha256,
            publishedAt: new Date(version.published_at),
          }));
        }),
      pin: (context, input) => pinAgentVersion(database, context, input.versionId),
      async orgLimits(context) {
        const { limits, policyVersion } = await getAgentPublicationPolicy(database, context);
        return {
          maxTurns: limits.maxModelTurns,
          maxToolCalls: limits.maxToolCalls,
          timeoutSeconds: limits.timeoutSeconds,
          policyVersion,
        };
      },
    },
    toolCatalog: {
      list: (context) =>
        withTenantTx(database, context, async (tx) => {
          await viewer(tx, context);
          return TOOL_MANIFESTS.map((tool) => ({ ...tool }));
        }),
    },
    agentRuns: {
      listMine: (context, input) =>
        withTenantTx(database, context, async (tx) => {
          const actor = await viewer(tx, context),
            after = cursorOf(input.after);
          const limit = input.limit ?? 25;
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 50 ||
            (input.status !== undefined &&
              !(AGENT_RUN_STATUSES as readonly string[]).includes(input.status))
          )
            throw new AppError('INVALID_INPUT');
          const rows = await tx
            .select({
              id: agentRuns.id,
              at: sql<Date>`date_trunc('milliseconds',${agentRuns.createdAt})`,
            })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.initiatorMembershipId, actor.membershipId),
                sql`knowledge.can_read_work(${agentRuns.workUnitId},${actor.membershipId}::uuid)`,
                input.status === undefined ? undefined : eq(agentRuns.status, input.status),
                after
                  ? sql`(date_trunc('milliseconds',${agentRuns.createdAt}),${agentRuns.id})<(${after.at}::timestamptz,${after.id}::uuid)`
                  : undefined,
              ),
            )
            .orderBy(
              desc(sql`date_trunc('milliseconds',${agentRuns.createdAt})`),
              desc(agentRuns.id),
            )
            .limit(limit + 1);
          const page = rows.slice(0, limit),
            items: DelegatedRun[] = [];
          for (const row of page) items.push(await delegatedRun(tx, actor, row.id));
          const last = page.at(-1);
          return {
            items,
            next:
              rows.length > limit && last
                ? Buffer.from(JSON.stringify([last.at.toISOString(), last.id])).toString(
                    'base64url',
                  )
                : null,
          };
        }),
      get: (context, id) =>
        withTenantTx(database, context, async (tx) =>
          delegatedRun(tx, await viewer(tx, context), id),
        ),
      requestStop: (context, id) =>
        context.actorType === 'delegated'
          ? requestProcessAgentStop(database, context, id)
          : withTenantTx(database, context, async (tx) =>
              controlAgentRun(inTx(tx), await viewer(tx, context), {
                agentRunId: id,
                kind: 'stop',
              }),
            ),
      latestVersionOf: (context, definitionId) =>
        withTenantTx(database, context, async (tx) => {
          await viewer(tx, context, true);
          const rows = await tx
            .select({ id: agentVersions.id })
            .from(agentPublications)
            .innerJoin(
              agentVersions,
              and(
                eq(agentVersions.organizationId, agentPublications.organizationId),
                eq(agentVersions.id, agentPublications.versionId),
              ),
            )
            .where(
              and(
                eq(agentPublications.definitionId, identifier(definitionId)),
                sql`${agentPublications.activeFrom}<=now() and (${agentPublications.activeUntil} is null or ${agentPublications.activeUntil}>now())`,
              ),
            )
            .limit(2);
          if (rows.length > 1) throw new AppError('INVALID_STATE');
          return rows[0]?.id ?? null;
        }),
      start: (context, input) => requestProcessAgentRun(database, context, input),
      listForWorkUnit: (context, workId) =>
        withTenantTx(database, context, async (tx) => {
          const actor = await viewer(tx, context, true),
            id = identifier(workId);
          await loadReadable(tx, actor, id);
          return tx
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.workUnitId, id),
                eq(agentRuns.initiatorMembershipId, actor.membershipId),
              ),
            )
            .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
            .limit(50);
        }),
      outcome: (context, id) =>
        withTenantTx(database, context, async (tx) => {
          const actor = await viewer(tx, context, true),
            { run } = await loadReadableRun(tx, actor, identifier(id));
          if (LIVE.has(run.status)) return 'running';
          if (run.status === 'completed') return 'completed';
          if (run.status === 'cancelled') return 'stopped';
          if (['failed', 'budget_exhausted', 'policy_denied', 'timed_out'].includes(run.status))
            return 'failed';
          return 'unknown';
        }),
    },
    modelReadiness: {
      summary: (context) =>
        withTenantTx(database, context, async (tx) => {
          await viewer(tx, context);
          const [counts] = await tx
            .select({
              activeProfiles: sql<number>`count(*) filter(where ${modelProfiles.status}='active')::integer`,
              draftProfiles: sql<number>`count(*) filter(where ${modelProfiles.status}='draft')::integer`,
            })
            .from(modelProfiles);
          if (!counts) throw new AppError('INVALID_STATE');
          return counts;
        }),
    },
    usage: {
      costForWorkUnit: (context, workId) =>
        withTenantTx(database, context, async (tx) => {
          const actor = await viewer(tx, context, true),
            id = identifier(workId);
          await loadReadable(tx, actor, id);
          return measuredCost(tx, eq(usageLedger.workUnitId, id));
        }),
    },
    knowledge: {
      summary: (context) =>
        withTenantTx(database, context, async (tx) => {
          const actor = await viewer(tx, context);
          const [counts] = await tx
            .select({ sources: sql<number>`count(*)::integer` })
            .from(knowledgeSources)
            .where(
              and(
                eq(knowledgeSources.state, 'active'),
                sql`${knowledgeSources.id} in(select knowledge.readable_source_ids(${actor.membershipId}::uuid))`,
              ),
            );
          if (!counts) throw new AppError('INVALID_STATE');
          return counts;
        }),
    },
  };
}
