import { getSkillPackage, getSkillVersion, idSchema } from '@ensemus/application';
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

export const metadata = { title: 'Skill version | Ensemus' };

export default async function SkillVersionPage({
  params,
}: {
  params: Promise<{ organizationId: string; skillVersionId: string }>;
}) {
  const { organizationId, skillVersionId } = await params;
  const id = idSchema.safeParse(skillVersionId);
  if (!id.success) notFound();
  const { database, context } = await requireTenant(organizationId);
  const version = await orNotFound(getSkillVersion(database, context, id.data));
  const pkg = await orNotFound(getSkillPackage(database, context, version.packageId));
  const test = version.latestTest;
  return (
    <>
      <BackLink href={`/o/${organizationId}/skills/${pkg.id}`}>{pkg.displayName}</BackLink>
      <PageHead title={version.semver ? `Version ${version.semver}` : 'Uploaded bundle'} />
      <section className="card" aria-labelledby="verification-status">
        <h2 id="verification-status">Verification</h2>
        <div className="row">
          <StatusBadge status={version.state === 'uploaded' ? 'queued' : version.state} />
          {version.maxClassification && <ClassificationBadge value={version.maxClassification} />}
        </div>
        {version.rejectCode && <p>{verificationError(version.rejectCode)}</p>}
        {test && (
          <p>
            {test.fixturesPassed} of {test.fixturesTotal} {test.mode} fixtures passed.
          </p>
        )}
        <small>Uploaded {formatDateTime(version.uploadedAt)}</small>
      </section>
      {version.toolBoundaries.length > 0 && (
        <section className="card" aria-labelledby="declared-tools">
          <h2 id="declared-tools">Declared tools</h2>
          <ul className="list" role="list">
            {Array.from(new Set(version.toolBoundaries)).map((tool) => (
              <li key={tool} className="wrap-anywhere">
                {tool}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
