import { AppError } from '@ensemus/application';
import { searchCompany } from '@ensemus/application/knowledge/company-search';
import Link from 'next/link';
import { PageHead, Empty, ErrorNotice } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Search the company | Ensemus' };
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
    <>
      <PageHead
        title="Search the company"
        description="Find work, people, teams, clients, projects and readable source passages."
      />
      <ErrorNotice code={error} />
      <form method="get" className="card fields">
        <label>
          Search
          <input type="search" name="q" required maxLength={200} defaultValue={q.slice(0, 200)} />
        </label>
        <div className="row">
          <SubmitButton>Search</SubmitButton>
        </div>
      </form>
      {q.trim() && !hits.length ? (
        <Empty>No matching records are available to you.</Empty>
      ) : (
        <div className="stack">
          {hits.map((hit) => (
            <article className="card" key={`${hit.kind}:${hit.id}`}>
              <h2>
                <Link href={hit.path}>{hit.title}</Link>
              </h2>
              <p className="muted">
                {
                  {
                    work_unit: 'Work',
                    client: 'Client',
                    project: 'Project',
                    person: 'Person',
                    team: 'Team',
                    document: 'Source passage',
                  }[hit.kind]
                }
              </p>
              {hit.excerpt && <p>{hit.excerpt}</p>}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
