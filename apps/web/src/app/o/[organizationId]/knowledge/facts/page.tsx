import { AppError } from '@ensemus/application';
import { listFacts } from '@ensemus/application/knowledge/facts';
import Link from 'next/link';
import {
  PageHead,
  Empty,
  ErrorNotice,
  ClassificationBadge,
  StatusBadge,
  ActionLink,
} from '@/components/ui';
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
  const search = `/o/${organizationId}/knowledge/search`,
    empty = !page.items.length;
  return (
    <>
      <PageHead
        title="Company facts"
        description="Short statements, such as a deadline or a contact, each backed by a passage from your documents. A fact is trusted once a second person has checked it."
        actions={empty ? undefined : <ActionLink href={search}>Propose from a passage</ActionLink>}
      />
      <ErrorNotice code={error} />
      {empty ? (
        <Empty title="No facts yet" action={<ActionLink href={search}>Find a passage</ActionLink>}>
          Every fact starts from a passage in one of your documents. Find the passage, then propose
          the fact from it.
        </Empty>
      ) : (
        <section className="card" aria-labelledby="facts-heading">
          <h2 id="facts-heading" className="visually-hidden">
            Facts
          </h2>
          <ul className="list">
            {page.items.map((fact) => (
              <li key={fact.id}>
                <div>
                  <Link href={`/o/${organizationId}/knowledge/facts/${fact.id}`}>
                    {typeof fact.claim === 'string' ? fact.claim : 'Structured claim'}
                  </Link>
                  <br />
                  <small>
                    {fact.origin === 'model' ? 'Proposed by an assistant' : 'Proposed by a person'}{' '}
                    · backed by {fact.evidence.length}{' '}
                    {fact.evidence.length === 1 ? 'passage' : 'passages'}
                    {fact.evidence.some((e) => e.stale) && (
                      <> · A document has a newer version. Check the passage again.</>
                    )}
                  </small>
                </div>
                <div className="row">
                  <ClassificationBadge value={fact.classification} />
                  <StatusBadge status={fact.trustState} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {page.next && (
        <p className="link-line">
          <Link href={`?cursor=${encodeURIComponent(page.next)}`}>More facts</Link>
        </p>
      )}
    </>
  );
}
