import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { getAgentDraftChoices } from '@ensemus/application/agent-drafts';
import { PageHead } from '@/components/ui';
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
      <Link href={`/o/${organizationId}/studio/agents`}>Back to assistant drafts</Link>
      <PageHead
        title="Create assistant"
        description="Describe a useful result in plain words. You will rehearse and review it before publishing."
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
