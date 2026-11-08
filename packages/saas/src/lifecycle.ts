// Retention and legal hold (LIFE-02, LIFE-03). Pure. There is no retention number here, and there never is:
// they come from legal sign-off, per customer (docs/04-security/05-data-lifecycle.md §4).
// The tables of values are fixed. The functions are owned by the retention slice. See m8-slices.md.

/** The categories in 04-security/05 §4. A category with no rule is never swept. */
export const DATA_CATEGORIES = [
  'transaction_records',
  'work_unit_history',
  'raw_files',
  'search_indexes',
  'derived_embeddings',
  'model_outputs',
  'operational_traces',
  'audit_logs',
  'temporary_debug_captures',
] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

/** These can be set, and shown, but a sweep refuses them: they are kept by another mechanism. */
export const CATEGORIES_NOT_SWEPT: readonly DataCategory[] = ['audit_logs', 'transaction_records'];

export const HOLD_SCOPES = ['organization', 'client', 'project', 'work_unit', 'artifact'] as const;
export type HoldScope = (typeof HOLD_SCOPES)[number];

export type RetentionRuleFacts = {
  dataCategory: string;
  classification: string;
  retainDays: number | null;
};

/**
 * The cutoff for one record: the most specific rule for its class, then the rule for `*`. No rule, or a
 * null number, is null: keep it. Never computes a default.
 */
export function retentionCutoff(
  rules: readonly RetentionRuleFacts[],
  category: DataCategory,
  classification: string,
  now: Date,
): Date | null {
  if (!Number.isFinite(now.getTime())) throw new RangeError('INVALID_RETENTION_CLOCK');
  if (CATEGORIES_NOT_SWEPT.includes(category)) return null;
  const rule =
    rules.find(
      (value) => value.dataCategory === category && value.classification === classification,
    ) ?? rules.find((value) => value.dataCategory === category && value.classification === '*');
  if (!rule || rule.retainDays === null) return null;
  if (!Number.isSafeInteger(rule.retainDays) || rule.retainDays < 1)
    throw new RangeError('INVALID_RETENTION_RULE');
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - rule.retainDays);
  if (!Number.isFinite(cutoff.getTime())) throw new RangeError('INVALID_RETENTION_RULE');
  return cutoff;
}
