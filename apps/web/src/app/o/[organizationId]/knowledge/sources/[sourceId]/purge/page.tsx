import { ResourceRefresh } from '@/components/resource-refresh';
import { getPurgeStatus } from '@ensemus/application/knowledge/purge';
import Link from 'next/link';
import { PageHead, StatusBadge, BackLink, formatDateTime } from '@/components/ui';
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
      <div>
        <BackLink href={`/o/${organizationId}/knowledge`}>Back to sources</BackLink>
        <PageHead
          title="Source removal"
          description="Nobody can read this document any more. Below is what has been confirmed removed so far."
        />
      </div>
      <p className="row">
        <StatusBadge status={job.state} />
      </p>
      <ResourceRefresh active={['pending', 'running'].includes(job.state)} />
      <p className={job.state === 'completed' ? 'notice good' : 'notice'}>
        {job.state === 'completed'
          ? 'The worker confirmed removal of the source projections, related transcripts, generated files and copied work for this source. Retained audit records contain IDs and hashes.'
          : job.priorCompletedAt !== null
            ? 'Verification is required again for copied work and run closures. Earlier confirmed removal counts are retained; any unknown work or control proof still prevents completion.'
            : job.counts.unprovenWorkUnits !== null && job.counts.unprovenWorkUnits > 0
              ? 'Some older delegated work still needs an administrator to verify its removal. The source remains closed.'
              : job.heldArtifacts
                ? 'Some generated files are on hold. Removal cannot be confirmed while those holds apply.'
                : job.retryExhausted
                  ? 'Automatic repair has reached its limit. An administrator needs to investigate; the source remains closed.'
                  : 'Removal is still being checked. Unknown writes, storage failures or unavailable workers prevent a completed result.'}
      </p>
      <section className="card" aria-labelledby="removal-heading">
        <h2 id="removal-heading">What has been removed</h2>
        <dl className="details">
          {Object.entries(job.counts).map(([name, count]) => (
            <div key={name}>
              <dt>
                {(
                  {
                    documents: 'Documents',
                    chunks: 'Source passages',
                    embeddings: 'Search vectors',
                    facts: 'Facts removed or invalidated',
                    answers: 'Answers',
                    blobs: 'Source files',
                    blobsAbsent: 'Source files already gone before removal',
                    transcripts: 'Run transcripts',
                    artifacts: 'Generated files',
                    workUnits: 'Copied work redacted',
                    workUnitsRemaining: 'Copied work awaiting removal',
                    workControlProofsRemaining: 'Run closures awaiting confirmation',
                    unprovenWorkUnits: 'Older delegated work awaiting verification',
                  } as Record<string, string>
                )[name] ?? name}
              </dt>
              <dd>{count === null ? 'Not yet confirmed' : count}</dd>
            </div>
          ))}
          <div>
            <dt>Files on hold</dt>
            <dd>{job.heldArtifacts}</dd>
          </div>
          <div>
            <dt>Requested</dt>
            <dd>{formatDateTime(job.requestedAt)}</dd>
          </div>
          {job.priorCompletedAt && (
            <div>
              <dt>Earlier source verification</dt>
              <dd>{formatDateTime(job.priorCompletedAt)}</dd>
            </div>
          )}
          {job.completedAt && (
            <div>
              <dt>Confirmed</dt>
              <dd>{formatDateTime(job.completedAt)}</dd>
            </div>
          )}
          {job.nextRetryAt && (
            <div>
              <dt>Next scheduled check</dt>
              <dd>{formatDateTime(job.nextRetryAt)}</dd>
            </div>
          )}
        </dl>
      </section>
      {job.lastErrorCode && (
        <details>
          <summary>Technical details</summary>
          <p className="technical-reference">{job.lastErrorCode}</p>
        </details>
      )}
      <p>
        <Link
          className="button secondary"
          href={`/o/${organizationId}/knowledge/sources/${sourceId}/purge`}
        >
          Check progress
        </Link>
      </p>
    </>
  );
}
