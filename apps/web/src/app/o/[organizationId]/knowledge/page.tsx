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
  const base = `/o/${organizationId}/knowledge`;
  return (
    <>
      <PageHead
        title="Company knowledge"
        description="Sources you can use, with their current access and processing state."
        actions={
          can(context.role, 'knowledge.add') ? (
            <Link className="button" href={`${base}/new`}>
              Add a source
            </Link>
          ) : undefined
        }
      />
      <ErrorNotice code={error} />
      {!page.items.length ? (
        <Empty
          action={
            can(context.role, 'knowledge.add') ? (
              <Link href={`${base}/new`}>Add the first source</Link>
            ) : undefined
          }
        >
          No sources are available to you yet.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Knowledge sources</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Sensitivity</th>
                <th scope="col">Availability</th>
                <th scope="col">Search</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((source) => (
                <tr key={source.id}>
                  <td>
                    <Link href={`${base}/sources/${source.id}`}>
                      {source.title ?? 'Source with limited access'}
                    </Link>
                    <div className="muted">
                      {source.kind === 'connector' ? 'Connected source' : 'Uploaded file'}
                    </div>
                  </td>
                  <td>
                    <ClassificationBadge value={source.classification} />
                  </td>
                  <td>
                    <StatusBadge status={source.state} />
                    {!source.canRead && (
                      <p className="muted">Its contents are not shared with you.</p>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={source.documentState ?? 'unavailable'} />
                    {source.searchableAt && (
                      <div className="muted">Since {formatDateTime(source.searchableAt)}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.next && (
        <Link className="button secondary" href={`${base}?cursor=${encodeURIComponent(page.next)}`}>
          More sources
        </Link>
      )}
    </>
  );
}
