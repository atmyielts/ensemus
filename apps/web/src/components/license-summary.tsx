import type { LicenseStatusView, LicenseView } from '@ensemus/application';
import type { UpdateRights } from '@ensemus/domain/license';
import { Empty, formatDate } from './ui';
import { STANDING_WORDS, SUPPORT_WORDS } from './license-notice-list';

const shown = (value: number | null) => (value === null ? 'Not stated' : String(value));

const updateRightWords = (rights: UpdateRights): readonly [string, string][] => [
  [
    'Security patches after maintenance ends',
    rights.security_patches_after_lapse === 'licensed_line'
      ? 'Included on the licensed line'
      : 'Not included',
  ],
  [
    'New major versions',
    rights.major_versions_with_maintenance === 'included'
      ? 'Included while maintained'
      : 'A separate purchase',
  ],
  [
    'Releases published while maintained',
    rights.releases_published_during_maintenance === 'kept_after_lapse'
      ? 'Can still be installed after maintenance ends'
      : 'Can be installed only while maintained',
  ],
  [
    'Installing a release outside these rights',
    rights.outside_rights_on_install === 'refuse'
      ? 'The install tool refuses it. Nothing already running changes'
      : 'The install tool asks you to confirm. Nothing already running changes',
  ],
];

function LicenseFacts({ license }: { license: LicenseView }) {
  return (
    <dl>
      <dt>Licensee</dt>
      <dd>{license.licensee.displayName}</dd>
      <dt>Contract reference</dt>
      <dd>{license.licensee.contractReference}</dd>
      <dt>License ID</dt>
      <dd>{license.licenseId}</dd>
      <dt>Term</dt>
      <dd>
        {license.term.kind === 'pilot'
          ? `Pilot, with a review on ${license.term.review_on}`
          : 'Perpetual, for the licensed version'}
      </dd>
      <dt>Licensed version</dt>
      <dd>
        {license.licensedRelease.version} (line {license.licensedRelease.line})
      </dd>
      <dt>Issued</dt>
      <dd>{formatDate(license.issuedAt)}</dd>
      <dt>Signed by</dt>
      <dd>{license.keyIds.join(', ')}</dd>
      <dt>Components</dt>
      <dd>{license.components.join(', ') || 'Not stated'}</dd>
    </dl>
  );
}

/** The whole standing, in words. Reading it changes nothing, and nothing else in the product reads it. */
export function LicenseSummary({ status }: { status: LicenseStatusView }) {
  const { license, maintenance, runningRelease } = status;
  return (
    <>
      <section className="card" aria-labelledby="license-standing">
        <h2 id="license-standing">License</h2>
        <p>{STANDING_WORDS[status.standing]}</p>
        {license ? (
          <LicenseFacts license={license} />
        ) : (
          <Empty>There is no license to show here yet.</Empty>
        )}
      </section>

      <section className="card" aria-labelledby="license-support">
        <h2 id="license-support">Support and maintenance</h2>
        <p>{SUPPORT_WORDS[maintenance.status]}</p>
        <dl>
          <dt>Last day covered</dt>
          <dd>{maintenance.lastCoveredOn ?? 'None installed'}</dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="license-release">
        <h2 id="license-release">This deployment</h2>
        {runningRelease ? (
          <dl>
            <dt>Running release</dt>
            <dd>{runningRelease.version}</dd>
            <dt>Within this license&apos;s update rights</dt>
            <dd>
              {runningRelease.verdict === null
                ? 'Not known'
                : runningRelease.verdict.covered
                  ? 'Yes'
                  : 'No. It keeps running'}
            </dd>
          </dl>
        ) : (
          <p className="muted">
            This deployment has no signed bundle manifest it can verify, so the release it runs is
            not shown here.
          </p>
        )}
      </section>

      {license && (
        <section className="card" aria-labelledby="license-footprint">
          <h2 id="license-footprint">What the license states</h2>
          <p className="muted">
            These come from the signed license. They are shown for your records, and nothing here is
            enforced.
          </p>
          <dl>
            <dt>Seats</dt>
            <dd>
              {shown(license.footprint.seats)} stated, {status.seatsInUse} in use
            </dd>
            <dt>Organizations</dt>
            <dd>{shown(license.footprint.organizations)}</dd>
            <dt>Production deployments</dt>
            <dd>{shown(license.footprint.production_deployments)}</dd>
            <dt>Other deployments</dt>
            <dd>{shown(license.footprint.nonproduction_deployments)}</dd>
            {updateRightWords(license.updateRights).map(([label, value]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </>
  );
}
