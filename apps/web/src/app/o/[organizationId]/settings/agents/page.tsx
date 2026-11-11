import { getAgentPolicyVersion, listAgentRegistry } from '@ensemus/application/ai-agents';
import { can } from '@ensemus/domain/policy';
import { ActionLink, BackLink, Empty, formatDateTime, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
import { PublishForm } from './publish-form';

export const metadata = { title: 'Assistant versions | Ensemus' };

const DESCRIPTION =
  'Every published version of every assistant. A version never changes once published: new work uses the one marked here, and work already under way keeps the version it started with.';

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
        <PageHead title="Assistant versions" />
        <Empty title="Only owners and administrators can see this">
          Owners and administrators manage assistant versions here. Ask one of them if you need a
          change.
        </Empty>
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
      <PageHead title="Assistant versions" description={DESCRIPTION} />
      <section className="card" aria-labelledby="published-heading">
        <h2 id="published-heading">Published versions</h2>
        {versions.length === 0 ? (
          <Empty
            title="No assistant has been published yet"
            action={
              canPublish ? (
                <ActionLink href={`/o/${organizationId}/studio/agents/new`} variant="secondary">
                  Create an assistant
                </ActionLink>
              ) : undefined
            }
          >
            Build one in Automation Studio. Once it has been reviewed and published, each version
            appears here.
          </Empty>
        ) : (
          <ul className="list">
            {versions.map((version) => (
              <li key={version.versionId} className="block">
                <div className="spread">
                  <strong>
                    {version.name}, version {version.versionNumber}
                  </strong>
                  {version.active && <span className="badge active">Used for new runs</span>}
                </div>
                <small>Published {formatDateTime(version.publishedAt)}</small>
                <details className="gap-above-small">
                  <summary>Technical details</summary>
                  <p className="technical-reference">SHA-256: {version.specSha256}</p>
                  <p className="technical-reference">Policy version: {version.policyVersion}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
      {canPublish && (
        <section className="card settings-section" aria-labelledby="publish-heading">
          <h2 id="publish-heading">Publish from a manifest (advanced)</h2>
          <p className="muted">
            Most assistants are built and published in Automation Studio. This is for an assistant
            defined as a JSON manifest, with a passing evaluation report for that exact manifest
            under policy version <strong>{policyVersion}</strong>, the one in force now.
          </p>
          <PublishForm organizationId={context.organizationId} />
        </section>
      )}
    </>
  );
}
