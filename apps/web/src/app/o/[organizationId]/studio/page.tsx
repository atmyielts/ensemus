import { listAgentRegistry } from '@ensemus/application/ai-agents';
import { can } from '@ensemus/domain/policy';
import { canProduct } from '@ensemus/domain/product-policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionLink, DestinationList, Empty, PageHead, formatDateTime } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'Automation Studio | Ensemus' };

/** The path every assistant and workflow takes, in the order a builder meets it. */
const PATH = [
  ['Draft', 'Describe what it should do, what it may see and the limits it keeps.'],
  ['Rehearse', 'Try it on made-up examples. Nothing real is sent or changed.'],
  ['Review', 'A colleague reads exactly what you built and approves it.'],
  ['Publish', 'Your team can use it. Later edits never change a version in use.'],
] as const;

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
  const author = canProduct(context.role, 'studio.author');
  return (
    <>
      <PageHead
        title="Automation Studio"
        description="Build assistants and workflows that take routine work off your team. Everything starts as a draft, and nothing reaches your team until a colleague has checked it."
        actions={
          author || can(context.role, 'agent.publish') ? (
            <>
              {author && (
                <ActionLink href={`${base}/studio/workflows/new`} variant="secondary">
                  Create workflow
                </ActionLink>
              )}
              {can(context.role, 'agent.publish') && (
                <ActionLink href={`${base}/studio/agents/new`}>Create assistant</ActionLink>
              )}
            </>
          ) : undefined
        }
      />
      <section className="card" aria-labelledby="studio-path">
        <h2 id="studio-path">From idea to everyday use</h2>
        <ol className="studio-path">
          {PATH.map(([step, text]) => (
            <li key={step}>
              <strong>{step}</strong>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </section>
      {author && (
        <section className="settings-section" aria-labelledby="studio-build">
          <div className="section-intro">
            <h2 id="studio-build">Build and review</h2>
            <p>Pick up a draft, check what is waiting for review, or start a workflow.</p>
          </div>
          <DestinationList
            label="Build and review"
            items={[
              {
                href: `${base}/studio/agents`,
                label: 'Assistant drafts',
                description: 'Say what an assistant helps with, what it may see and its limits.',
                icon: 'assistants',
              },
              {
                href: `${base}/studio/workflows`,
                label: 'Workflow drafts',
                description: 'Lay out the steps, people and checks that finish a process.',
                icon: 'work',
              },
              {
                href: `${base}/studio/reviews`,
                label: 'Publication reviews',
                description: 'Read what a colleague built, approve it and publish it.',
                icon: 'approvals',
              },
              {
                href: `${base}/studio/runs`,
                label: 'Workflow runs',
                description: 'Start a published workflow and follow each step.',
                icon: 'arrow',
              },
            ]}
          />
        </section>
      )}
      <section className="card settings-section" aria-labelledby="studio-assistants">
        <div className="section-heading">
          <div>
            <h2 id="studio-assistants">Published assistants</h2>
            <p>
              A published version never changes. Work already under way keeps the version it started
              with.
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
                <ActionLink href={`${base}/studio/agents/new`} variant="secondary">
                  Create your first assistant
                </ActionLink>
              ) : undefined
            }
          >
            Start with a draft. Once it has been rehearsed and approved, it appears here for your
            team.
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
                <span className="badge done">Published</span>
              </li>
            ))}
          </ul>
        )}
        <p className="studio-next-step">
          To use an assistant, open a piece of <Link href={`${base}/work`}>work</Link> and start one
          from there.
        </p>
      </section>
      <section className="settings-section" aria-labelledby="studio-controls">
        <div className="section-intro">
          <h2 id="studio-controls">Before assistants run</h2>
          <p>Choose which AI models may be used and how much each run may spend.</p>
        </div>
        <DestinationList
          label="Before assistants run"
          items={[
            ...(canProduct(context.role, 'pack.manage')
              ? [
                  {
                    href: `${base}/packs`,
                    label: 'Packs',
                    description: 'Ready-made record types and drafts for a department.',
                    icon: 'records' as const,
                  },
                ]
              : []),
            ...(can(context.role, 'model.manage') || can(context.role, 'model.activate')
              ? [
                  {
                    href: `${base}/settings/models`,
                    label: 'Models',
                    description: 'Choose the AI models allowed to read company information.',
                    icon: 'models' as const,
                  },
                ]
              : []),
            ...(can(context.role, 'usage.view')
              ? [
                  {
                    href: `${base}/settings/budgets`,
                    label: 'Budgets and usage',
                    description: 'See what has been spent and set clear spending limits.',
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
