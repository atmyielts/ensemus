// The three restore contributors M4 and M5 own (ADR-026, ADR-030 D11), bound to the runtimes that own
// that state. Each recovers through the same functions those runtimes already run, and each reports only
// what it did. What it cannot settle is never counted as settled: the contributor wrapper reads the
// metadata again afterwards, and anything left there is attention. Nothing here reaches a provider or
// starts a workflow; an event it writes waits in the outbox until the workers are let back.
import { sql } from 'drizzle-orm';
import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import { AGENT_RUN_STATUSES, isTerminalAgentRun } from '@ensemus/domain/ai';
import { KNOWLEDGE_DOCUMENT_RECEIVED } from '@ensemus/domain/knowledge-events';
import type { ObjectStore } from '../artifacts';
import { createRunTranscriptPurge } from '../ai/input-ledger';
import { closeRunWithoutContext, closeStrandedRun } from '../ai/runs';
import { AppError, pgCode } from '../errors';
import { recoverUnannouncedDocuments } from '../knowledge/ingest';
import { closeOrphanedConnectorSources } from '../knowledge/purge';
import { queryRows } from '../portability-sql';
import type { RestoreRecoveryBindings } from '../restore-contributors';
import type { RestoreTranscriptProof, RunProbe } from '../sovereign-ports';

const PAGE = 100;
/** One tenant's sources can be many, and each close is its own row. A bound keeps one pass finite. */
const MAX_SOURCE_PAGES = 50;

const LIVE = AGENT_RUN_STATUSES.filter((status) => !isTerminalAgentRun(status));
const TERMINAL = AGENT_RUN_STATUSES.filter((status) => isTerminalAgentRun(status));
const statusList = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`,`,
  );

const requireService = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};

export type RuntimeRestoreDeps = {
  /**
   * The agent worker's own login (`ensemus_agent`). Only it may fence a run's inputs, purge a transcript
   * or release a run's holds (0214, 0515). Without it neither M4 contributor is bound, and each reports
   * the attention a missing binding always reports.
   */
  agentDatabase?: AppDatabase;
  /** Whether a run's workflow is open. `unknown` is never taken to mean closed. */
  probeRun?: RunProbe;
  /** The store composed with `withRawKnowledgeObjects`, as the knowledge worker composes it. */
  knowledgeStore?: ObjectStore;
};

/**
 * The existing runtime functions each contributor recovers through. Tests replace them; production uses
 * `RUNTIME_RECOVERY`, and nothing else is offered.
 */
export type RecoveryOperations = {
  closeStranded: typeof closeStrandedRun;
  closeWithoutContext: typeof closeRunWithoutContext;
  fenceAndPurge(
    agentDatabase: AppDatabase,
    context: TenantContext,
    runIds: readonly string[],
  ): Promise<{ removed: number; remaining: number }>;
  recoverDocuments: typeof recoverUnannouncedDocuments;
  closeOrphans: typeof closeOrphanedConnectorSources;
};

export const RUNTIME_RECOVERY: RecoveryOperations = {
  closeStranded: closeStrandedRun,
  closeWithoutContext: closeRunWithoutContext,
  fenceAndPurge(agentDatabase, context, runIds) {
    const purge = createRunTranscriptPurge();
    return withTenantTx(agentDatabase, context, async (tx) => {
      if (!purge.fenceUsing) throw new AppError('PREREQUISITES_INCOMPLETE');
      const { fenced } = await purge.fenceUsing(tx, context, { runIds: [...runIds] });
      if (!fenced) throw new AppError('INVALID_STATE');
      const result = await purge.purgeUsing(tx, context, { runIds: [...runIds] });
      // An adapter that cannot say what is left proves nothing, so it counts as all of it left.
      return { removed: result.removed, remaining: result.remaining ?? runIds.length };
    });
  },
  recoverDocuments: recoverUnannouncedDocuments,
  closeOrphans: closeOrphanedConnectorSources,
};

type RunRow = {
  id: string;
  workUnitId: string;
  temporalRunId: string | null;
  status: string;
};

/**
 * m4-runs-and-budgets. A live run whose workflow Temporal says is closed is closed as STRANDED, with the
 * upkeep's own `closeStrandedRun`, and every ended run still holding budget is closed again through the
 * agent role's `closeRunWithoutContext`. That releases each hold that cannot have reached a provider and
 * keeps each that may have, so uncertain spend stays held and the metadata reports it. An open run is left
 * alone, and an unknown answer changes nothing: both stay live, and live runs are attention.
 */
function runsAndBudgets(agentDatabase: AppDatabase, probeRun: RunProbe, ops: RecoveryOperations) {
  return {
    async reconcile(database: AppDatabase, context: TenantContext) {
      requireService(context);
      const { organizationId } = context;
      let checked = 0,
        changed = 0,
        needsAttention = 0;
      let after: string | null = null;
      for (;;) {
        const cursor: string | null = after;
        const page: RunRow[] = await withTenantTx(database, context, (tx) =>
          queryRows<RunRow>(
            tx,
            sql`select id::text as id, work_unit_id::text as "workUnitId", temporal_run_id as "temporalRunId", status
              from ai.agent_runs where organization_id=${organizationId}::uuid and status in (${statusList(LIVE)})
              ${cursor ? sql`and id>${cursor}::uuid` : sql``} order by id limit ${PAGE}`,
          ),
        );
        for (const run of page) {
          checked += 1;
          if (!run.temporalRunId) continue;
          let state: Awaited<ReturnType<RunProbe>>;
          try {
            state = await probeRun({
              organizationId,
              workUnitId: run.workUnitId,
              runId: run.temporalRunId,
            });
          } catch {
            state = 'unknown';
          }
          if (state !== 'closed') continue;
          try {
            await ops.closeStranded(database, context, {
              workUnitId: run.workUnitId,
              temporalRunId: run.temporalRunId,
            });
            await ops.closeWithoutContext(agentDatabase, {
              organizationId,
              agentRunId: run.id,
              status: 'failed',
              stopCode: 'STRANDED',
            });
            changed += 1;
          } catch {
            needsAttention += 1;
          }
        }
        const last = page.at(-1);
        if (page.length < PAGE || !last) break;
        after = last.id;
      }
      // Ended runs that still hold budget, including those just closed above.
      const holding = await withTenantTx(database, context, (tx) =>
        queryRows<{ id: string; held: number }>(
          tx,
          sql`select r.id::text as id, count(b.*)::int as held from ai.agent_runs r
            join platform.budget_reservations b on b.organization_id=r.organization_id and b.run_id=r.id and b.status='held'
            where r.organization_id=${organizationId}::uuid and r.status in (${statusList(TERMINAL)})
            group by r.id order by r.id`,
        ),
      );
      for (const run of holding) {
        try {
          await ops.closeWithoutContext(agentDatabase, {
            organizationId,
            agentRunId: run.id,
            status: 'failed',
            stopCode: 'STRANDED',
          });
        } catch {
          needsAttention += 1;
        }
      }
      const [left] = holding.length
        ? await withTenantTx(database, context, (tx) =>
            queryRows<{ held: number }>(
              tx,
              sql`select count(*)::int as held from platform.budget_reservations
                where organization_id=${organizationId}::uuid and status='held'
                and run_id in (${sql.join(
                  holding.map((run) => sql`${run.id}::uuid`),
                  sql`,`,
                )})`,
            ),
          )
        : [{ held: 0 }];
      const before = holding.reduce((sum, run) => sum + run.held, 0);
      changed += Math.max(0, before - (left?.held ?? before));
      return { checked: checked + holding.length, changed, needsAttention };
    },
  };
}

const isHeldMaterial = (error: unknown) =>
  pgCode(error) === 'EN119' &&
  (error as { cause?: { message?: unknown } }).cause?.message ===
    'MATERIAL_DELETE_HOLD_UNCONFIRMED';

/**
 * m4-private-transcripts. On the agent role, the only one 0214 and 0515 let do it, every ended run with a
 * checkpoint is fenced at generation 1 and its payloads purged with `createRunTranscriptPurge`, the native
 * purge every other transcript erasure uses. A legal hold refuses a purge and keeps the transcript, as it
 * must; that run counts as remaining. The proof's remaining count is then read from the private rows
 * themselves, never from metadata.
 */
function privateTranscripts(agentDatabase: AppDatabase, ops: RecoveryOperations) {
  const fenceAndPurge = (context: TenantContext, runIds: readonly string[]) =>
    ops.fenceAndPurge(agentDatabase, context, runIds);
  return {
    async reconcile(_database: AppDatabase, context: TenantContext) {
      requireService(context);
      const { organizationId } = context;
      let checkedRuns = 0,
        changed = 0,
        held = 0,
        needsAttention = 0;
      let after: string | null = null;
      for (;;) {
        const cursor: string | null = after;
        type TranscriptRow = {
          id: string;
          status: string;
          checkpoint: boolean;
          certified: boolean;
        };
        const page: TranscriptRow[] = await withTenantTx(agentDatabase, context, (tx) =>
          queryRows<TranscriptRow>(
            tx,
            sql`select r.id::text as id, r.status, (c.run_id is not null) as checkpoint,
              coalesce(c.fenced_at is not null and c.fence_generation=1 and c.payloads_purged_at is not null
                and c.purged_fence_generation=c.fence_generation, false) as certified
              from ai.agent_runs r left join ai.run_input_checkpoints c on c.organization_id=r.organization_id and c.run_id=r.id
              where r.organization_id=${organizationId}::uuid ${cursor ? sql`and r.id>${cursor}::uuid` : sql``}
              order by r.id limit ${PAGE}`,
          ),
        );
        checkedRuns += page.length;
        // A missing checkpoint has nothing to fence. The metadata reports it as missing.
        const due = page
          .filter(
            (run) =>
              run.checkpoint &&
              !run.certified &&
              (TERMINAL as readonly string[]).includes(run.status),
          )
          .map((run) => run.id);
        if (due.length) {
          try {
            changed += (await fenceAndPurge(context, due)).removed;
          } catch (error) {
            if (!isHeldMaterial(error)) throw error;
            // One held run refuses the whole batch. Run them one at a time, so only it stays.
            for (const runId of due) {
              try {
                changed += (await fenceAndPurge(context, [runId])).removed;
              } catch (single) {
                if (!isHeldMaterial(single)) throw single;
                held += 1;
                needsAttention += 1;
              }
            }
          }
        }
        const last = page.at(-1);
        if (page.length < PAGE || !last) break;
        after = last.id;
      }
      const [facts] = await withTenantTx(agentDatabase, context, (tx) =>
        queryRows<{ certified: number; remaining: number }>(
          tx,
          sql`select (select count(*)::int from ai.run_input_checkpoints c where c.organization_id=${organizationId}::uuid
              and c.fenced_at is not null and c.fence_generation=1 and c.payloads_purged_at is not null
              and c.purged_fence_generation=c.fence_generation) as certified,
            (select count(*)::int from ai.step_payloads p join ai.execution_steps s on s.organization_id=p.organization_id and s.id=p.step_id
              join ai.agent_runs r on r.organization_id=s.organization_id and r.id=s.run_id
              where p.organization_id=${organizationId}::uuid and r.status in (${statusList(TERMINAL)})) as remaining`,
        ),
      );
      if (!facts) throw new Error('RESTORE_TRANSCRIPT_PROOF_UNAVAILABLE');
      const transcriptProof: RestoreTranscriptProof = {
        protocol: 'ai.run_inputs/v1',
        fenceGeneration: 1,
        checkedRuns,
        certifiedRuns: Math.min(facts.certified, checkedRuns),
        // A held run's payloads are still there, and the count above already includes them.
        remainingPayloads: Math.max(facts.remaining, held),
      };
      return { checked: checkedRuns, changed, needsAttention, transcriptProof };
    },
  };
}

/**
 * m5-sources-and-indexes. The knowledge sweep's own recovery, run once with no worker up: every active
 * object writer is settled or erased on the store's native proof (`recoverObjectWrites`), an upload whose
 * announcement was lost is announced again, so its ingest is queued and its chunks and embeddings are
 * built afresh, or failed if its bytes are gone, and a connector source whose connection or resource has
 * gone is closed (`closeOrphanedConnectorSources`), which queues its purge. Search filters by the source's
 * grants inside every query (ADR-029 D2), so no stored ACL needs rewriting. A purge still running, a
 * searchable document with no chunks, or a closed source still active stays in the metadata as attention.
 */
function sourcesAndIndexes(knowledgeStore: ObjectStore, ops: RecoveryOperations) {
  const pending = (database: AppDatabase, context: TenantContext) =>
    withTenantTx(database, context, async (tx) => {
      const [row] = await queryRows<{ writers: number; received: number }>(
        tx,
        sql`select (select count(*)::int from knowledge.object_writers where organization_id=${context.organizationId}::uuid and state='active') as writers,
          (select count(*)::int from knowledge.documents d where d.organization_id=${context.organizationId}::uuid and d.state='received'
            and not exists(select 1 from platform.domain_events e where e.organization_id=d.organization_id and e.aggregate_id=d.id
              and e.event_type=${KNOWLEDGE_DOCUMENT_RECEIVED})) as received`,
      );
      if (!row) throw new Error('RESTORE_METADATA_UNAVAILABLE');
      return row.writers + row.received;
    });
  return {
    async reconcile(database: AppDatabase, context: TenantContext) {
      requireService(context);
      const before = await pending(database, context);
      let needsAttention = 0;
      try {
        await ops.recoverDocuments(database, knowledgeStore, context);
      } catch {
        needsAttention += 1;
      }
      let closed = 0;
      for (let pageNumber = 0; pageNumber < MAX_SOURCE_PAGES; pageNumber++) {
        const result = await ops.closeOrphans(database, context, { limit: PAGE });
        closed += result.closed;
        if (result.closed < PAGE) break;
        if (pageNumber === MAX_SOURCE_PAGES - 1) needsAttention += 1;
      }
      const after = await pending(database, context);
      return {
        checked: before,
        changed: Math.max(0, before - after) + closed,
        needsAttention,
      };
    },
  };
}

/**
 * The runtime bindings for the three contributors the lifecycle bindings do not supply. Each missing
 * dependency leaves its contributor unbound, which always reports attention: there is no default that
 * reports a clean tenant.
 */
export function createRuntimeRestoreRecoveryBindings(
  deps: RuntimeRestoreDeps,
  ops: RecoveryOperations = RUNTIME_RECOVERY,
): RestoreRecoveryBindings {
  return {
    ...(deps.agentDatabase && deps.probeRun
      ? { 'm4-runs-and-budgets': runsAndBudgets(deps.agentDatabase, deps.probeRun, ops) }
      : {}),
    ...(deps.agentDatabase
      ? { 'm4-private-transcripts': privateTranscripts(deps.agentDatabase, ops) }
      : {}),
    ...(deps.knowledgeStore
      ? { 'm5-sources-and-indexes': sourcesAndIndexes(deps.knowledgeStore, ops) }
      : {}),
  };
}
