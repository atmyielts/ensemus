import { randomUUID } from 'node:crypto';
import {
  getPublisher,
  getSandboxStatus,
  getSkillPackage,
  getSkillVersionReview,
  idSchema,
  listSubmissions,
} from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { sandboxAcceptsClassification } from '@ensemus/domain/sandbox';
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
import { getSandboxCeilings, getSkillFeatureGate } from '@/server/skill-runtime';
import { SandboxTrialForm } from '../../../sandbox/trial-form';
import { MarketplaceChangeForm } from '../../../marketplace/forms';
import { SkillReleaseForm } from './release-form';

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
  const { version, uploadedByViewer } = await orNotFound(
    getSkillVersionReview(database, context, id.data),
  );
  const pkg = await orNotFound(getSkillPackage(database, context, version.packageId));
  const test = version.latestTest;
  const root = `/o/${organizationId}`;
  const gate = getSkillFeatureGate();
  const canTrial = version.executionKind === 'sandbox' && can(context.role, 'sandbox.run');
  const sandboxStatus = canTrial
    ? await getSandboxStatus(database, context, {
        enabled: await gate.isEnabled(context, 'sandbox'),
        ceilings: getSandboxCeilings(),
      })
    : null;
  const maximum = version.maxClassification;
  const trialClassifications = maximum
    ? (['public', 'internal', 'confidential'] as const).filter((value) =>
        sandboxAcceptsClassification(value, maximum),
      )
    : [];
  const canQueueTrial =
    pkg.state === 'active' &&
    (version.state === 'verified' || version.state === 'published') &&
    trialClassifications.length > 0;
  const canReview = version.state === 'verified' && can(context.role, 'skill.publish');
  const catalogEnabled = canReview && (await gate.isEnabled(context, 'skill_catalog'));
  const canPublish = catalogEnabled && !uploadedByViewer && pkg.state === 'active';
  const canYank =
    (version.state === 'verified' || version.state === 'published') &&
    can(context.role, 'skill.manage');
  const maySubmit =
    can(context.role, 'marketplace.publish') &&
    pkg.origin === 'tenant' &&
    pkg.state === 'active' &&
    pkg.contentClassification === 'public' &&
    (version.state === 'verified' || version.state === 'published') &&
    !!version.license &&
    version.license !== 'LicenseRef-Proprietary-Tenant' &&
    (await gate.isEnabled(context, 'marketplace'));
  const [publisher, submissions] = maySubmit
    ? await Promise.all([getPublisher(database, context), listSubmissions(database, context)])
    : [null, []];
  const existing = submissions.find(
    (submission) =>
      submission.skillVersionId === version.id &&
      (submission.state === 'submitted' ||
        submission.state === 'in_review' ||
        submission.state === 'approved'),
  );
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
        {version.publishedAt && <small>Published {formatDateTime(version.publishedAt)}</small>}
        {version.yankCode && <p>{withdrawalReason(version.yankCode)}</p>}
        {version.license && (
          <dl className="grid min-w-0 gap-2 text-sm">
            <div>
              <dt className="muted">License</dt>
              <dd>{version.license}</dd>
            </div>
            {version.signerKeyId && (
              <div>
                <dt className="muted">Signer fingerprint</dt>
                <dd className="wrap-anywhere font-mono">{version.signerKeyId}</dd>
              </div>
            )}
          </dl>
        )}
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
      {sandboxStatus && (
        <section className="card" aria-labelledby="skill-sandbox-trial">
          <h2 id="skill-sandbox-trial">Sandbox trial</h2>
          {!sandboxStatus.enabled ? (
            <p>Sandbox trials are disabled for this workspace.</p>
          ) : !canQueueTrial ? (
            <p>Trials require an active package and a verified skill version.</p>
          ) : (
            <SandboxTrialForm
              organizationId={organizationId}
              skillVersionId={version.id}
              requestToken={randomUUID()}
              classifications={trialClassifications}
            />
          )}
          <small className="text-muted-foreground">
            {sandboxStatus.lastProbePassedAt
              ? `Limits on this server were last checked at ${formatDateTime(sandboxStatus.lastProbePassedAt)}.`
              : 'No run has checked the limits on this server yet.'}{' '}
            Independent review is pending.
          </small>
        </section>
      )}
      {(canReview || canYank) && (
        <section className="card" aria-labelledby="skill-version-release">
          <h2 id="skill-version-release">Release</h2>
          {canReview && !catalogEnabled && <p>Publishing is unavailable for this workspace.</p>}
          {catalogEnabled && uploadedByViewer && (
            <p>Ask another workspace admin to publish this version.</p>
          )}
          {catalogEnabled && !uploadedByViewer && pkg.state !== 'active' && (
            <p>Enable the package before publishing this version.</p>
          )}
          <SkillReleaseForm
            organizationId={organizationId}
            skillVersionId={version.id}
            version={version.version}
            canPublish={canPublish}
            canYank={canYank}
          />
        </section>
      )}
      {maySubmit && (
        <section className="card" aria-labelledby="skill-marketplace">
          <h2 id="skill-marketplace">Marketplace</h2>
          {existing ? (
            <div className="row">
              <StatusBadge status={existing.state} />
              <a href={`${root}/marketplace/publishing`}>View submissions</a>
            </div>
          ) : publisher?.state === 'active' ? (
            <MarketplaceChangeForm
              organizationId={organizationId}
              href={`${root}/skills/versions/${version.id}`}
              operation="submit"
              targetId={version.id}
              confirmation="Other organizations on this deployment will be able to see this package if it is listed."
              label="Submit for review"
              working="Submitting for review"
            />
          ) : (
            <a href={`${root}/marketplace/publishing`}>
              {publisher ? 'View publisher status' : 'Set up your publisher profile'}
            </a>
          )}
        </section>
      )}
    </>
  );
}

function withdrawalReason(code: string) {
  switch (code) {
    case 'SIGNER_REVOKED':
      return 'The publisher key was revoked.';
    case 'LISTING_REVOKED':
      return 'The marketplace listing was revoked.';
    case 'SECURITY_ISSUE':
      return 'Withdrawn because of a security issue.';
    default:
      return 'Withdrawn by the workspace.';
  }
}
