// Owned by the retention slice (LIFE-02). Rules apply per data class. Numbers come from legal sign-off, and
// there is not one in this code (docs/04-security/05-data-lifecycle.md §4). See ADR-032 D6.
import type { AppDatabase, TenantContext } from '@ensemus/database';
import type { DataCategory } from '@ensemus/saas/lifecycle';
import type { RetentionSource } from './ports';

export type RetentionRuleView = {
  id: string;
  dataCategory: string;
  classification: string;
  retainDays: number | null;
  basisRef: string;
  setByMembershipId: string;
  createdAt: Date;
};

/** `retention.manage`. Current rules only, unless `history` asks for superseded ones as well. */
export function listRetentionRules(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { history?: boolean },
): Promise<readonly RetentionRuleView[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * `retention.manage`. `basisRef` is required, since a number with no sign-off is invented. Supersedes what was
 * there and writes the new rule in one transaction. Audited and emits RETENTION_RULE_SET. Refuses a category
 * in CATEGORIES_NOT_SWEPT if it names a number, because those are kept another way.
 */
export function setRetentionRule(
  _database: AppDatabase,
  _context: TenantContext,
  _input: {
    dataCategory: DataCategory;
    classification: string;
    retainDays: number | null;
    basisRef: string;
  },
): Promise<{ ruleId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export type RetentionSweep = {
  category: string;
  examined: number;
  removed: number;
  held: number;
  more: boolean;
};

/**
 * Service only, one bounded page per category per call. A record under a hold stays, counted as `held` when the
 * database refuses it with LEGAL_HOLD_ACTIVE, and one refusal never stops the rest. Writes a run row each time.
 * A category with no rule is not touched.
 */
export function sweepRetention(
  _database: AppDatabase,
  _context: TenantContext,
  _sources: readonly RetentionSource[],
  _input: { limit: number; now: Date },
): Promise<readonly RetentionSweep[]> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The source for `raw_files`, the one category M8 itself can sweep today, over the existing tombstone and
 * ledger path (LIFE-01). Other milestones add theirs at the final merge.
 */
export function createRawFilesRetentionSource(_store: unknown): RetentionSource {
  throw new Error('NOT_IMPLEMENTED');
}
