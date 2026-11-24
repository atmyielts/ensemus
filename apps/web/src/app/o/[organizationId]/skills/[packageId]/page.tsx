import { getSkillPackage, idSchema, listSkillVersions } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { notFound } from 'next/navigation';
import {
  BackLink,
  ClassificationBadge,
  formatDateTime,
  PageHead,
  StatusBadge,
} from '@/components/ui';
import { verificationError } from '@/lib/skill-version-copy';
import { orNotFound, requireTenant } from '@/server/tenant';
import Link from 'next/link';
import { SkillPackageForm } from '../skill-package-form';

export const metadata = { title: 'Skill package | Ensemus' };

export default async function SkillPackagePage({
  params,
}: {
  params: Promise<{ organizationId: string; packageId: string }>;
}) {
  const { organizationId, packageId } = await params;
  const id = idSchema.safeParse(packageId);
  if (!id.success) notFound();
  const { database, context } = await requireTenant(organizationId);
  const pkg = await orNotFound(getSkillPackage(database, context, id.data));
  const versions = await orNotFound(listSkillVersions(database, context, pkg.id));
  return (
    <>
      <BackLink href={`/o/${organizationId}/skills`}>Skill catalog</BackLink>
      <PageHead
        title={pkg.displayName}
        description={<code className="font-mono wrap-anywhere">{pkg.name}</code>}
      />
      <section className="card" aria-label="Package status">
        <div className="row">
          <StatusBadge status={pkg.state} />
          <ClassificationBadge value={pkg.contentClassification} />
          <small>{pkg.origin === 'marketplace' ? 'From marketplace' : 'Workspace package'}</small>
        </div>
      </section>
      <section className="card" aria-labelledby="skill-package-versions">
        <h2 id="skill-package-versions">Versions</h2>
        {versions.length ? (
          <ul className="list" role="list">
            {versions.map((entry) => (
              <li key={entry.id}>
                <div className="min-w-0">
                  <Link href={`/o/${organizationId}/skills/versions/${entry.id}`}>
                    {entry.semver ? `Version ${entry.semver}` : 'Uploaded bundle'}
                  </Link>
                  <br />
                  <small>{formatDateTime(entry.uploadedAt)}</small>
                  {entry.rejectCode && (
                    <p className="muted">{verificationError(entry.rejectCode)}</p>
                  )}
                </div>
                <div className="row">
                  {entry.latestTest && (
                    <small>
                      {entry.latestTest.fixturesPassed} of {entry.latestTest.fixturesTotal} fixtures
                      passed
                    </small>
                  )}
                  <StatusBadge status={entry.state === 'uploaded' ? 'queued' : entry.state} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No versions have been recorded for this package.</p>
        )}
      </section>
      {can(context.role, 'skill.manage') && (
        <section className="card" aria-labelledby="package-settings">
          <h2 id="package-settings">Package settings</h2>
          <SkillPackageForm organizationId={organizationId} pkg={pkg} />
        </section>
      )}
    </>
  );
}
