import { listRetentionRules, listRetentionRuns } from '@ensemus/application/saas/retention';
import { BackLink, Empty, formatDateTime, PageHead } from '@/components/ui';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
import { RetentionRuleForm } from './rule-form';
export const metadata = { title: 'Retention | Ensemus' };
export default async function RetentionPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireAccountTenant(organizationId);
  const [rules, runs] = await Promise.all([
    orNotFound(listRetentionRules(database, context, {})),
    orNotFound(listRetentionRuns(database, context)),
  ]);
  const outcomes: Record<string, string> = {
    RETENTION_COMPLETED: 'Page completed',
    RETENTION_HELD: 'Held records preserved',
    RETAINED_BY_OTHER_MECHANISM: 'Retained by another mechanism',
    RETAINED_INDEFINITELY: 'Retained indefinitely',
    RETENTION_SOURCE_NOT_WIRED: 'Source is not connected',
    RETENTION_SOURCE_NOT_PAGED: 'Source needs safe paging',
    RETENTION_SOURCE_FAILED: 'Sweep needs attention',
  };
  return (
    <div className="stack">
      <BackLink href={`/o/${organizationId}/account`}>Account</BackLink>
      <PageHead
        title="Data retention"
        description="Retention periods come from your approved policies. With no matching rule, records are kept."
      />
      <section className="stack" aria-labelledby="current-retention">
        <h2 id="current-retention">Current rules</h2>
        {rules.length === 0 ? (
          <Empty>
            No retention rules have been set. Nothing is automatically deleted by a retention sweep.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <caption>Approved retention rules</caption>
              <thead>
                <tr>
                  <th scope="col">Data category</th>
                  <th scope="col">Classification</th>
                  <th scope="col">Keep for</th>
                  <th scope="col">Sign-off</th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <th scope="row">{rule.dataCategory.replaceAll('_', ' ')}</th>
                    <td>
                      {rule.classification === '*' ? 'Other classifications' : rule.classification}
                    </td>
                    <td>{rule.retainDays === null ? 'Indefinitely' : `${rule.retainDays} days`}</td>
                    <td>{rule.basisRef}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card stack" aria-labelledby="set-retention">
        <h2 id="set-retention">Set a rule</h2>
        <RetentionRuleForm organizationId={organizationId} />
      </section>
      <section className="stack" aria-labelledby="retention-history">
        <h2 id="retention-history">Recent sweeps</h2>
        {runs.length === 0 ? (
          <Empty>No retention sweep has been recorded.</Empty>
        ) : (
          <ul className="list">
            {runs.map((run) => (
              <li key={run.id}>
                <div>
                  <strong>{run.dataCategory.replaceAll('_', ' ')}</strong>
                  <p>
                    {outcomes[run.outcomeCode ?? ''] ?? 'In progress'}. {run.removed} records
                    removed, {run.held} held.
                  </p>
                  <p className="muted">
                    {run.finishedAt ? formatDateTime(run.finishedAt) : 'Not finished'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Record removal blocks access and queues stored bytes for the normal verified purge
          process. A sweep does not override legal holds.
        </p>
      </section>
    </div>
  );
}
