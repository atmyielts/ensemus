import { AppError } from '@ensemus/application';
import { searchCompany } from '@ensemus/application/knowledge/company-search';
import Link from 'next/link';
import { PageHead, Empty, ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Search the company | Ensemus' };
const KIND: Record<string, string> = {
  work_unit: 'Work',
  client: 'Client',
  project: 'Project',
  person: 'Person',
  team: 'Team',
  document: 'Source passage',
};
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId),
    query = await searchParams;
  const q = typeof query.q === 'string' ? query.q : '';
  let error: string | undefined;
  const hits = q.trim()
    ? await searchCompany(database, context, { query: q }).catch((failure: unknown) => {
        if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
        error = 'INVALID_INPUT';
        return [];
      })
    : [];
  return (
    <div className="stack">
      <PageHead
        title="Search the company"
        description="Find work, people, teams, clients, projects and passages in documents. You only see what you are allowed to see."
      />
      <ErrorNotice code={error} />
      <form method="get" role="search" className="card inline-form company-search-form">
        <label>
          Search
          <input
            type="search"
            name="q"
            required
            maxLength={200}
            defaultValue={q.slice(0, 200)}
            placeholder="A name, a word or a phrase"
          />
        </label>
        <SubmitButton>Search</SubmitButton>
      </form>
      {q.trim() &&
        (!hits.length ? (
          <Empty title="Nothing matches that search">
            Try a shorter word, or part of a name. Results only include things you have access to.
          </Empty>
        ) : (
          <section className="stack" aria-labelledby="results-heading">
            <div className="section-heading">
              <h2 id="results-heading">Results</h2>
              <p>
                {hits.length} {hits.length === 1 ? 'match' : 'matches'}
              </p>
            </div>
            <div className="card">
              <ol className="list result-list">
                {hits.map((hit) => (
                  <li key={`${hit.kind}:${hit.id}`}>
                    <div className="result-title">
                      <Link href={hit.path}>{hit.title}</Link>
                      <span className="badge tag">{KIND[hit.kind] ?? 'Record'}</span>
                    </div>
                    {hit.excerpt && <p className="result-snippet">{hit.excerpt}</p>}
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ))}
    </div>
  );
}
