// Owned by the retrieve slice (UX-22's service, QA-002). See docs/06-delivery/m5-slices.md. One box over
// what a person may see. Each kind filters inside its query, by the same rules its own pages use.
import type { AppDatabase, TenantContext } from '@ensemus/database';

export const COMPANY_SEARCH_KINDS = [
  'work_unit',
  'client',
  'project',
  'person',
  'team',
  'document',
] as const;
export type CompanySearchKind = (typeof COMPANY_SEARCH_KINDS)[number];

export type CompanySearchHit = {
  kind: CompanySearchKind;
  id: string;
  /** What to show. Only ever a name the viewer can already see, or for a document an excerpt. */
  title: string;
  excerpt: string | null;
  /** A path inside this organization, with no origin, and never built from anything a user typed. */
  path: string;
};

/**
 * Work through `knowledge.can_read_work`, documents through the ACL, people and teams as the People page
 * shows them. Two tenants holding the same name see only their own (QA-002). Refuses a service context.
 */
export function searchCompany(
  _database: AppDatabase,
  _context: TenantContext,
  _input: { query: string; kinds?: readonly CompanySearchKind[]; limit?: number },
): Promise<readonly CompanySearchHit[]> {
  throw new Error('NOT_IMPLEMENTED');
}
