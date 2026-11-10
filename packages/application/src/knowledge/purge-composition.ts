// File categories have different retained identities and proof ledgers. Neither may certify the
// other empty, and missing lifecycle authority must never become a zero-count default.
import type { TenantContext, Tx } from '@ensemus/database';
import { isRecordPurgeKind } from '@ensemus/domain/knowledge-events';
import { AppError } from '../errors';
import type { StructuredRecordPurge } from './artifact-provenance';

export type KnowledgeArtifactPurgePorts = {
  /** The generated-file contributor. It is the only one that can prove a record has no remaining
   * generated-file lineage, so a record purge never completes without its own zero. */
  derived: StructuredRecordPurge;
  /** Imported archive files. Its zero says nothing about generated files, for any record kind. */
  archive: StructuredRecordPurge;
};
type Result = Awaited<ReturnType<StructuredRecordPurge['purgeSource']>>;
const MAX_PER_CATEGORY = 25;
const worker = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const add = (first: number, second: number) => {
  const total = first + second;
  if (!count(total)) throw new AppError('INVALID_STATE');
  return total;
};
function result(value: unknown): Result {
  if (!value || typeof value !== 'object') throw new AppError('INVALID_STATE');
  const row = value as Partial<Result>;
  if (
    !count(row.removed) ||
    !count(row.remaining) ||
    !count(row.held) ||
    typeof row.confirmed !== 'boolean' ||
    row.held > row.remaining ||
    (row.confirmed && (row.remaining !== 0 || row.held !== 0))
  ) {
    throw new AppError('INVALID_STATE');
  }
  return {
    removed: row.removed,
    remaining: row.remaining,
    held: row.held,
    confirmed: row.confirmed,
  };
}
function remaining(value: unknown) {
  if (!value || typeof value !== 'object' || !count((value as { remaining?: unknown }).remaining))
    throw new AppError('INVALID_STATE');
  return (value as { remaining: number }).remaining;
}
function boundedLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT');
  return Math.min(limit, MAX_PER_CATEGORY);
}
/**
 * Every typed-record kind a deletion routes here (RECORD_PURGE_KINDS), each under its own kind. A custom
 * object record is proved like the others, never cast into a Work, project or client kind: the generated
 * contributor's own record proof (knowledge.derived_structured_artifacts_remaining, 0419) names it
 * directly, through artifact_lineage_records (which admit object_record since 0407) and the frozen
 * authority refs of artifact_depends_on_record (0419), and still counts every generated file whose
 * structured inventory is incomplete. That proof also requires the record's copied Work purged first
 * (RECORD_WORK_PURGE_UNCONFIRMED). Archive cleanup alone never certifies a record: completion below needs
 * both contributors' zeros. Any other kind is refused before either contributor runs.
 */
const record = <T extends Parameters<StructuredRecordPurge['confirmRecordInTx']>[2]>(input: T) => {
  if (!input || !isRecordPurgeKind(input.kind)) throw new AppError('INVALID_INPUT');
  return input;
};

/** Both ports are required and production composition constructs their actual implementations.
 * Each category gets up to25 headers per attempt (50 total), even when the first is held/partial.
 * Cumulative counts come from their disjoint durable ledgers, never this-call delete increments. */
export function createKnowledgeArtifactPurge(
  ports: KnowledgeArtifactPurgePorts,
): StructuredRecordPurge {
  const methods = ['purgeSource', 'confirmInTx', 'purgeRecord', 'confirmRecordInTx'] as const;
  if (
    !ports ||
    !ports.derived ||
    !ports.archive ||
    methods.some(
      (method) =>
        typeof ports.derived[method] !== 'function' || typeof ports.archive[method] !== 'function',
    )
  )
    throw new AppError('INVALID_STATE');

  const purge = async (derived: () => Promise<Result>, archive: () => Promise<Result>) => {
    // A failing category must not starve the other. Its error still refuses aggregate completion;
    // durable cumulative counters let the next retry recover any independently completed progress.
    const attempt = async (run: () => Promise<Result>) => {
      try {
        return await run();
      } catch {
        return null;
      }
    };
    const first = await attempt(derived),
      second = await attempt(archive);
    const known = result(first),
      imported = result(second);
    return {
      removed: add(known.removed, imported.removed),
      remaining: add(known.remaining, imported.remaining),
      held: add(known.held, imported.held),
      confirmed:
        known.confirmed &&
        imported.confirmed &&
        known.remaining === 0 &&
        imported.remaining === 0 &&
        known.held === 0 &&
        imported.held === 0,
    };
  };
  return {
    async purgeSource(context, input) {
      worker(context);
      const bounded = { ...input, limit: boundedLimit(input.limit) };
      return purge(
        () => ports.derived.purgeSource(context, bounded),
        () => ports.archive.purgeSource(context, bounded),
      );
    },
    async confirmInTx(tx: Tx, context, input) {
      worker(context);
      // The caller holds the actual source lock. Never catch a SQL failure and continue querying
      // an aborted transaction, or substitute an empty result for a missing ledger.
      const known = await ports.derived.confirmInTx(tx, context, input);
      const imported = await ports.archive.confirmInTx(tx, context, input);
      return { remaining: add(remaining(known), remaining(imported)) };
    },
    async purgeRecord(context, input) {
      worker(context);
      const bounded = { ...record(input), limit: boundedLimit(input.limit) };
      return purge(
        () => ports.derived.purgeRecord(context, bounded),
        () => ports.archive.purgeRecord(context, bounded),
      );
    },
    async confirmRecordInTx(tx, context, input) {
      worker(context);
      const selected = record(input);
      const known = await ports.derived.confirmRecordInTx(tx, context, selected);
      const imported = await ports.archive.confirmRecordInTx(tx, context, selected);
      return { remaining: add(remaining(known), remaining(imported)) };
    },
  };
}
