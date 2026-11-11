import { AppError } from '@ensemus/application';
import { listSources } from '@ensemus/application/knowledge/sources';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import {
  PageHead,
  Empty,
  ErrorNotice,
  ClassificationBadge,
  StatusBadge,
  ActionLink,
  formatDateTime,
} from '@/components/ui';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Knowledge | Ensemus' };
export default async function KnowledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string; error?: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId),
    query = await searchParams;
  let error = query.error;
  const page = await listSources(database, context, {
    ...(query.cursor ? { after: query.cursor } : {}),
  }).catch((failure: unknown) => {
    if (!(failure instanceof AppError) || failure.code !== 'INVALID_INPUT') throw failure;
    error = 'INVALID_INPUT';
    return listSources(database, context, {});
  });
  const base = `/o/${organizationId}/knowledge`,
    canAdd = can(context.role, 'knowledge.add'),
    empty = !page.items.length;
  return (
    <>
      <PageHead
        title="Company knowledge"
        description="The documents your team relies on. Find a passage in them, or ask a question and see exactly where the answer came from."
        actions={
          canAdd && !empty ? <ActionLink href={`${base}/new`}>Add a source</ActionLink> : undefined
        }
      />
      <ErrorNotice code={error} />
      {empty ? (
        <Empty
          title="Your company library is empty"
          action={canAdd ? <ActionLink href={`${base}/new`}>Add a source</ActionLink> : undefined}
        >
          {canAdd
            ? 'Add documents your team relies on, and you can search them and ask questions about them here.'
            : 'When someone shares documents with you, you can search them and ask questions about them here.'}
        </Empty>
      ) : (
        <section className="card" aria-labelledby="sources-heading">
          <h2 id="sources-heading" className="visually-hidden">
            Knowledge sources
          </h2>
          <ul className="list">
            {page.items.map((source) => (
              <li key={source.id}>
                <div>
                  <Link href={`${base}/sources/${source.id}`}>
                    {source.title ?? 'Source with limited access'}
                  </Link>
                  <br />
                  <small>
                    {source.kind === 'connector' ? 'Connected source' : 'Uploaded file'}
                    {source.searchableAt && (
                      <> · searchable since {formatDateTime(source.searchableAt)}</>
                    )}
                    {!source.canRead && <> · Its contents are not shared with you.</>}
                  </small>
                </div>
                <div className="row">
                  <ClassificationBadge value={source.classification} />
                  <StatusBadge
                    status={
                      source.state === 'active'
                        ? (source.documentState ?? 'unavailable')
                        : source.state
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {page.next && (
        <p>
          <Link
            className="button secondary"
            href={`${base}?cursor=${encodeURIComponent(page.next)}`}
          >
            More sources
          </Link>
        </p>
      )}
    </>
  );
}
