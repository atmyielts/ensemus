import { randomUUID } from 'node:crypto';
import { listDirectory, listTeams } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { KnowledgeUploadForm } from '@/components/knowledge-upload-form';
import { PageHead, Empty } from '@/components/ui';
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
        <Empty>Your role cannot add company sources. Ask an organization administrator.</Empty>
      </>
    );
  const [people, teams] = await Promise.all([
    listDirectory(database, context),
    listTeams(database, context),
  ]);
  return (
    <>
      <Link href={`/o/${organizationId}/knowledge`}>Back to sources</Link>
      <PageHead
        title="Add a source"
        description="Add a text document. Processing happens in the background after the file is saved."
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
    </>
  );
}
