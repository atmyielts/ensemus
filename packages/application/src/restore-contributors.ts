// Restore audits use the ordinary tenant connection and reviewed metadata projections. Recovery ports
// belong to their runtime owners: in particular only the agent role may inspect/purge private payloads.
import { sql } from 'drizzle-orm';
import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import type { ContributorReport, RestoreContributor } from './sovereign-ports';
import { queryRows } from './portability-sql';

export const REQUIRED_RESTORE_CONTRIBUTORS = [
  'm4-runs-and-budgets',
  'm4-private-transcripts',
  'm5-sources-and-indexes',
  'm5-derived-artifacts',
] as const;
type ContributorName = (typeof REQUIRED_RESTORE_CONTRIBUTORS)[number];

/** The concrete adapter must fence actual surviving writers/runs, reconcile against Temporal and
 * retain uncertain spend. Returning zero is a positive proof, never a default for absent storage. */
export interface RestoreRecoveryPort {
  reconcile(
    database: AppDatabase,
    context: TenantContext,
  ): Promise<Omit<ContributorReport, 'name'>>;
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

async function metadata(database: AppDatabase, context: TenantContext, name: ContributorName) {
  if (context.actorType !== 'service') throw new Error('RESTORE_NEEDS_SERVICE');
  return withTenantTx(database, context, async (tx) => {
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
      // No ai.step_payloads query, even a count: app has no authority over that private table.
      return { checked: 0, attention: 0 };
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
    return row;
  });
}

export function createRestoreContributors(
  bindings: RestoreRecoveryBindings = {},
): readonly RestoreContributor[] {
  return REQUIRED_RESTORE_CONTRIBUTORS.map((name) => ({
    name,
    reconcile: async (database, context) => {
      const before = await metadata(database, context, name);
      const port = bindings[name];
      if (!port)
        return { name, checked: before.checked, changed: 0, needsAttention: before.attention + 1 };
      const recovered = await port.reconcile(database, context);
      if (
        [recovered.checked, recovered.changed, recovered.needsAttention].some(
          (value) => !Number.isSafeInteger(value) || value < 0,
        )
      )
        throw new Error('RESTORE_PROOF_INVALID');
      const after = await metadata(database, context, name);
      return {
        name,
        checked: Math.max(before.checked, recovered.checked, after.checked),
        changed: recovered.changed,
        needsAttention: recovered.needsAttention + after.attention,
      };
    },
  }));
}
