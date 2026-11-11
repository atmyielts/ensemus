import { randomUUID } from 'node:crypto';
import { listDirectory, listTeams, listWorkUnits } from '@ensemus/application';
import { getSourcePassage } from '@ensemus/application/knowledge/sources';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { PageHead, Empty, ClassificationBadge, ActionLink, BackLink } from '@/components/ui';
import { proposeKnowledgeFactAction } from '@/server/knowledge-actions';
import { requireTenant } from '@/server/tenant';
import { knowledgeOrNotFound as orNotFound } from '@/server/knowledge-page';
export const metadata = { title: 'Propose a fact | Ensemus' };
export default async function NewFactPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ chunk?: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId),
    { chunk } = await searchParams;
  if (!chunk)
    return (
      <>
        <PageHead title="Propose a fact" />
        <Empty
          title="Start from a passage"
          action={
            <ActionLink href={`/o/${organizationId}/knowledge/search`}>Find a passage</ActionLink>
          }
        >
          A fact has to be backed by a passage from one of your documents. Find the passage first,
          then propose the fact from it.
        </Empty>
      </>
    );
  const passage = await orNotFound(getSourcePassage(database, context, chunk)),
    [people, teams, work] = await Promise.all([
      listDirectory(database, context),
      listTeams(database, context),
      listWorkUnits(database, context),
    ]);
  return (
    <>
      <div>
        <BackLink href={`/o/${organizationId}/knowledge/facts`}>Back to facts</BackLink>
        <PageHead
          title="Propose a fact"
          description="Write down one thing this passage says. It becomes a trusted fact once someone else has checked it against the passage."
        />
      </div>
      <section className="card citation" aria-labelledby="passage-heading">
        <h2 id="passage-heading">The passage</h2>
        <blockquote className="pre-wrap">{passage.text}</blockquote>
        <footer className="row">
          <span className="muted">
            From{' '}
            <Link href={`/o/${organizationId}/knowledge/sources/${passage.sourceId}`}>
              {passage.title}
            </Link>
          </span>
          <ClassificationBadge value={passage.classification} />
        </footer>
      </section>
      <KnowledgeForm
        action={proposeKnowledgeFactAction}
        hidden={{
          organizationId,
          requestKey: randomUUID(),
          chunkId: passage.chunkId,
          quoteEnd: String(passage.text.length),
        }}
        submit="Propose fact"
        fields={[
          {
            name: 'claim',
            kind: 'textarea',
            label: 'The fact, in your own words',
            required: true,
            maxLength: 8000,
            rows: 4,
            help: 'Keep it to one specific statement. Who can see it follows the document and what it is about, so it can only be as open as they are.',
          },
          {
            name: 'subjectRef',
            kind: 'select',
            label: 'What it is about',
            required: true,
            value: `knowledge_source:${passage.sourceId}`,
            options: [
              { value: `knowledge_source:${passage.sourceId}`, label: `Source: ${passage.title}` },
              ...work.items.map((w) => ({ value: `work_unit:${w.id}`, label: `Work: ${w.title}` })),
              ...people
                .filter((p) => p.status === 'active')
                .map((p) => ({
                  value: `membership:${p.membershipId}`,
                  label: `Person: ${p.name}`,
                })),
              ...teams.map((t) => ({ value: `team:${t.id}`, label: `Team: ${t.name}` })),
            ],
          },
          {
            name: 'predicate',
            kind: 'select',
            label: 'Kind of fact',
            required: true,
            value: 'summary',
            options: [
              { value: 'summary', label: 'Summary' },
              { value: 'deadline', label: 'Deadline' },
              { value: 'contact', label: 'Contact' },
              { value: 'requirement', label: 'Requirement' },
              { value: 'status', label: 'Status' },
            ],
          },
        ]}
      />
    </>
  );
}
