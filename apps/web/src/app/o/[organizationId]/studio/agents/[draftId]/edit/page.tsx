import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { getAgentDraft, getAgentDraftChoices } from '@ensemus/application/agent-drafts';
import { Empty, PageHead } from '@/components/ui';
import { AgentForm } from '@/components/studio/agent-form';
import { requireStudio, studioRead } from '@/server/studio-pages';
import { webProductPorts } from '@/server/product-ports';
export const metadata = { title: 'Edit assistant draft | Ensemus' };
export default async function EditAgentPage({
  params,
}: {
  params: Promise<{ organizationId: string; draftId: string }>;
}) {
  const { organizationId, draftId } = await params,
    { database, context } = await requireStudio(organizationId),
    draft = await studioRead(getAgentDraft(database, context, draftId)),
    [choices, tools] = await Promise.all([
      studioRead(
        getAgentDraftChoices(
          database,
          context,
          draft.ownerMembershipId,
          draft.answers.knowledgeSourceIds,
        ),
      ),
      webProductPorts().toolCatalog.list(context),
    ]);
  return (
    <>
      <Link href={`/o/${organizationId}/studio/agents/${draft.id}`}>Back to {draft.name}</Link>
      <PageHead
        title="Edit assistant draft"
        description="Changing its purpose or limits cancels open reviews. Published and running versions stay fixed."
      />
      {draft.status === 'archived' ? (
        <Empty>This draft is archived.</Empty>
      ) : draft.agentDefinitionId &&
        !choices.people.some((p) => p.id === draft.ownerMembershipId) ? (
        <Empty>
          The responsible person is no longer active. Create a separate assistant to choose someone
          else.
        </Empty>
      ) : (
        <AgentForm
          organizationId={organizationId}
          draft={draft}
          ownerMembershipId={context.membershipId}
          {...choices}
          tools={tools}
          requestKey={randomUUID()}
        />
      )}
    </>
  );
}
