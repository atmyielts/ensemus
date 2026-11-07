import { listAgentRegistry } from '@ensemus/application/ai-agents';
import { can } from '@ensemus/domain/policy';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionLink, DestinationList, Empty, PageHead, formatDateTime } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Automation Studio | Ensemus' };

export default async function StudioPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  const { context, database } = await requireTenant(organizationId);
  if (!can(context.role, 'agent.publish') && !can(context.role, 'agent.run')) notFound();
  const versions = await listAgentRegistry(database, context);
  const base = `/o/${organizationId}`;
  const active = versions.filter((version) => version.active);
  return (
    <>
      <PageHead
        title="Automation Studio"
        description="Build and publish the assistants your team can use on work."
        actions={
          can(context.role, 'agent.publish') ? (
            <ActionLink href={`${base}/settings/agents#publish-heading`}>
              Publish an assistant
            </ActionLink>
          ) : undefined
        }
      />
      <section className="card" aria-labelledby="studio-assistants">
        <div className="section-heading">
          <div>
            <h2 id="studio-assistants">Published assistants</h2>
            <p className="muted">
              A published version stays fixed. Running work keeps the version it started with.
            </p>
          </div>
          <Link href={`${base}/settings/agents`}>
            Version history <span aria-hidden="true">→</span>
          </Link>
        </div>
        {active.length === 0 ? (
          <Empty
            title="No assistants published yet"
            action={
              can(context.role, 'agent.publish') ? (
                <Link href={`${base}/settings/agents#publish-heading`}>
                  Publish your first version
                </Link>
              ) : undefined
            }
          >
            Publish a version with a passing evaluation before your team starts using it.
          </Empty>
        ) : (
          <ul className="list">
            {active.map((version) => (
              <li key={version.versionId}>
                <span>
                  <strong>{version.name}</strong>
                  <br />
                  <small>
                    Version {version.versionNumber} · Published{' '}
                    {formatDateTime(version.publishedAt)}
                  </small>
                </span>
                <span className="badge done">Ready for new work</span>
              </li>
            ))}
          </ul>
        )}
        <p className="studio-next-step">
          To use an assistant, open a piece of <Link href={`${base}/work`}>work</Link> and choose
          its agent run.
        </p>
      </section>
      <section className="settings-section" aria-labelledby="studio-controls">
        <div className="section-intro">
          <h2 id="studio-controls">Prepare assistants to run</h2>
          <p>Choose approved models and spending limits before starting work.</p>
        </div>
        <DestinationList
          label="Assistant preparation"
          items={[
            ...(canProduct(context.role, 'pack.manage')
              ? [
                  {
                    href: `${base}/packs`,
                    label: 'Packs',
                    description: 'Review packaged workflows and the access they request.',
                    icon: 'studio' as const,
                  },
                ]
              : []),
            ...(can(context.role, 'model.manage') || can(context.role, 'model.activate')
              ? [
                  {
                    href: `${base}/settings/models`,
                    label: 'Models',
                    description: 'Choose the models allowed to receive company information.',
                    icon: 'models' as const,
                  },
                ]
              : []),
            ...(can(context.role, 'usage.view')
              ? [
                  {
                    href: `${base}/settings/budgets`,
                    label: 'Budgets and usage',
                    description: 'Review usage and make the spending limits explicit.',
                    icon: 'usage' as const,
                  },
                ]
              : []),
          ]}
        />
      </section>
    </>
  );
}
