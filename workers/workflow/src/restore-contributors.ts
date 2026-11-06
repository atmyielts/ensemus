// The one list of what has to catch up after a restore (ADR-030 D11). Empty until the milestones that own that
// state add themselves at the final merge: M4 for agent runs and budgets, and M5 for search chunks and
// embeddings rebuilt with fresh ACLs. Each runs once per tenant, may run again, and never touches a provider.
import type { RestoreContributor } from '@ensemus/application';

export const RESTORE_CONTRIBUTORS: readonly RestoreContributor[] = [];
