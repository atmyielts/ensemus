import { randomUUID } from 'node:crypto';
import { listDirectory, listTeams, listWorkUnits } from '@ensemus/application';
import { getSourcePassage } from '@ensemus/application/knowledge/sources';
import Link from 'next/link';
import { KnowledgeForm } from '@/components/knowledge-form';
import { PageHead, Empty, ClassificationBadge } from '@/components/ui';
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
          action={
            <Link href={`/o/${organizationId}/knowledge/search`}>Find a supporting passage</Link>
          }
        >
          Choose a readable source passage first.
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
      <Link href={`/o/${organizationId}/knowledge/facts`}>Back to facts</Link>
      <PageHead
        title="Propose a fact"
        description="A proposal does not become trusted until a different, authorized person reviews it."
      />
      <article className="card">
        <h2>{passage.title}</h2>
        <ClassificationBadge value={passage.classification} />
        <blockquote className="pre-wrap">{passage.text}</blockquote>
      </article>
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
            name: 'subjectRef',
            kind: 'select',
            label: 'This fact is about',
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
            label: 'Fact category',
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
          {
            name: 'claim',
            kind: 'textarea',
            label: 'Claim supported by this passage',
            required: true,
            maxLength: 8000,
            help: 'Keep the claim specific. Its sensitivity is derived from the source and subject; you cannot lower it here.',
          },
        ]}
      />
    </>
  );
}
