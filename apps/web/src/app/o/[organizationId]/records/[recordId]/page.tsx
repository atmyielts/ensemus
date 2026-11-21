import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getBusinessRecord, idSchema } from '@ensemus/application';
import { PageHead, ClassificationBadge } from '@/components/ui';
import { LocalTime } from '@/components/local-time';
import { sourceStreamLabels, SourceRecordFields } from '@/components/source-record-fields';
import { requireTenant, orNotFound } from '@/server/tenant';
export const metadata = { title: 'Source record | Ensemus' };
export default async function SourceRecordPage({
  params,
}: {
  params: Promise<{ organizationId: string; recordId: string }>;
}) {
  const { organizationId, recordId } = await params,
    { database, context } = await requireTenant(organizationId),
    parsed = idSchema.safeParse(recordId);
  if (!parsed.success) notFound();
  const row = await orNotFound(getBusinessRecord(database, context, parsed.data));
  return (
    <div className="stack">
      <PageHead
        title={row.displayName ?? 'Untitled source record'}
        description={`${row.connectionDisplayName} · ${sourceStreamLabels[row.stream] ?? row.stream}`}
        actions={<Link href={`/o/${organizationId}/records`}>Source records</Link>}
      />
      <section className="card stack" aria-labelledby="source-snapshot-heading">
        <h2 id="source-snapshot-heading">Last read from the source</h2>
        <div>
          <ClassificationBadge value={row.classification} />
        </div>
        <p>
          Last read <LocalTime iso={row.updatedAt.toISOString()} />. This is a stored copy; check
          the connected system for its latest state.
        </p>
        <dl className="details source-record-fields">
          <div>
            <dt>Source reference</dt>
            <dd>{row.externalId}</dd>
          </div>
          <div>
            <dt>Source version</dt>
            <dd>{row.externalVersion ?? 'Not provided by the source'}</dd>
          </div>
        </dl>
        <SourceRecordFields fields={row.fields} />
      </section>
      <p>
        Changes cannot be proposed from this view yet.
        {row.stream.startsWith('accounting.')
          ? ' Accounting values are read only here. Nothing on this page posts an invoice or moves money.'
          : ''}
      </p>
    </div>
  );
}
