import type { AdvisoryView } from '@ensemus/application';
import type { AdvisorySeverity } from '@ensemus/domain/license';
import { Empty, formatDate } from './ui';

const SEVERITY: Record<AdvisorySeverity, { label: string; tone: string }> = {
  low: { label: 'Low', tone: '' },
  moderate: { label: 'Moderate', tone: 'attention' },
  high: { label: 'High', tone: 'bad' },
  critical: { label: 'Critical', tone: 'bad' },
};

function affected(advisory: AdvisoryView) {
  if (advisory.affectsThisRelease === null) {
    return 'This deployment does not know which release it runs, so compare the versions below yourself.';
  }
  return advisory.affectsThisRelease
    ? 'This advisory names the release running here.'
    : 'This advisory does not name the release running here.';
}

/** Security advisories that verified. They arrive as signed files, since this page checks nothing online. */
export function LicenseAdvisories({ advisories }: { advisories: readonly AdvisoryView[] }) {
  return (
    <section className="panel" aria-labelledby="license-advisories">
      <h2 id="license-advisories">Security advisories</h2>
      {advisories.length === 0 ? (
        <Empty>
          No advisories are installed. An advisory arrives as a signed file, and an owner installs
          it below.
        </Empty>
      ) : (
        <ul className="list">
          {advisories.map((advisory) => {
            const severity = SEVERITY[advisory.severity];
            return (
              <li key={advisory.advisoryId} className="block">
                <div className="row">
                  <strong>{advisory.title}</strong>
                  <span className={`badge ${severity.tone}`}>{severity.label}</span>
                  {advisory.testKey && <span className="badge attention">Test key</span>}
                </div>
                <p className="pre-wrap">{advisory.summary}</p>
                <p className="muted">{affected(advisory)}</p>
                <dl>
                  <dt>Advisory</dt>
                  <dd>{advisory.advisoryId}</dd>
                  <dt>Issued</dt>
                  <dd>{formatDate(advisory.issuedAt)}</dd>
                  <dt>Affected versions</dt>
                  <dd>{advisory.affectedVersions.join(', ') || 'None listed'}</dd>
                  <dt>Fixed in</dt>
                  <dd>{advisory.fixedInVersions.join(', ') || 'None listed'}</dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
