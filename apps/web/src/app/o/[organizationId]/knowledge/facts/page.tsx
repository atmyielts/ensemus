import { AppError } from '@ensemus/application';
import { listFacts } from '@ensemus/application/knowledge/facts';
import Link from 'next/link';
import { PageHead, Empty, ErrorNotice, ClassificationBadge, StatusBadge } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Company facts | Ensemus' };
export default async function FactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId),
    q = await searchParams;
  let error: string | undefined;
  const page = await listFacts(database, context, {
    ...(q.cursor ? { after: q.cursor } : {}),
  }).catch((failure: unknown) => {
    if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
    error = 'INVALID_INPUT';
    return listFacts(database, context, {});
  });
  return (
    <>
      <PageHead
        title="Company facts"
        description="Claims supported by source passages. Only verified, current facts can be treated as trusted knowledge."
        actions={
          <Link className="button" href={`/o/${organizationId}/knowledge/search`}>
            Propose from a passage
          </Link>
        }
      />
      <ErrorNotice code={error} />
      {!page.items.length ? (
        <Empty>No facts are available to you. Find a source passage to propose one.</Empty>
      ) : (
        <div className="stack">
          {page.items.map((fact) => (
            <article className="card" key={fact.id}>
              <h2>
                <Link href={`/o/${organizationId}/knowledge/facts/${fact.id}`}>
                  {typeof fact.claim === 'string' ? fact.claim : 'Structured claim'}
                </Link>
              </h2>
              <div className="row">
                <StatusBadge status={fact.trustState} />
                <ClassificationBadge value={fact.classification} />
              </div>
              <p className="muted">
                {fact.origin === 'model' ? 'Proposed by an assistant' : 'Proposed by a person'} ·{' '}
                {fact.evidence.length} source {fact.evidence.length === 1 ? 'passage' : 'passages'}
              </p>
              {fact.evidence.some((e) => e.stale) && (
                <p>A source has a newer version. Review the supporting passage.</p>
              )}
            </article>
          ))}
        </div>
      )}
      {page.next && <Link href={`?cursor=${encodeURIComponent(page.next)}`}>More facts</Link>}
    </>
  );
}
