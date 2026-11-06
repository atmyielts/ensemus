import { ResourceRefresh } from '@/components/resource-refresh';
import { getClientOnboarding } from '@ensemus/application/knowledge/onboarding';
import Link from 'next/link';
import { costLabel } from '@/components/knowledge-view';
import { PageHead, StatusBadge, formatDateTime } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Client onboarding progress | Ensemus' };
export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ organizationId: string; onboardingId: string }>;
}) {
  const { organizationId, onboardingId } = await params,
    { context, database } = await requireTenant(organizationId),
    row = await orNotFound(getClientOnboarding(database, context, onboardingId)),
    base = `/o/${organizationId}`;
  return (
    <>
      <Link href={`${base}/work/${row.workUnitId}`}>Open onboarding work</Link>
      <PageHead title="Client onboarding" description={`Deal ${row.dealRef}`} />
      <div>
        <StatusBadge status={row.state} />
      </div>
      <ResourceRefresh active={!['completed', 'failed', 'unknown'].includes(row.state)} />
      <p className="notice">
        {row.state === 'waiting_for_acceptance'
          ? 'The brief is ready for the named reviewer. Read the exact file and its supporting passages, then accept or reject it.'
          : row.state === 'waiting_for_send'
            ? 'The exact welcome message needs its named approver. A provider receipt must confirm sending before this onboarding can finish.'
            : row.state === 'unknown'
              ? 'Email delivery could not be confirmed. It has not been automatically sent again. Check the email action and its receipt before deciding what to do.'
              : row.state === 'completed'
                ? 'The reviewed brief and a confirmed email receipt are recorded.'
                : row.state === 'failed'
                  ? 'Onboarding stopped before it could be completed. Open its work to inspect the current state.'
                  : 'The background workflow is preparing the onboarding work.'}
      </p>
      <ol>
        {row.briefWorkUnitId && (
          <li>
            <Link href={`${base}/work/${row.briefWorkUnitId}`}>Prepare and review the brief</Link>
            {row.briefArtifactId && (
              <>
                {' '}
                ·{' '}
                <Link
                  href={`${base}/work/${row.briefWorkUnitId}/artifacts/${row.briefArtifactId}/verification`}
                >
                  Review the brief and sources
                </Link>
              </>
            )}
          </li>
        )}
        {row.reviewWorkUnitId && (
          <li>
            <Link href={`${base}/work/${row.reviewWorkUnitId}`}>Confirm the reviewed outcome</Link>
          </li>
        )}
        {row.sendWorkUnitId && (
          <li>
            <Link href={`${base}/work/${row.sendWorkUnitId}`}>Welcome email and receipt</Link>
          </li>
        )}
      </ol>
      <dl className="facts">
        <dt>Measured model cost</dt>
        <dd>{costLabel(row.costMicros)}</dd>
        <dt>Started</dt>
        <dd>{formatDateTime(row.createdAt)}</dd>
        {row.finishedAt && (
          <>
            <dt>Finished</dt>
            <dd>{formatDateTime(row.finishedAt)}</dd>
          </>
        )}
        <dt>Email receipt</dt>
        <dd>
          {row.receipt
            ? row.receipt.status === 'sent' &&
              ['provider', 'reconciliation'].includes(row.receipt.basis)
              ? 'Sending confirmed by provider evidence'
              : row.receipt.status === 'unknown'
                ? 'Delivery not confirmed'
                : 'No confirmed sending receipt'
            : 'Not recorded yet'}
        </dd>
      </dl>
      {row.stateCode && (
        <details>
          <summary>Progress details</summary>
          <p>{row.stateCode}</p>
          {row.receipt && (
            <p>
              Receipt basis: {row.receipt.basis}
              {row.receipt.externalId ? ` · Reference ${row.receipt.externalId}` : ''}
            </p>
          )}
        </details>
      )}
      <Link className="button secondary" href={`${base}/onboarding/${onboardingId}`}>
        Check progress
      </Link>
    </>
  );
}
