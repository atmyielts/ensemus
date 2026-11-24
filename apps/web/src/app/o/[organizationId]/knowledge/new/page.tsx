import { randomUUID } from 'node:crypto';
import { listDirectory, listTeams } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { KnowledgeUploadForm } from '@/components/knowledge-upload-form';
import { PageHead, Empty, BackLink } from '@/components/ui';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Add a source | Ensemus' };
export default async function NewSourcePage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId);
  if (!can(context.role, 'knowledge.add'))
    return (
      <>
        <PageHead title="Add a source" />
        <Empty title="Adding documents is not part of your role">
          Ask an administrator in your organization to add the document for you.
        </Empty>
      </>
    );
  const [people, teams] = await Promise.all([
    listDirectory(database, context),
    listTeams(database, context),
  ]);
  return (
    <div>
      <BackLink href={`/o/${organizationId}/knowledge`}>Back to sources</BackLink>
      <PageHead
        title="Add a source"
        description="Upload a document your team relies on. Ensemus reads it in the background, and then you can search it and ask questions about it."
      />
      <KnowledgeUploadForm
        organizationId={organizationId}
        requestKey={randomUUID()}
        people={people
          .filter(
            (person) => person.status === 'active' && person.membershipId !== context.membershipId,
          )
          .map((person) => ({ membershipId: person.membershipId, name: person.name }))}
        teams={teams.map((team) => ({ id: team.id, name: team.name }))}
      />
    </div>
  );
}
