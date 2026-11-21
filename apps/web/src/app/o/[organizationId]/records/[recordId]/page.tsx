import { randomUUID } from 'node:crypto';
import { streamRuleFor } from '@ensemus/domain/business-connector';
import { BusinessProposalForm } from '@/components/business-proposal-form';
import { getRuntime } from '@/server/runtime';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getBusinessRecord, idSchema, listBusinessRecordReviewers } from '@ensemus/application';
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
  const enabled = getRuntime().config.connectorsEnabled;
  const fields = Object.entries(streamRuleFor(row.stream)?.fields ?? {})
    .filter(([, rule]) => rule.writable)
    .map(([name]) => name);
  const reviewers =
    enabled && row.classification !== 'restricted'
      ? await listBusinessRecordReviewers(database, context, row.id)
      : [];
  const proposal = {
    organizationId,
    recordId: row.id,
    sourceVersion: row.externalVersion,
    fields,
    reviewers,
    title: 'Review a source change',
  };
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
      {row.classification === 'restricted' ? (
        <p>Restricted source records cannot be proposed as external changes.</p>
      ) : !enabled ? (
        <p>Connected actions are turned off. You can read the stored source record here.</p>
      ) : reviewers.length === 0 ? (
        <p>
          No independent reviewer with source access is available. Ask an administrator to arrange
          source access for a reviewer before proposing a change.
        </p>
      ) : (
        <>
          {fields.length > 0 && row.externalVersion !== null && (
            <BusinessProposalForm {...proposal} requestKey={randomUUID()} kind="update" />
          )}
          {fields.length > 0 && row.externalVersion === null && (
            <p>
              The source did not provide a record version, so field changes must be made in the
              source system.
            </p>
          )}
          {row.stream === 'ticketing.tickets' && (
            <BusinessProposalForm {...proposal} requestKey={randomUUID()} kind="note" />
          )}
          {row.stream.startsWith('accounting.') && (
            <BusinessProposalForm {...proposal} requestKey={randomUUID()} kind="invoice" />
          )}
          {fields.length === 0 &&
            !row.stream.startsWith('accounting.') &&
            row.stream !== 'ticketing.tickets' && (
              <p>This source record has no fields that can be changed here.</p>
            )}
        </>
      )}
    </div>
  );
}
