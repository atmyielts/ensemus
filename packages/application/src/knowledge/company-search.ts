// Owned by the retrieve slice (UX-22's service, QA-002). See docs/06-delivery/m5-slices.md. One box over
// what a person may see. Each kind filters inside its query, by the same rules its own pages use.
import { withTenantTx, type AppDatabase, type TenantContext } from '@ensemus/database';
import { sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { requireSearchPerson, searchLimit, searchQuery } from './retrieval';

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
export async function searchCompany(
  database: AppDatabase,
  context: TenantContext,
  input: { query: string; kinds?: readonly CompanySearchKind[]; limit?: number },
): Promise<readonly CompanySearchHit[]> {
  if (context.actorType === 'service') throw new AppError('FORBIDDEN');
  const query = searchQuery(input.query, 200);
  const limit = searchLimit(input.limit);
  const kinds = input.kinds ?? COMPANY_SEARCH_KINDS;
  if (
    kinds.length > COMPANY_SEARCH_KINDS.length ||
    kinds.some((kind) => !COMPANY_SEARCH_KINDS.includes(kind))
  )
    throw new AppError('INVALID_INPUT');
  return withTenantTx(database, context, async (tx) => {
    await requireSearchPerson(tx, context);
    if (!query || !kinds.length) return [];
    const org = context.organizationId;
    const base = `/o/${org}`;
    // All kinds rank inside their authorized query, before the shared limit. There is no total that
    // could count hidden documents or restricted work, and no email is searched behind the People UI.
    const result = await tx.execute<CompanySearchHit>(sql`
      with hits as (
        select 'work_unit'::text as kind, w.id, w.title, null::text as excerpt,
               ${base + '/work/'} || w.id::text as path,
               ts_rank_cd(to_tsvector('simple', w.title), websearch_to_tsquery('simple', ${query})) as score
          from work.work_units w
         where ${kinds.includes('work_unit')} and w.organization_id = ${org}::uuid
           and knowledge.can_read_work(w.id, app.current_membership_id())
           and to_tsvector('simple', w.title) @@ websearch_to_tsquery('simple', ${query})
        union all
        select 'client', c.id, c.display_name, null::text, ${base + '/clients'},
               ts_rank_cd(to_tsvector('simple', c.display_name), websearch_to_tsquery('simple', ${query}))
          from work.clients c
         where ${kinds.includes('client')} and c.organization_id = ${org}::uuid
           and knowledge.can_read_fact_subject('client:' || c.id::text)
           and to_tsvector('simple', c.display_name) @@ websearch_to_tsquery('simple', ${query})
        union all
        select 'project', p.id, p.name, null::text, ${base + '/clients'},
               ts_rank_cd(to_tsvector('simple', p.name), websearch_to_tsquery('simple', ${query}))
          from work.projects p
         where ${kinds.includes('project')} and p.organization_id = ${org}::uuid
           and knowledge.can_read_fact_subject('project:' || p.id::text)
           and to_tsvector('simple', p.name) @@ websearch_to_tsquery('simple', ${query})
        union all
        select 'person', m.id, u.name, null::text, ${base + '/people'},
               ts_rank_cd(to_tsvector('simple', u.name), websearch_to_tsquery('simple', ${query}))
          from org.memberships m join identity.users u on u.id = m.user_id
         where ${kinds.includes('person')} and m.organization_id = ${org}::uuid
           and to_tsvector('simple', u.name) @@ websearch_to_tsquery('simple', ${query})
        union all
        select 'team', t.id, t.name, null::text, ${base + '/people'},
               ts_rank_cd(to_tsvector('simple', t.name), websearch_to_tsquery('simple', ${query}))
          from org.teams t
         where ${kinds.includes('team')} and t.organization_id = ${org}::uuid
           and to_tsvector('simple', t.name) @@ websearch_to_tsquery('simple', ${query})
        union all
        select 'document', d.id, d.title, left(passage.text_body, 240), ${base + '/knowledge/sources/'} || d.source_id::text,
               greatest(ts_rank_cd(to_tsvector('simple', d.title), websearch_to_tsquery('simple', ${query})), passage.score)
          from knowledge.documents d
          join knowledge.sources s on s.organization_id = d.organization_id and s.id = d.source_id
          join lateral (
            select c.text_body, ts_rank_cd(c.lexemes, websearch_to_tsquery('english', ${query})) as score
              from knowledge.chunks c
             where c.organization_id = d.organization_id and c.document_id = d.id
               and c.source_id in (select knowledge.readable_source_ids(app.current_membership_id()))
             order by score desc, c.id limit 1
          ) passage on true
         where ${kinds.includes('document')} and d.organization_id = ${org}::uuid
           and d.state = 'searchable' and d.superseded_at is null and s.state = 'active'
           and d.source_id in (select knowledge.readable_source_ids(app.current_membership_id()))
           and (to_tsvector('simple', d.title) @@ websearch_to_tsquery('simple', ${query}) or passage.score > 0)
      ) select kind, id, title, excerpt, path from hits order by score desc, kind, id limit ${limit}
    `);
    return result.rows;
  });
}
