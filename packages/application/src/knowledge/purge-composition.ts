// File categories have different retained identities and proof ledgers. Neither may certify the
// other empty, and missing lifecycle authority must never become a zero-count default.
import type { TenantContext, Tx } from '@ensemus/database';
import { AppError } from '../errors';
import type { StructuredRecordPurge } from './artifact-provenance';

export type KnowledgeArtifactPurgePorts = {
  derived: StructuredRecordPurge;
  /** Only the shared admitted record kinds are consumed here. The actual archive adapter also
   * supports custom records, which cannot certify missing generated custom-record lineage. */
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
const record = (input: Parameters<StructuredRecordPurge['confirmRecordInTx']>[2]) => {
  // Generated-file custom-record lineage has no admitted implementation yet. Archive cleanup alone
  // cannot certify it, so do not cast a custom object into one of the supported record kinds.
  if (!['work_unit', 'project', 'client'].includes(input.kind)) throw new AppError('INVALID_INPUT');
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
