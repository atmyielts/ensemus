// Owned by the usage slice (MODEL-04). The people's side of budgets and usage, which web may call. Needs
// `budget.manage` or `usage.view`. There is no default budget, so no budget means no run (FD-6). Every stub refuses.
import type { SetBudget, UsageSummary } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';

export function setBudget(
  _database: AppDatabase,
  _context: TenantContext,
  _input: SetBudget,
): Promise<{ budgetId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function getUsageSummary(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { period: string },
): Promise<UsageSummary> {
  throw new Error('NOT_IMPLEMENTED');
}
