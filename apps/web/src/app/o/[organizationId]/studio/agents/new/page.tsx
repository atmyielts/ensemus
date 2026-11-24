import { randomUUID } from 'node:crypto';
import { getAgentDraftChoices } from '@ensemus/application/agent-drafts';
import { BackLink, PageHead } from '@/components/ui';
import { AgentForm } from '@/components/studio/agent-form';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
export const metadata = { title: 'Create assistant | Ensemus' };
export default async function NewAgentPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireStudio(organizationId),
    [choices, tools] = await Promise.all([
      studioRead(getAgentDraftChoices(database, context)),
      webProductPorts().toolCatalog.list(context),
    ]);
  return (
    <>
      <BackLink href={`/o/${organizationId}/studio/agents`}>Assistant drafts</BackLink>
      <PageHead
        title="Create assistant"
        description="Describe the help your team needs in plain words. You can change everything later, and nothing runs until it has been rehearsed and reviewed."
      />
      <AgentForm
        organizationId={organizationId}
        ownerMembershipId={context.membershipId}
        {...choices}
        tools={tools}
        requestKey={randomUUID()}
      />
    </>
  );
}
