import { randomUUID } from 'node:crypto';
import { BackLink, PageHead } from '@/components/ui';
import { WorkflowDetailsForm } from '@/components/studio/workflow-forms';
import { requireStudio } from '@/server/studio-pages';
export const metadata = { title: 'Create workflow | Ensemus' };
export default async function NewWorkflowPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params;
  await requireStudio(organizationId);
  return (
    <>
      <BackLink href={`/o/${organizationId}/studio/workflows`}>Workflow drafts</BackLink>
      <PageHead
        title="Create a workflow"
        description="Start with a name and who can see it. Next you add the steps: work for people, approvals and checks."
      />
      <WorkflowDetailsForm organizationId={organizationId} requestKey={randomUUID()} />
    </>
  );
}
