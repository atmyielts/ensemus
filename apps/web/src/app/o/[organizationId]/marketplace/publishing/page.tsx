import { getPublisher, listSubmissions } from '@ensemus/application';
import type { ReviewFindingCode } from '@ensemus/domain/marketplace';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackLink, Empty, formatDateTime, PageHead, StatusBadge } from '@/components/ui';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';
import { MarketplaceChangeForm, PublisherRegistrationForm } from '../forms';
import { MarketplaceNavigation } from '../navigation';

export const metadata = { title: 'Marketplace publishing | Ensemus' };

const FINDINGS: Record<ReviewFindingCode, string> = {
  SIGNATURE_PROBLEM: 'Signature could not be accepted',
  LICENSE_PROBLEM: 'License problem',
  DEPENDENCY_PROBLEM: 'Dependency problem',
  EXCESSIVE_TOOLS: 'More tools requested than needed',
  EXCESSIVE_DATA_ACCESS: 'More data access requested than needed',
  HARMFUL_INSTRUCTIONS: 'Harmful instructions',
  HARMFUL_CODE: 'Harmful code',
  INADEQUATE_TESTS: 'Insufficient tests',
  MISLEADING_DESCRIPTION: 'Misleading description',
};

export default async function MarketplacePublishingPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { database, context } = await requireTenant(organizationId);
  if (!can(context.role, 'marketplace.publish')) notFound();
  if (!(await getSkillFeatureGate().isEnabled(context, 'marketplace'))) notFound();
  const base = `/o/${organizationId}/marketplace`;
  const href = `${base}/publishing`;
  const [publisher, submissions] = await Promise.all([
    getPublisher(database, context),
    listSubmissions(database, context),
  ]);
  return (
    <>
      <BackLink href={base}>Skills Marketplace</BackLink>
      <PageHead title="Marketplace publishing" />
      <MarketplaceNavigation base={base} canPublish />
      <section className="card" aria-labelledby="publisher-heading">
        <h2 id="publisher-heading">Publisher profile</h2>
        {publisher ? (
          <div className="row">
            <strong className="wrap-anywhere">{publisher.displayName}</strong>
            <StatusBadge status={publisher.state} />
          </div>
        ) : (
          <>
            <p className="muted">This name appears on listings from your workspace.</p>
            <PublisherRegistrationForm organizationId={organizationId} href={href} />
          </>
        )}
      </section>
      {publisher?.state === 'active' && (
        <p>
          <Link href={`/o/${organizationId}/skills`}>Open the skill catalog</Link> to submit a
          version.
        </p>
      )}
      <section className="activity-list" aria-labelledby="submissions-heading">
        <h2 id="submissions-heading">Submissions</h2>
        {submissions.length === 0 ? (
          <Empty title="No submissions yet">Versions sent for review will appear here.</Empty>
        ) : (
          <ul className="activity-rows" role="list">
            {submissions.map((submission) => (
              <li key={submission.id} className="grid min-w-0 gap-3 py-3">
                <div className="row">
                  <Link
                    className="wrap-anywhere"
                    href={`/o/${organizationId}/skills/versions/${submission.skillVersionId}`}
                  >
                    {submission.name} <span className="font-mono text-xs">{submission.semver}</span>
                  </Link>
                  <StatusBadge status={submission.state} />
                </div>
                <small className="muted">Submitted {formatDateTime(submission.createdAt)}</small>
                {submission.findingCodes.length > 0 && (
                  <ul aria-label="Review findings" className="list">
                    {submission.findingCodes.map((code) => (
                      <li key={code}>{FINDINGS[code]}</li>
                    ))}
                  </ul>
                )}
                {submission.delistRequestedAt && (
                  <small>Delisting requested {formatDateTime(submission.delistRequestedAt)}</small>
                )}
                {(submission.state === 'submitted' || submission.state === 'in_review') && (
                  <MarketplaceChangeForm
                    organizationId={organizationId}
                    href={href}
                    operation="withdraw"
                    targetId={submission.id}
                    version={submission.version}
                    confirmation="End review of this submission."
                    label="Withdraw submission"
                    working="Withdrawing"
                    destructive
                  />
                )}
                {submission.state === 'approved' && !submission.delistRequestedAt && (
                  <MarketplaceChangeForm
                    organizationId={organizationId}
                    href={href}
                    operation="delist"
                    targetId={submission.id}
                    version={submission.version}
                    confirmation="Ask the reviewer to take this listing down."
                    label="Request delisting"
                    working="Requesting delisting"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
