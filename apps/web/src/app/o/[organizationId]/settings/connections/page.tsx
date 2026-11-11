import { AppError, getAuthorization, type OAuthAuthorizationView } from '@ensemus/application';
import { getMemberCapabilities, listMyConnections } from '@ensemus/application/suite-settings';
import {
  CAPABILITY_SCOPES,
  isOAuthErrorCode,
  SUITE_CONNECTOR_TYPES,
  SUITE_PROVIDER,
  type SuiteCapability,
  type SuiteConnectorType,
} from '@ensemus/domain/workspace-suites';
import { ConfirmForm } from '@/components/confirm-form';
import { ResourceRefresh } from '@/components/resource-refresh';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { messageFor } from '@/lib/messages';
import { platformClientId } from '@/server/oauth';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
import { revokeMyConnectionAction } from './actions';
import {
  capabilityLabel,
  CONNECTION_STATE_WORDS,
  MEMBER_CAPABILITY_WORDS,
  SUITE_NAMES,
} from './capability-words';
import { MyConnectForm, type MyCapabilityChoice } from './my-connect-form';

export const metadata = { title: 'Your connections | Ensemus' };

/** Where the member's own consent got to, in plain words. Never the provider's own text. */
const ATTEMPT_WORDS: Record<string, { label: string; tone: string; detail: string }> = {
  pending: {
    label: 'Waiting for you',
    tone: 'attention',
    detail: 'Finish on the provider’s page within ten minutes, or start again.',
  },
  code_received: {
    label: 'Finishing',
    tone: 'active',
    detail: 'You agreed. Ensemus is finishing the connection, which takes a few seconds.',
  },
  exchanging: {
    label: 'Finishing',
    tone: 'active',
    detail: 'You agreed. Ensemus is finishing the connection, which takes a few seconds.',
  },
  connected: { label: 'Connected', tone: 'done', detail: 'It is connected and listed below.' },
  denied: { label: 'Not connected', tone: 'bad', detail: '' },
  failed: { label: 'Not connected', tone: 'bad', detail: '' },
  expired: {
    label: 'Expired',
    tone: '',
    detail: 'This took longer than ten minutes, so nothing was connected. Start again.',
  },
};

const IN_PROGRESS = new Set(['pending', 'code_received', 'exchanging']);

/** The member's own attempt the callback sent them back to, or nothing if it is not theirs. */
async function ownAttempt(
  database: Parameters<typeof getAuthorization>[0],
  context: Parameters<typeof getAuthorization>[1],
  authorizationId: string | undefined,
): Promise<OAuthAuthorizationView | null> {
  if (!authorizationId) return null;
  try {
    const attempt = await getAuthorization(database, context, { authorizationId });
    return attempt.ownerMembershipId === context.membershipId ? attempt : null;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** What a member may choose for one provider: allowed, and something the provider has for it. */
function choicesFor(
  connectorType: SuiteConnectorType,
  allowed: readonly SuiteCapability[],
): MyCapabilityChoice[] {
  return Object.entries(MEMBER_CAPABILITY_WORDS).flatMap(([id, words]) => {
    const scopes = CAPABILITY_SCOPES[connectorType][id as SuiteCapability];
    return allowed.includes(id as SuiteCapability) && scopes.length > 0
      ? [{ id, label: words.label, description: words.description, scopes }]
      : [];
  });
}

const listed = (capabilities: readonly SuiteCapability[]) =>
  capabilities.length === 0
    ? 'nothing yet'
    : capabilities.map((capability) => capabilityLabel(capability).toLowerCase()).join(', ');

export default async function MyConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; authorization?: string }>;
}) {
  const { organizationId } = await params;
  const { error, authorization } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  const [mine, allowed, attempt] = await Promise.all([
    listMyConnections(database, context),
    getMemberCapabilities(database, context),
    ownAttempt(database, context, authorization),
  ]);
  const enabled = getRuntime().config.connectorsEnabled;
  const attemptWords = attempt
    ? (ATTEMPT_WORDS[attempt.status] ?? { label: attempt.status, tone: '', detail: '' })
    : null;

  return (
    <>
      <PageHead
        title="Your connections"
        description="Connect your own Google or Microsoft account, so assistants you start can work with your mail and calendar. Only you, and assistants you start, can use it."
      />
      <ErrorNotice code={error} />
      <div className="stack">
        {attempt && attemptWords && (
          <section className="card" aria-labelledby="attempt-heading">
            <h2 id="attempt-heading">Connecting</h2>
            <div role="status">
              <span className="row">
                <strong>{attempt.displayName}</strong>
                <span className={`badge ${attemptWords.tone}`}>{attemptWords.label}</span>
              </span>
              <p className="muted">
                {SUITE_NAMES[attempt.connectorType]}, started {formatDateTime(attempt.createdAt)}.{' '}
                {(isOAuthErrorCode(attempt.errorCode) && messageFor(attempt.errorCode)) ||
                  attemptWords.detail ||
                  'Nothing was connected. Start again.'}
              </p>
            </div>
            <ResourceRefresh active={IN_PROGRESS.has(attempt.status)} />
          </section>
        )}
        <section className="card" aria-labelledby="mine-heading">
          <h2 id="mine-heading">Connected accounts</h2>
          <p className="muted">
            Nobody else in your organization can use these or see what they reach. An administrator
            can see that you have one and can disconnect it.
          </p>
          {mine.length === 0 ? (
            <Empty>You have not connected an account.</Empty>
          ) : (
            <ul className="list">
              {mine.map((connection) => {
                const state = CONNECTION_STATE_WORDS[connection.state] ?? {
                  label: connection.state,
                  tone: '',
                };
                return (
                  <li key={connection.id} className="block">
                    <span className="row">
                      <strong>{connection.displayName}</strong>
                      <span className={`badge ${state.tone}`}>{state.label}</span>
                    </span>
                    <p className="muted">
                      {SUITE_NAMES[connection.connectorType]}, connected{' '}
                      {formatDateTime(connection.createdAt)}. Assistants you start may use it for{' '}
                      {listed(connection.capabilities)}.
                    </p>
                    {connection.state !== 'revoked' && (
                      <div className="gap-above">
                        <ConfirmForm
                          action={revokeMyConnectionAction}
                          fields={
                            <>
                              <input type="hidden" name="organizationId" value={organizationId} />
                              <input type="hidden" name="connectionId" value={connection.id} />
                            </>
                          }
                          summary="Disconnect"
                          summaryLabel={`Disconnect ${connection.displayName}`}
                          consequence={`Disconnect ${connection.displayName} for good. Assistants stop using it at once, and anything not yet sent through it will not go out. To use it again, connect it again.`}
                          confirmLabel="Disconnect for good"
                          confirmFullLabel={`Disconnect for good: ${connection.displayName}`}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="connect-heading">
          <h2 id="connect-heading">Connect an account</h2>
          {!enabled ? (
            <p className="notice warn flush">
              Connectors are not turned on for this deployment, so nothing can be connected. An
              operator turns them on.
            </p>
          ) : allowed.length === 0 ? (
            <Empty>
              Your organization does not let members connect their own accounts. Ask an
              administrator if you need to.
            </Empty>
          ) : (
            <>
              <p className="muted">
                You agree on Google’s or Microsoft’s own page, and Ensemus never sees your password.
                What you choose here is all it asks for. Anything an assistant sends or changes
                through it waits for approval as your organization’s rules say.
              </p>
              {SUITE_CONNECTOR_TYPES.map((connectorType) => {
                const providerName = SUITE_NAMES[connectorType];
                const choices = choicesFor(connectorType, allowed);
                return (
                  <details key={connectorType} className="gap-above">
                    <summary>Connect {providerName}</summary>
                    {platformClientId(SUITE_PROVIDER[connectorType]) === null ? (
                      <p className="muted">
                        Ensemus’s app for {providerName} is not set up on this deployment, so you
                        cannot connect it yet. Whoever runs Ensemus can set it up.
                      </p>
                    ) : choices.length === 0 ? (
                      <p className="muted">
                        Nothing your organization lets members connect is available for{' '}
                        {providerName} yet.
                      </p>
                    ) : (
                      <MyConnectForm
                        organizationId={organizationId}
                        connectorType={connectorType}
                        providerName={providerName}
                        capabilities={choices}
                      />
                    )}
                  </details>
                );
              })}
            </>
          )}
        </section>
      </div>
    </>
  );
}
