import { Fragment } from 'react';
import { ResourceRefresh } from '@/components/resource-refresh';
import { getPurgeStatus } from '@ensemus/application/knowledge/purge';
import Link from 'next/link';
import { PageHead, StatusBadge, formatDateTime } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Source removal | Ensemus' };
export default async function PurgePage({
  params,
}: {
  params: Promise<{ organizationId: string; sourceId: string }>;
}) {
  const { organizationId, sourceId } = await params,
    { context, database } = await requireTenant(organizationId),
    job = await orNotFound(getPurgeStatus(database, context, sourceId));
  return (
    <>
      <Link href={`/o/${organizationId}/knowledge`}>Back to sources</Link>
      <PageHead
        title="Source removal"
        description="The source is closed. These counts record removals that the workers have confirmed."
      />
      <div>
        <StatusBadge status={job.state} />
      </div>
      <ResourceRefresh active={['pending', 'running'].includes(job.state)} />
      <p className="notice">
        {job.state === 'completed'
          ? 'The worker confirmed removal of the source projections, related transcripts and generated files for this source. Retained audit records contain IDs and hashes.'
          : job.heldArtifacts
            ? 'Some generated files are on hold. Removal cannot be confirmed while those holds apply.'
            : job.retryExhausted
              ? 'Automatic repair has reached its limit. An administrator needs to investigate; the source remains closed.'
              : 'Removal is still being checked. Unknown writes, storage failures or unavailable workers prevent a completed result.'}
      </p>
      <dl className="facts">
        {Object.entries(job.counts).map(([name, count]) => (
          <Fragment key={name}>
            <dt>
              {(
                {
                  documents: 'Documents',
                  chunks: 'Source passages',
                  embeddings: 'Search vectors',
                  facts: 'Facts removed or invalidated',
                  answers: 'Answers',
                  blobs: 'Source files',
                  transcripts: 'Run transcripts',
                  artifacts: 'Generated files',
                } as Record<string, string>
              )[name] ?? name}
            </dt>
            <dd>{count}</dd>
          </Fragment>
        ))}
        <dt>Files on hold</dt>
        <dd>{job.heldArtifacts}</dd>
        <dt>Requested</dt>
        <dd>{formatDateTime(job.requestedAt)}</dd>
        {job.completedAt && (
          <>
            <dt>Confirmed</dt>
            <dd>{formatDateTime(job.completedAt)}</dd>
          </>
        )}
        {job.nextRetryAt && (
          <>
            <dt>Next scheduled check</dt>
            <dd>{formatDateTime(job.nextRetryAt)}</dd>
          </>
        )}
      </dl>
      {job.lastErrorCode && (
        <details>
          <summary>Removal details</summary>
          <p>{job.lastErrorCode}</p>
        </details>
      )}
      <Link
        className="button secondary"
        href={`/o/${organizationId}/knowledge/sources/${sourceId}/purge`}
      >
        Check progress
      </Link>
    </>
  );
}
