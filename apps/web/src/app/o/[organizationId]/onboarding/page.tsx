import { randomUUID } from 'node:crypto';
import { listDirectory } from '@ensemus/application';
import { listConnections } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { KnowledgeForm } from '@/components/knowledge-form';
import { PageHead, Empty } from '@/components/ui';
import { startKnowledgeOnboardingAction } from '@/server/knowledge-actions';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Start client onboarding | Ensemus' };
export default async function StartOnboardingPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  const { organizationId } = await params,
    { context, database } = await requireTenant(organizationId);
  if (!can(context.role, 'client_onboarding.start'))
    return (
      <>
        <PageHead title="Client onboarding" />
        <Empty>Your role cannot start client onboarding. Ask an organization administrator.</Empty>
      </>
    );
  const [directory, connections] = await Promise.all([
      listDirectory(database, context),
      listConnections(database, context),
    ]),
    people = directory
      .filter((p) => p.status === 'active')
      .map((p) => ({ value: p.membershipId, label: p.name })),
    email = connections.filter((c) => c.state === 'active' && c.connectorType === 'email_smtp'),
    connectorsEnabled = getRuntime().config.connectorsEnabled;
  return (
    <>
      <PageHead
        title="Start client onboarding"
        description="Create the project and its work, prepare a brief, and request a separate person's review before any welcome email."
      />
      {!connectorsEnabled && (
        <p className="notice warn flush">
          Connectors are not turned on for this deployment, so the welcome email could never be sent
          and onboarding cannot start. An operator turns them on.
        </p>
      )}
      {!email.length ? (
        <Empty>
          No active email connection is available. An administrator needs to configure one before
          onboarding can start.
        </Empty>
      ) : (
        <KnowledgeForm
          action={startKnowledgeOnboardingAction}
          hidden={{ organizationId, requestKey: randomUUID() }}
          submit="Start onboarding"
          description="The reviewer must differ from you and the accountable owner. Contact details stay in this organization's records. The welcome email still needs approval of its exact recipient and message."
          fields={[
            {
              name: 'dealRef',
              label: 'Deal reference',
              required: true,
              maxLength: 128,
              help: 'A reference from your sales records. One onboarding is allowed per deal.',
            },
            { name: 'clientName', label: 'Client name', required: true, maxLength: 200 },
            { name: 'projectName', label: 'Project name', required: true, maxLength: 200 },
            {
              name: 'ownerMembershipId',
              kind: 'select',
              label: 'Accountable owner',
              required: true,
              value: context.membershipId,
              options: people,
            },
            {
              name: 'reviewerMembershipId',
              kind: 'select',
              label: 'Brief reviewer and email approver',
              required: true,
              options: [
                { value: '', label: 'Choose a different person' },
                ...people.filter((p) => p.value !== context.membershipId),
              ],
            },
            {
              name: 'emailConnectionId',
              kind: 'select',
              label: 'Send from',
              required: true,
              options: [
                { value: '', label: 'Choose an email connection' },
                ...email.map((c) => ({ value: c.id, label: c.displayName })),
              ],
            },
            {
              name: 'contactEmail',
              kind: 'email',
              label: 'Client contact email',
              required: true,
              maxLength: 254,
            },
          ]}
        />
      )}
    </>
  );
}
