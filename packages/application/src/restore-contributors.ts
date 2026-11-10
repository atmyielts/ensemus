// Restore audits use the ordinary tenant connection and reviewed metadata projections. Recovery ports
// belong to their runtime owners: in particular only the agent role may inspect/purge private payloads.
import { sql } from 'drizzle-orm';
import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import type {
  ContributorReport,
  RestoreContributor,
  RestoreRunInputCounts,
  RestoreOutputWriteCounts,
  RestoreTranscriptProof,
} from './sovereign-ports';
import { queryRows } from './portability-sql';

export const REQUIRED_RESTORE_CONTRIBUTORS = [
  'm4-runs-and-budgets',
  'm4-private-transcripts',
  'm5-sources-and-indexes',
  'm5-derived-artifacts',
  'm6-archive-quarantine',
] as const;
type ContributorName = (typeof REQUIRED_RESTORE_CONTRIBUTORS)[number];

/** The concrete adapter must fence actual surviving writers/runs, reconcile against Temporal and
 * retain uncertain spend. Returning zero is a positive proof, never a default for absent storage. */
export interface RestoreRecoveryPort {
  reconcile(
    database: AppDatabase,
    context: TenantContext,
  ): Promise<
    Omit<ContributorReport, 'name' | 'runInputs' | 'outputWrites'> & {
      transcriptProof?: RestoreTranscriptProof;
    }
  >;
}
export type RestoreRecoveryBindings = Partial<Record<ContributorName, RestoreRecoveryPort>>;

export function missingRestoreContributors(reports: readonly ContributorReport[]): number {
  const names = reports.map((report) => report.name);
  const invalid = reports.filter(
    (report) =>
      !REQUIRED_RESTORE_CONTRIBUTORS.includes(report.name as ContributorName) ||
      [report.checked, report.changed, report.needsAttention].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      ),
  ).length;
  return (
    REQUIRED_RESTORE_CONTRIBUTORS.filter(
      (name) => names.filter((value) => value === name).length !== 1,
    ).length + invalid
  );
}

const validCounts = (values: readonly number[]) =>
  values.every((value) => Number.isSafeInteger(value) && value >= 0);
export function evaluateRunInputRestoreMetadata(input: RestoreRunInputCounts) {
  if (!validCounts(Object.values(input))) throw new Error('RESTORE_INPUT_COUNTS_INVALID');
  return {
    checked: input.runs + input.checkpoints + input.observations,
    attention:
      input.missingCheckpoints +
      input.legacyHistoryUnknown +
      input.unfencedTerminalRuns +
      input.uncertifiedFences +
      input.unsupportedProtocols,
  };
}
export function evaluateOutputWriteRestoreMetadata(input: RestoreOutputWriteCounts) {
  if (!validCounts(Object.values(input))) throw new Error('RESTORE_OUTPUT_COUNTS_INVALID');
  return { checked: input.writes, attention: input.unsettledWrites + input.mismatchedTokens };
}
export function transcriptRestoreProofAttention(
  proof: unknown,
  counts: RestoreRunInputCounts,
): number {
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return 1;
  const candidate = proof as Partial<RestoreTranscriptProof>;
  const values = [candidate.checkedRuns, candidate.certifiedRuns, candidate.remainingPayloads];
  if (
    candidate.protocol !== 'ai.run_inputs/v1' ||
    candidate.fenceGeneration !== 1 ||
    values.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
  )
    return 1;
  const { checkedRuns, certifiedRuns, remainingPayloads } = candidate as RestoreTranscriptProof;
  if (
    checkedRuns < counts.runs ||
    certifiedRuns < counts.certifiedFences ||
    certifiedRuns > checkedRuns
  )
    return 1;
  return remainingPayloads;
}

type MetadataAudit = {
  checked: number;
  attention: number;
  runInputs?: RestoreRunInputCounts;
  outputWrites?: RestoreOutputWriteCounts;
};
async function metadata(
  database: AppDatabase,
  context: TenantContext,
  name: ContributorName,
): Promise<MetadataAudit> {
  if (context.actorType !== 'service') throw new Error('RESTORE_NEEDS_SERVICE');
  return withTenantTx(database, context, async (tx) => {
    if (name === 'm6-archive-quarantine') {
      const [row] = await queryRows<MetadataAudit>(
        tx,
        sql`select * from sovereign.archive_file_restore_counts()`,
      );
      if (!row) throw new Error('RESTORE_METADATA_UNAVAILABLE');
      return row;
    }
    if (name === 'm4-runs-and-budgets') {
      const [row] = await queryRows<{ checked: number; attention: number }>(
        tx,
        sql`
        select (select count(*) from ai.agent_runs where organization_id=${context.organizationId}::uuid)::int as checked,
          ((select count(*) from ai.agent_runs where organization_id=${context.organizationId}::uuid
            and status in ('queued','preparing','running','paused','waiting_for_approval','waiting_for_child','verifying'))
          +(select count(*) from platform.budget_reservations where organization_id=${context.organizationId}::uuid and status='held')
          +(select count(*) from platform.budgets b where b.organization_id=${context.organizationId}::uuid
            and b.reserved_micros<>(select coalesce(sum(r.amount_micros),0) from platform.budget_reservations r
              where r.organization_id=b.organization_id and r.budget_id=b.id and r.status='held')))::int as attention`,
      );
      if (!row) throw new Error('RESTORE_METADATA_UNAVAILABLE');
      return row;
    }
    if (name === 'm4-private-transcripts') {
      // No ai.step_payloads query, even a count. The immutable certificate and generation are
      // visible metadata; they still need a separate actual agent-role recovery result below.
      const [counts] = await queryRows<RestoreRunInputCounts>(
        tx,
        sql`
        select (select count(*)::int from ai.agent_runs r where r.organization_id=${context.organizationId}::uuid) as runs,
          (select count(*)::int from ai.run_input_checkpoints c where c.organization_id=${context.organizationId}::uuid) as checkpoints,
          (select count(*)::int from ai.run_input_observations o where o.organization_id=${context.organizationId}::uuid) as observations,
          (select count(*)::int from ai.agent_runs r left join ai.run_input_checkpoints c on c.organization_id=r.organization_id and c.run_id=r.id
            where r.organization_id=${context.organizationId}::uuid and c.run_id is null) as "missingCheckpoints",
          (select count(*)::int from ai.run_input_checkpoints c where c.organization_id=${context.organizationId}::uuid and not c.history_complete) as "legacyHistoryUnknown",
          (select count(*)::int from ai.agent_runs r join ai.run_input_checkpoints c on c.organization_id=r.organization_id and c.run_id=r.id
            where r.organization_id=${context.organizationId}::uuid and r.status in ('completed','failed','cancelled','budget_exhausted','policy_denied','timed_out','outcome_unverified') and c.fenced_at is null) as "unfencedTerminalRuns",
          (select count(*)::int from ai.run_input_checkpoints c where c.organization_id=${context.organizationId}::uuid and c.fenced_at is not null
            and (c.fence_generation<>1 or c.payloads_purged_at is null or c.purged_fence_generation is distinct from c.fence_generation)) as "uncertifiedFences",
          (select count(*)::int from ai.run_input_checkpoints c where c.organization_id=${context.organizationId}::uuid and c.fenced_at is not null
            and c.fence_generation=1 and c.payloads_purged_at is not null and c.purged_fence_generation=c.fence_generation) as "certifiedFences",
          (select count(*)::int from ai.run_input_checkpoints c where c.organization_id=${context.organizationId}::uuid and c.protocol_version<>'v1') as "unsupportedProtocols"`,
      );
      if (!counts) throw new Error('RESTORE_INPUT_METADATA_UNAVAILABLE');
      return { ...evaluateRunInputRestoreMetadata(counts), runInputs: counts };
    }
    if (name === 'm5-sources-and-indexes') {
      const [row] = await queryRows<{ checked: number; attention: number }>(
        tx,
        sql`
        select (select count(*) from knowledge.sources where organization_id=${context.organizationId}::uuid)::int as checked,
          ((select count(*) from knowledge.sources s where s.organization_id=${context.organizationId}::uuid
            and exists(select 1 from platform.tombstones t where t.organization_id=s.organization_id
              and t.target_type='knowledge_source' and t.target_id=s.id) and s.state='active')
          +(select count(*) from knowledge.object_writers where organization_id=${context.organizationId}::uuid and state='active')
          +(select count(*) from knowledge.purge_jobs where organization_id=${context.organizationId}::uuid
            and (state<>'completed' or transcripts_checked_at is null or artifacts_checked_at is null))
          +(select count(*) from knowledge.documents d where d.organization_id=${context.organizationId}::uuid
            and d.state in ('received','parsing') and exists(select 1 from knowledge.sources s
              where s.organization_id=d.organization_id and s.id=d.source_id and s.state='active'))
          +(select count(*) from knowledge.documents d where d.organization_id=${context.organizationId}::uuid
            and d.state='searchable' and not exists(select 1 from knowledge.chunks c
              where c.organization_id=d.organization_id and c.document_id=d.id))
          +(select coalesce(sum(sovereign.imported_definitions_remaining('knowledge_source',t.target_id)),0)
            from platform.tombstones t where t.organization_id=${context.organizationId}::uuid and t.target_type='knowledge_source'))::int as attention`,
      );
      if (!row) throw new Error('RESTORE_METADATA_UNAVAILABLE');
      return row;
    }
    const [outputWrites] = await queryRows<RestoreOutputWriteCounts>(
      tx,
      sql`
      select count(*)::int as writes,
        count(*) filter(where w.state<>'settled' and not (
          l.artifact_id is not null and l.execution_kind='agent_run' and l.execution_id=w.run_id
          and l.write_id=w.write_id and l.generation=w.generation and l.physical_purged_at is not null
          and l.write_state in ('settled','fenced') and a.alive is false))::int as "unsettledWrites",
        count(*) filter(where l.artifact_id is null or a.artifact_id is null or l.execution_kind<>'agent_run' or l.execution_id is distinct from w.run_id
          or l.write_id is distinct from w.write_id or l.generation is distinct from w.generation)::int as "mismatchedTokens"
      from ai.run_output_writes w left join knowledge.artifact_lineage l on l.organization_id=w.organization_id and l.artifact_id=w.artifact_id
      left join knowledge.artifact_acl_catalog a on a.organization_id=w.organization_id and a.artifact_id=w.artifact_id
      where w.organization_id=${context.organizationId}::uuid`,
    );
    if (!outputWrites) throw new Error('RESTORE_OUTPUT_METADATA_UNAVAILABLE');
    const outputAudit = evaluateOutputWriteRestoreMetadata(outputWrites);
    const [row] = await queryRows<{ checked: number; attention: number }>(
      tx,
      sql`
      select count(*)::int as checked,(count(*) filter(where restore_reapply_pending
        or write_state in ('active','unknown') or state='pending'
        or (state='blocked' and physical_purged_at is null))
        +(select coalesce(sum(sovereign.imported_definitions_remaining(c.record_kind,c.record_id)),0)
          from knowledge.structured_record_catalog c where c.organization_id=${context.organizationId}::uuid and not c.alive))::int as attention
      from knowledge.artifact_lineage where organization_id=${context.organizationId}::uuid`,
    );
    if (!row) throw new Error('RESTORE_METADATA_UNAVAILABLE');
    return {
      checked: row.checked + outputAudit.checked,
      attention: row.attention + outputAudit.attention,
      outputWrites,
    };
  });
}

export function createRestoreContributors(
  bindings: RestoreRecoveryBindings = {},
): readonly RestoreContributor[] {
  return REQUIRED_RESTORE_CONTRIBUTORS.map((name) => ({
    name,
    reconcile: async (database, context) => {
      const before = await metadata(database, context, name);
      const details = (value: MetadataAudit) => ({
        ...(value.runInputs ? { runInputs: value.runInputs } : {}),
        ...(value.outputWrites ? { outputWrites: value.outputWrites } : {}),
      });
      const port = bindings[name];
      if (!port)
        return {
          name,
          checked: before.checked,
          changed: 0,
          needsAttention: before.attention + 1,
          ...details(before),
        };
      const recovered = await port.reconcile(database, context);
      if (
        [recovered.checked, recovered.changed, recovered.needsAttention].some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        )
      )
        throw new Error('RESTORE_PROOF_INVALID');
      const after = await metadata(database, context, name);
      const proofAttention =
        name === 'm4-private-transcripts'
          ? after.runInputs
            ? transcriptRestoreProofAttention(recovered.transcriptProof, after.runInputs)
            : 1
          : 0;
      return {
        name,
        checked: Math.max(before.checked, recovered.checked, after.checked),
        changed: recovered.changed,
        needsAttention: recovered.needsAttention + after.attention + proofAttention,
        ...details(after),
      };
    },
  }));
}
