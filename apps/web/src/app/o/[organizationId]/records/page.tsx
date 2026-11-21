import Link from 'next/link';
import { AppError, listBusinessRecords, type BusinessRecordList } from '@ensemus/application';
import { PageHead, Empty, ClassificationBadge, ErrorNotice } from '@/components/ui';
import { LocalTime } from '@/components/local-time';
import { sourceStreamLabels } from '@/components/source-record-fields';
import { requireTenant } from '@/server/tenant';
import { businessRecordQuery } from '@/server/business-record-api';
export const metadata = { title: 'Source records | Ensemus' };
export default async function SourceRecordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireTenant(organizationId),
    raw = await searchParams;
  const query = businessRecordQuery.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== '')),
  );
  let result: BusinessRecordList | null = null,
    error: string | undefined;
  if (!query.success) error = 'INVALID_INPUT';
  else {
    const q = query.data;
    try {
      result = await listBusinessRecords(database, context, {
        ...(q.connection_id ? { connectionId: q.connection_id } : {}),
        ...(q.stream ? { stream: q.stream } : {}),
        ...(q.cursor ? { after: q.cursor } : {}),
      });
    } catch (e) {
      if (e instanceof AppError && e.code === 'INVALID_INPUT') error = e.code;
      else throw e;
    }
  }
  const base = `/o/${organizationId}/records`,
    q = query.success ? query.data : {};
  const next = new URLSearchParams({
    ...(q.connection_id ? { connection_id: q.connection_id } : {}),
    ...(q.stream ? { stream: q.stream } : {}),
    cursor: result?.nextCursor ?? '',
  });
  return (
    <div className="stack">
      <PageHead
        title="Source records"
        description="Selected fields last read from your connected systems. Your source's permissions decide what you can see here."
      />
      <form method="get" className="card stack" action={base}>
        <label htmlFor="record-stream">Record kind</label>
        <select id="record-stream" name="stream" defaultValue={q.stream ?? ''}>
          <option value="">All record kinds</option>
          {Object.entries(sourceStreamLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {q.connection_id ? (
          <input type="hidden" name="connection_id" value={q.connection_id} />
        ) : null}
        <div className="row">
          <button type="submit">Apply filter</button>
          <Link href={base}>Clear filters</Link>
        </div>
      </form>
      <ErrorNotice code={error} />
      {result?.items.length ? (
        <section className="card" aria-labelledby="source-records-heading">
          <h2 id="source-records-heading">Records you can read</h2>
          <ul className="list">
            {result.items.map((row) => (
              <li key={row.id}>
                <div>
                  <Link href={`${base}/${row.id}`}>
                    {row.displayName ?? 'Untitled source record'}
                  </Link>
                  <p>
                    {row.connectionDisplayName} · {sourceStreamLabels[row.stream] ?? row.stream}
                  </p>
                  <small>
                    Last read <LocalTime iso={row.updatedAt.toISOString()} />
                  </small>
                </div>
                <ClassificationBadge value={row.classification} />
              </li>
            ))}
          </ul>
        </section>
      ) : result ? (
        <Empty title="No source records to show">
          This view includes only selected records with a current source grant for you or your team.
          An administrator's role does not add access. Connector setup and sync must be available
          before records can appear.
        </Empty>
      ) : null}
      {result?.nextCursor ? (
        <Link className="button secondary" href={`${base}?${next}`}>
          Next records
        </Link>
      ) : null}
    </div>
  );
}
