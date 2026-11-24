import { randomUUID } from 'node:crypto';
import { listActionConnections, listProjects } from '@ensemus/application';
import { NewWorkForm } from '@/components/new-work-form';
import { ErrorNotice, PageHead } from '@/components/ui';
import { requireTenant } from '@/server/tenant';

export const metadata = { title: 'New work | Ensemus' };

export default async function NewWorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const [projects, actionConnections] = await Promise.all([
    listProjects(database, context),
    listActionConnections(database, context),
  ]);

  return (
    <>
      <PageHead
        title="New work"
        description="Describe the outcome you want. Saving it starts nothing: it records the work, with you as its owner, and you can hand it to someone else later."
      />
      <ErrorNotice code={error} />
      <NewWorkForm
        organizationId={organizationId}
        projects={projects}
        requestKey={randomUUID()}
        canAskForReceipt={actionConnections.length > 0}
      />
    </>
  );
}
