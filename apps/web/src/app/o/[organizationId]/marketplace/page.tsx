import { AppError, listListings } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionLink, BackLink, Empty, PageHead } from '@/components/ui';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';
import { MarketplaceNavigation } from './navigation';

export const metadata = { title: 'Skills Marketplace | Ensemus' };

export default async function MarketplacePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const [{ organizationId }, { cursor }] = await Promise.all([params, searchParams]);
  const { database, context } = await requireTenant(organizationId);
  const gate = getSkillFeatureGate();
  const base = `/o/${organizationId}/marketplace`;
  const enabled = await gate.isEnabled(context, 'marketplace');
  const page = enabled
    ? await listListings(database, context, gate, {
        ...(cursor && { after: cursor }),
        limit: 30,
      }).catch((error: unknown) => {
        if (error instanceof AppError && error.code === 'INVALID_INPUT') notFound();
        throw error;
      })
    : null;
  return (
    <>
      <BackLink href={`/o/${organizationId}/skills`}>Skill catalog</BackLink>
      <PageHead title="Skills Marketplace" />
      {page ? (
        <>
          <MarketplaceNavigation
            base={base}
            canPublish={can(context.role, 'marketplace.publish')}
          />
          {page.items.length === 0 ? (
            <Empty title={cursor ? 'No more listings' : 'No skills listed yet'}>
              {cursor ? (
                <Link href={base}>Back to listings</Link>
              ) : (
                'Listed skills will appear here.'
              )}
            </Empty>
          ) : (
            <ul className="activity-rows" aria-label="Skill listings" role="list">
              {page.items.map((listing) => (
                <li key={listing.id}>
                  <Link className="activity-row" href={`${base}/listings/${listing.id}`}>
                    <span className="activity-subject min-w-0">
                      <span className="activity-title wrap-anywhere">{listing.displayName}</span>
                      <small className="wrap-anywhere">By {listing.publisherDisplayName}</small>
                    </span>
                    <span className="activity-meta font-mono text-xs wrap-anywhere">
                      {listing.semver}
                    </span>
                    <ChevronRightIcon className="activity-chevron" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {page.nextCursor && (
            <p className="gap-above-large">
              <ActionLink
                href={`${base}?cursor=${encodeURIComponent(page.nextCursor)}`}
                variant="secondary"
              >
                Next page
              </ActionLink>
            </p>
          )}
        </>
      ) : (
        <Empty title="Marketplace unavailable">Marketplace is turned off for this workspace.</Empty>
      )}
    </>
  );
}
