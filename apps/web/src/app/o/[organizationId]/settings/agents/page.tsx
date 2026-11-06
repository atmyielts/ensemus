import { getAgentPolicyVersion, listAgentRegistry } from '@ensemus/application/ai-agents';
import { can } from '@ensemus/domain/policy';
import { BackLink, Empty, formatDateTime, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { PublishForm } from './publish-form';

export const metadata = { title: 'Agents | Ensemus' };

const DESCRIPTION =
  'Each published version is fixed. New runs use the version marked here, and a run already going keeps the one it started on.';

export default async function AgentsPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { context, database } = await requireTenant(organizationId);
  const canPublish = can(context.role, 'agent.publish');

  if (!canPublish && !can(context.role, 'agent.run')) {
    return (
      <>
        <PageHead title="Agents" />
        <Empty>Owners and admins manage agents here. Ask one of them if you need a change.</Empty>
      </>
    );
  }

  const [versions, policyVersion] = await Promise.all([
    listAgentRegistry(database, context),
    getAgentPolicyVersion(database, context),
  ]);

  return (
    <>
      <BackLink href={`/o/${organizationId}/studio`}>Automation Studio</BackLink>
      <PageHead title="Agents" description={DESCRIPTION} />
      <section className="card" aria-labelledby="published-heading">
        <h2 id="published-heading">Published versions</h2>
        {versions.length === 0 ? (
          <Empty>No agent has been published yet.</Empty>
        ) : (
          <ul className="list">
            {versions.map((version) => (
              <li key={version.versionId} className="block">
                <strong>
                  {version.name}, version {version.versionNumber}
                </strong>{' '}
                {version.active && <span className="badge active">Used for new runs</span>}
                <br />
                <small>
                  Published {formatDateTime(version.publishedAt)}, under policy{' '}
                  {version.policyVersion}.
                </small>
                <details className="gap-above-small">
                  <summary>Version details</summary>
                  <p className="technical-reference">SHA-256: {version.specSha256}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
      {canPublish && (
        <section className="card gap-above" aria-labelledby="publish-heading">
          <h2 id="publish-heading">Publish a version</h2>
          <p>
            The report has to pass, and name this manifest&apos;s SHA-256 and policy version{' '}
            <strong>{policyVersion}</strong>, which is the one in force now.
          </p>
          <PublishForm organizationId={context.organizationId} />
        </section>
      )}
    </>
  );
}
