import {
  getListing,
  getMarketplaceListingReview,
  idSchema,
  listInstallations,
} from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import {
  ActionLink,
  BackLink,
  ClassificationBadge,
  formatDateTime,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { orNotFound, requireTenant } from '@/server/tenant';
import { MarketplaceChangeForm } from '../../forms';

export const metadata = { title: 'Marketplace listing | Ensemus' };

export default async function MarketplaceListingPage({
  params,
}: {
  params: Promise<{ organizationId: string; listingId: string }>;
}) {
  const { organizationId, listingId } = await params;
  const id = idSchema.safeParse(listingId);
  if (!id.success) notFound();
  const { database, context } = await requireTenant(organizationId);
  const gate = getSkillFeatureGate();
  if (!(await gate.isEnabled(context, 'marketplace'))) notFound();
  const base = `/o/${organizationId}/marketplace`;
  const canInstall = can(context.role, 'marketplace.install');
  const [listing, review, installations] = await Promise.all([
    orNotFound(getListing(database, context, gate, id.data)),
    orNotFound(getMarketplaceListingReview(database, context, id.data)),
    canInstall ? listInstallations(database, context) : [],
  ]);
  const installed = installations.find(
    (entry) =>
      entry.listingId === listing.id && entry.state !== 'failed' && entry.state !== 'removed',
  );
  return (
    <>
      <BackLink href={base}>Skills Marketplace</BackLink>
      <PageHead
        title={listing.displayName}
        description={`Published by ${listing.publisherDisplayName}`}
      />
      <section className="card min-w-0" aria-labelledby="listing-details">
        <h2 id="listing-details">Package details</h2>
        <p className="wrap-anywhere">{listing.summary}</p>
        <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="muted">Package and version</dt>
            <dd className="wrap-anywhere font-mono">
              {listing.name} {listing.semver}
            </dd>
          </div>
          <div>
            <dt className="muted">License</dt>
            <dd className="wrap-anywhere">{listing.license}</dd>
          </div>
          <div>
            <dt className="muted">Highest declared data classification</dt>
            <dd>
              <ClassificationBadge value={listing.maxClassification} />
            </dd>
          </div>
          <div>
            <dt className="muted">Execution type</dt>
            <dd>{listing.executionKind === 'declarative' ? 'Declarative' : 'Code package'}</dd>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <dt className="muted">Package fingerprint</dt>
            <dd className="wrap-anywhere font-mono">{listing.digest}</dd>
          </div>
        </dl>
        {listing.toolBoundaries.length > 0 && (
          <>
            <h3>Declared tools</h3>
            <ul className="list">
              {Array.from(new Set(listing.toolBoundaries)).map((tool) => (
                <li key={tool} className="wrap-anywhere">
                  {tool}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted wrap-anywhere">
          Reviewed by {review.reviewerLabel} on {formatDateTime(review.decidedAt)}
        </p>
      </section>
      <section className="card" aria-labelledby="install-package">
        <h2 id="install-package">Workspace installation</h2>
        {installed ? (
          <div className="row">
            <StatusBadge status={installed.state} />
            <ActionLink href={`${base}/installations`} variant="secondary">
              View installations
            </ActionLink>
          </div>
        ) : listing.state === 'delisted' ? (
          <p>This listing is no longer offered.</p>
        ) : canInstall ? (
          <MarketplaceChangeForm
            organizationId={organizationId}
            href={`${base}/listings/${listing.id}`}
            operation="install"
            targetId={listing.id}
            confirmation="This copies the package here and grants it nothing. Someone in your organization still has to publish it."
            label="Install package"
            working="Requesting installation"
          />
        ) : (
          <p>Ask a workspace administrator to install this package.</p>
        )}
      </section>
    </>
  );
}
