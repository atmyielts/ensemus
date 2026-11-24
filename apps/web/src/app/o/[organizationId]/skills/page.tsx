import { AppError, listSkillPackages } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionLink, ClassificationBadge, Empty, PageHead, StatusBadge } from '@/components/ui';
import { getSkillFeatureGate } from '@/server/skill-runtime';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Skill catalog | Ensemus' };

export default async function SkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const [{ organizationId }, { cursor }] = await Promise.all([params, searchParams]);
  const { database, context } = await requireTenant(organizationId);
  const base = `/o/${organizationId}`;
  const manage = can(context.role, 'skill.manage');
  const gate = getSkillFeatureGate();
  const [page, canCreate, marketplaceEnabled] = await Promise.all([
    listSkillPackages(database, context, cursor === undefined ? {} : { after: cursor }).catch(
      (error) => {
        if (error instanceof AppError && error.code === 'INVALID_INPUT') notFound();
        throw error;
      },
    ),
    manage && gate.isEnabled(context, 'skill_catalog'),
    gate.isEnabled(context, 'marketplace'),
  ]);
  return (
    <>
      <PageHead
        title="Skill catalog"
        actions={
          <>
            {marketplaceEnabled && (
              <ActionLink href={`${base}/marketplace`} variant="secondary">
                Marketplace
              </ActionLink>
            )}
            {manage && (
              <ActionLink href={`${base}/settings/skills/signers`} variant="secondary">
                Publisher keys
              </ActionLink>
            )}
            {canCreate && <ActionLink href={`${base}/skills/new`}>New package</ActionLink>}
          </>
        }
      />
      {page.items.length === 0 ? (
        <Empty title={cursor ? 'No more packages' : 'No skill packages yet'}>
          {cursor ? (
            <Link href={`${base}/skills`}>Back to the catalog</Link>
          ) : canCreate ? (
            'Create a package to give a skill a name in this workspace.'
          ) : manage ? (
            'Package creation is disabled for this workspace.'
          ) : (
            'Packages added by your workspace administrators will appear here.'
          )}
        </Empty>
      ) : (
        <section className="activity-list" aria-label="Skill packages">
          <ul className="activity-rows" role="list">
            {page.items.map((pkg) => (
              <li key={pkg.id}>
                <Link className="activity-row" href={`${base}/skills/${pkg.id}`}>
                  <span className="activity-subject">
                    <span className="activity-title">{pkg.displayName}</span>
                    <small className="font-mono">{pkg.name}</small>
                  </span>
                  <span className="activity-meta">
                    <StatusBadge status={pkg.state} />
                    <ClassificationBadge value={pkg.contentClassification} />
                  </span>
                  <ChevronRightIcon className="activity-chevron" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {page.nextCursor && (
        <p className="gap-above-large">
          <ActionLink
            variant="secondary"
            href={`${base}/skills?cursor=${encodeURIComponent(page.nextCursor)}`}
          >
            Next page
          </ActionLink>
        </p>
      )}
    </>
  );
}
