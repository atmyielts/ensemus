import { randomUUID } from 'node:crypto';
import { listDirectory } from '@ensemus/application';
import { listConnections } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import { KnowledgeForm } from '@/components/knowledge-form';
import { ActionLink, Empty, PageHead } from '@/components/ui';
import { startKnowledgeOnboardingAction } from '@/server/knowledge-actions';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
export const metadata = { title: 'Start client onboarding | Ensemus' };

/** What starting an onboarding sets going, in the order it happens. */
const STEPS = [
  {
    title: 'The client is set up',
    text: 'Ensemus adds the client, its project and the work that tracks the onboarding.',
  },
  {
    title: 'A brief is prepared',
    text: 'An assistant writes a brief about the client from what your organization already knows.',
  },
  {
    title: 'A colleague reviews it',
    text: 'Someone other than you and the owner reads the brief and its sources, then accepts or rejects it.',
  },
  {
    title: 'The welcome email goes out',
    text: 'The same colleague approves the exact recipient and message. Nothing is sent before that.',
  },
] as const;

function Steps() {
  return (
    <section className="card" aria-labelledby="onboarding-steps-heading">
      <h2 id="onboarding-steps-heading">What happens when you start</h2>
      <ol className="onboarding-steps">
        {STEPS.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

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
        <Empty title="Only owners and admins start onboarding">
          Your role cannot start client onboarding. Ask an owner or admin of your organization to
          start it for you.
        </Empty>
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
        description="Welcome a new client in four checked steps. Nothing reaches the client until a second person has approved the exact email."
      />
      <div className="stack">
        <Steps />
        {!connectorsEnabled && (
          <p className="notice warn flush">
            Email sending is switched off for this Ensemus installation, so the welcome email could
            never go out and onboarding cannot start. Whoever runs Ensemus for your organization can
            switch it on.
          </p>
        )}
        {!email.length ? (
          <Empty
            title="Connect an email account first"
            action={
              <ActionLink href={`/o/${organizationId}/connections`} variant="secondary">
                Go to Connections
              </ActionLink>
            }
          >
            The welcome email needs an account to go out from, and none is connected and working
            yet. Connect one, then come back here to start.
          </Empty>
        ) : (
          <KnowledgeForm
            action={startKnowledgeOnboardingAction}
            hidden={{ organizationId, requestKey: randomUUID() }}
            submit="Start onboarding"
            description="Contact details stay in your organization's records."
            fields={[
              {
                name: 'clientName',
                label: 'Client name',
                required: true,
                maxLength: 200,
              },
              {
                name: 'projectName',
                label: 'Project name',
                required: true,
                maxLength: 200,
                help: 'What the work for them is called, such as "Website refresh".',
              },
              {
                name: 'dealRef',
                label: 'Deal reference',
                required: true,
                maxLength: 128,
                help: 'A reference from your sales records. One onboarding is allowed per deal.',
              },
              {
                name: 'ownerMembershipId',
                kind: 'select',
                label: 'Accountable owner',
                help: 'The person who answers for this onboarding until it is done.',
                required: true,
                value: context.membershipId,
                options: people,
              },
              {
                name: 'reviewerMembershipId',
                kind: 'select',
                label: 'Brief reviewer and email approver',
                help: 'Someone other than you and the owner. They check the brief, then approve the welcome email.',
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
                help: 'The email account the welcome email goes out from.',
                required: true,
                options: [
                  { value: '', label: 'Choose an email account' },
                  ...email.map((c) => ({ value: c.id, label: c.displayName })),
                ],
              },
              {
                name: 'contactEmail',
                kind: 'email',
                label: 'Client contact email',
                help: 'Who receives the welcome email.',
                required: true,
                maxLength: 254,
              },
            ]}
          />
        )}
      </div>
    </>
  );
}
