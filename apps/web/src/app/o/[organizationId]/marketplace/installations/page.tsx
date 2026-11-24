import { listInstallations } from '@ensemus/application';
import type { InstallationFailureCode } from '@ensemus/domain/marketplace';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackLink, Empty, formatDateTime, PageHead, StatusBadge } from '@/components/ui';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';
import { MarketplaceChangeForm } from '../forms';
import { MarketplaceNavigation } from '../navigation';

export const metadata = { title: 'Marketplace installations | Ensemus' };

const FAILURES: Record<InstallationFailureCode, string> = {
  LISTING_NOT_AVAILABLE: 'The listing became unavailable.',
  ATTESTATION_INVALID: 'The listing’s review could not be confirmed.',
  SIGNATURE_INVALID: 'The package signature could not be confirmed.',
  BUNDLE_HASH_MISMATCH: 'The copied package did not match the listing.',
  BUNDLE_UNAVAILABLE: 'The package could not be downloaded.',
  NAME_TAKEN: 'A package already uses this name in your workspace.',
  VERIFICATION_REJECTED: 'The package did not pass workspace verification.',
  INSTALL_ERROR: 'Ensemus could not finish copying the package.',
};

export default async function MarketplaceInstallationsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { database, context } = await requireTenant(organizationId);
  if (!(await getSkillFeatureGate().isEnabled(context, 'marketplace'))) notFound();
  const root = `/o/${organizationId}`;
  const base = `${root}/marketplace`;
  const href = `${base}/installations`;
  const canInstall = can(context.role, 'marketplace.install');
  const rows = await listInstallations(database, context);
  return (
    <>
      <BackLink href={base}>Skills Marketplace</BackLink>
      <PageHead title="Marketplace installations" />
      <MarketplaceNavigation base={base} canPublish={can(context.role, 'marketplace.publish')} />
      {rows.length === 0 ? (
        <Empty title="No packages installed">
          Installation requests for this workspace will appear here.
        </Empty>
      ) : (
        <ul className="activity-rows" aria-label="Marketplace installations" role="list">
          {rows.map((row) => (
            <li key={row.id} className="grid min-w-0 gap-3 py-3">
              <div className="row">
                <Link href={`${base}/listings/${row.listingId}`}>{row.listingDisplayName}</Link>
                <StatusBadge status={row.state} />
              </div>
              <small className="muted">Requested {formatDateTime(row.createdAt)}</small>
              {row.failureCode && <p>{FAILURES[row.failureCode]}</p>}
              {row.skillVersionId && row.state === 'installed' && (
                <Link href={`${root}/skills/versions/${row.skillVersionId}`}>
                  Open workspace version
                </Link>
              )}
              {canInstall && row.state === 'installed' && (
                <MarketplaceChangeForm
                  organizationId={organizationId}
                  href={href}
                  operation="remove"
                  targetId={row.id}
                  version={row.version}
                  confirmation="Disable this copy and withdraw its version from use in this workspace."
                  label="Remove installation"
                  working="Removing installation"
                  destructive
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
