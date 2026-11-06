import { randomUUID } from 'node:crypto';
import { listProjects } from '@ensemus/application';
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
  const projects = await listProjects(database, context);

  return (
    <>
      <PageHead title="New work" description="Describe the outcome you want." />
      <ErrorNotice code={error} />
      <p className="notice form-width">
        Nothing runs until someone starts it. Creating this only records the outcome, with you as
        the accountable owner. You can hand it to someone else later.
      </p>
      <NewWorkForm organizationId={organizationId} projects={projects} requestKey={randomUUID()} />
    </>
  );
}
