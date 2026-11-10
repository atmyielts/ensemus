// Owned by the egress slice (AGENT-10, AGENT-11). See docs/06-delivery/m5-slices.md and ADR-029 D9. The
// machine-readable ledger, and the simulator that shows what a proposed provider would get. Needs
// `egress.view`, and both hold codes and IDs, and never company text.
import {
  knowledgeModelCalls,
  knowledgeSources,
  memberships,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { SimulationRow } from '@ensemus/knowledge/egress-simulation';
import type { EgressPolicyPort, EgressProposal } from '@ensemus/knowledge/ports';
import type { AgentWorkloads, EgressLedgerRow, RunEgressDecisions } from './ports';
import { simulateEgress } from '@ensemus/knowledge/egress-simulation';
import { can, type Classification } from '@ensemus/domain/policy';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { idSchema } from '../ids';
import { requireSearchPerson } from './retrieval';
export {
  createKnowledgeReadPorts,
  createRunEgressDecisions,
  createAgentWorkloads,
  createEgressSimulationPolicy,
} from './read-ports';

export type EgressLedgerPage = { items: readonly EgressLedgerRow[]; next: string | null };

/** Newest first, across `knowledge.model_calls` and M4's run decisions, with a stable cursor. */
export async function listEgressLedger(
  database: AppDatabase,
  context: TenantContext,
  deps: { runDecisions: RunEgressDecisions },
  input: { after?: string; limit?: number },
): Promise<EgressLedgerPage> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT');
  let before: { occurredAt: Date; id: string } | null = null;
  if (input.after) {
    try {
      if (input.after.length > 512) throw new Error('INVALID_CURSOR');
      const raw = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')) as {
        at: string;
        id: string;
      };
      const occurredAt = new Date(raw.at),
        key = idSchema.safeParse(raw.id);
      if (
        !key.success ||
        !Number.isFinite(occurredAt.getTime()) ||
        occurredAt.toISOString() !== raw.at
      )
        throw new Error('INVALID_CURSOR');
      before = { occurredAt, id: key.data };
    } catch {
      throw new AppError('INVALID_INPUT');
    }
  }
  return withTenantTx(database, context, async (tx) => {
    await manager(tx, context);
    // Shared with RunEgressDecisions: order and filter on date_trunc('milliseconds', occurred_at),
    // then UUID. A JS Date cannot hold PostgreSQL microseconds. This is a display cursor, not a log LSN.
    const rows = await tx
      .select({
        id: knowledgeModelCalls.id,
        occurredAt: sql<Date>`date_trunc('milliseconds',${knowledgeModelCalls.occurredAt})`.mapWith(
          knowledgeModelCalls.occurredAt,
        ),
        purpose: knowledgeModelCalls.purpose,
        dataClass: knowledgeModelCalls.dataClass,
        modelProfileRef: knowledgeModelCalls.modelProfileRef,
        providerKind: knowledgeModelCalls.providerKind,
        destinationHost: knowledgeModelCalls.destinationHost,
        decision: knowledgeModelCalls.decision,
        reasonCode: knowledgeModelCalls.reasonCode,
        policyVersion: knowledgeModelCalls.policyVersion,
        requestSha256: knowledgeModelCalls.requestSha256,
      })
      .from(knowledgeModelCalls)
      .where(
        before
          ? sql`(date_trunc('milliseconds',${knowledgeModelCalls.occurredAt}),${knowledgeModelCalls.id})<(${before.occurredAt}::timestamptz,${before.id}::uuid)`
          : undefined,
      )
      .orderBy(
        sql`date_trunc('milliseconds',${knowledgeModelCalls.occurredAt}) desc`,
        sql`${knowledgeModelCalls.id} desc`,
      )
      .limit(limit + 1);
    const agent = await deps.runDecisions.list(tx, { before, limit: limit + 1 });
    const knowledge: EgressLedgerRow[] = rows.map((row) => ({
      ...row,
      decision: row.decision as 'allow' | 'deny',
      source: 'knowledge',
      runId: null,
    }));
    const merged = [...knowledge, ...agent].sort(
      (a, b) =>
        b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0),
    );
    const items = merged.slice(0, limit),
      last = items.at(-1);
    return {
      items,
      next:
        merged.length > limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.occurredAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  });
}

/**
 * Lists every workload that would send data, per class, and whether policy would let it reach this
 * proposal. Transmits nothing, opens no socket and unseals nothing. Knowledge's own workloads (embedding,
 * reranking, answers) are read from the classes this tenant's sources actually hold.
 */
export async function simulateProvider(
  database: AppDatabase,
  context: TenantContext,
  deps: { policy: EgressPolicyPort; agentWorkloads: AgentWorkloads },
  input: { proposal: EgressProposal },
): Promise<readonly SimulationRow[]> {
  return withTenantTx(database, context, async (tx) => {
    await manager(tx, context);
    const sources = await tx
      .selectDistinct({ classification: knowledgeSources.classification })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.state, 'active'));
    const classes = sources.map((row) => row.classification as Classification);
    const workloads = await deps.agentWorkloads.list(tx);
    return simulateEgress(
      {
        organizationId: context.organizationId,
        proposal: input.proposal,
        workloads: [
          ...(['embed', 'rerank', 'answer'] as const).map((purpose) => ({
            key: `knowledge-${purpose}`,
            kind: 'knowledge' as const,
            purpose,
            classes,
          })),
          ...workloads,
        ],
      },
      deps.policy,
    );
  });
}

async function manager(tx: Tx, context: TenantContext) {
  await requireSearchPerson(tx, context);
  const [member] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.id, context.membershipId), eq(memberships.status, 'active')));
  if (!member || !can(member.role, 'egress.view')) throw new AppError('FORBIDDEN');
}
