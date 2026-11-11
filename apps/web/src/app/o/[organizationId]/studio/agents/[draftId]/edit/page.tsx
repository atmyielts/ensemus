import { randomUUID } from 'node:crypto';
import { getAgentDraft, getAgentDraftChoices } from '@ensemus/application/agent-drafts';
import { ActionLink, BackLink, Empty, PageHead } from '@/components/ui';
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
      <BackLink href={`/o/${organizationId}/studio/agents/${draft.id}`}>{draft.name}</BackLink>
      <PageHead
        title="Edit assistant draft"
        description="Saving changes closes any open review, so it will need a new rehearsal. Published versions and work already under way stay as they are."
      />
      {draft.status === 'archived' ? (
        <Empty
          title="This draft is archived"
          action={
            <ActionLink href={`/o/${organizationId}/studio/agents/new`} variant="secondary">
              Create a new assistant
            </ActionLink>
          }
        >
          An archived draft can be read but not changed.
        </Empty>
      ) : draft.agentDefinitionId &&
        !choices.people.some((p) => p.id === draft.ownerMembershipId) ? (
        <Empty
          title="The responsible person is no longer active"
          action={
            <ActionLink href={`/o/${organizationId}/studio/agents/new`} variant="secondary">
              Create a separate assistant
            </ActionLink>
          }
        >
          A published assistant keeps its responsible person. To hand it to someone else, create a
          separate assistant.
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
