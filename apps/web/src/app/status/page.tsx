import Link from 'next/link';
import { getStatusPage, type StatusPage } from '@ensemus/application/saas/status';
import { Empty, PageHead, Wordmark, formatDateTime } from '@/components/ui';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Service status | Ensemus' };
const origins = {
  ensemus: 'Ensemus',
  model_provider: 'Model provider',
  connector_provider: 'Connected service provider',
  unknown: 'Cause not yet confirmed',
};
const states = {
  investigating: 'Investigating',
  identified: 'Cause identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};
const headlines = {
  operational: 'No open published incidents',
  provider_degraded: 'A provider is experiencing problems',
  degraded: 'Ensemus is experiencing problems',
  unknown: 'Status not fully confirmed',
};
export default async function Status() {
  let page: StatusPage;
  try {
    page = await getStatusPage(getRuntime().app, { limit: 20 });
  } catch {
    page = { overall: 'unknown', open: [], recent: [], updates: [] };
  }
  const history = (incidents: StatusPage['open']) => (
    <ul className="list">
      {incidents.map((incident) => (
        <li key={incident.id}>
          <article className="stack" aria-labelledby={`incident-${incident.id}`}>
            <div>
              <h3 id={`incident-${incident.id}`}>{incident.title}</h3>
              <p>
                {origins[incident.origin]} · {states[incident.state]} · {incident.severity} severity
              </p>
              <p>
                Started{' '}
                <time dateTime={incident.startedAt.toISOString()}>
                  {formatDateTime(incident.startedAt)}
                </time>
                {incident.resolvedAt && (
                  <>
                    {' '}
                    · Resolved{' '}
                    <time dateTime={incident.resolvedAt.toISOString()}>
                      {formatDateTime(incident.resolvedAt)}
                    </time>
                  </>
                )}
              </p>
            </div>
            <ol className="list">
              {page.updates
                .filter((update) => update.incidentId === incident.id)
                .map((update, index) => (
                  <li key={`${update.occurredAt.toISOString()}-${index}`}>
                    <p className="pre-wrap">{update.message}</p>
                    <p>
                      <time dateTime={update.occurredAt.toISOString()}>
                        {formatDateTime(update.occurredAt)}
                      </time>{' '}
                      · {states[update.state as keyof typeof states] ?? update.state}
                    </p>
                  </li>
                ))}
            </ol>
          </article>
        </li>
      ))}
    </ul>
  );
  return (
    <main className="centered">
      <Wordmark />
      <div className="sheet stack">
        <PageHead
          title="Service status"
          description="Published service incidents and updates. Provider incidents identify whose service is affected."
          actions={<Link href="/security">Security and reporting</Link>}
        />
        <section className="stack" aria-labelledby="current-status">
          <h2 id="current-status">{headlines[page.overall]}</h2>
          {page.overall === 'unknown' && page.open.length === 0 ? (
            <p role="status">
              We could not confirm the current status. Refresh this page to try again.
            </p>
          ) : (
            <p>
              This view reflects published incidents. It does not measure uptime or guarantee
              availability.
            </p>
          )}
          {page.open.length > 0 && history(page.open)}
        </section>
        <section className="stack" aria-labelledby="recent-incidents">
          <h2 id="recent-incidents">Recently resolved</h2>
          {page.recent.length ? (
            history(page.recent)
          ) : (
            <Empty>No resolved incidents to show.</Empty>
          )}
        </section>
        <nav className="row" aria-label="Status links">
          <Link href="/status">Refresh status</Link>
          <Link href="/">Your organizations</Link>
        </nav>
      </div>
    </main>
  );
}
