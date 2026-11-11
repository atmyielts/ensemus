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
    detail: 'Finish on Google’s or Microsoft’s page within ten minutes, or start again.',
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

/** What each account brings, in a line, before anyone chooses. */
const PROVIDER_BLURB: Record<SuiteConnectorType, string> = {
  google_workspace: 'Your Google mail, calendar and documents.',
  microsoft_365: 'Your Microsoft mail, calendar and documents, and Teams chat.',
};

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
        description="Connect your own Google or Microsoft account, so assistants you start can help with your mail, calendar and documents. Only you, and assistants you start, can use it."
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
          {mine.length === 0 ? (
            <Empty title="No accounts connected yet">
              Connect Google Workspace or Microsoft 365 below, and assistants you start can work
              with it.
            </Empty>
          ) : (
            <>
              <p className="muted">
                Nobody else at your company can use these or see what they reach. An administrator
                can see that you have one, and can disconnect it.
              </p>
              <ul className="list gap-above">
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
            </>
          )}
        </section>
        <section aria-labelledby="connect-heading">
          <div className="section-intro">
            <h2 id="connect-heading">Connect an account</h2>
            <p>
              You agree on Google’s or Microsoft’s own page, and Ensemus never sees your password.
              Anything an assistant sends or changes through it waits for approval, as your
              company’s rules say.
            </p>
          </div>
          {!enabled ? (
            <p className="notice warn flush">
              Connecting accounts isn’t turned on for your company yet. Ask whoever set up Ensemus
              for your company to turn it on.
            </p>
          ) : allowed.length === 0 ? (
            <Empty title="Not available at your company">
              Your company doesn’t let people connect their own accounts. Ask an administrator if
              you need to.
            </Empty>
          ) : (
            <div className="stack">
              {SUITE_CONNECTOR_TYPES.map((connectorType) => {
                const providerName = SUITE_NAMES[connectorType];
                const choices = choicesFor(connectorType, allowed);
                const ready = platformClientId(SUITE_PROVIDER[connectorType]) !== null;
                return (
                  <section
                    key={connectorType}
                    className="card"
                    aria-labelledby={`provider-${connectorType}`}
                  >
                    <h3 id={`provider-${connectorType}`}>{providerName}</h3>
                    <p className="muted">{PROVIDER_BLURB[connectorType]}</p>
                    <dl className="details gap-above">
                      <div>
                        <dt>What it allows</dt>
                        <dd>
                          {choices.length === 0
                            ? 'Nothing yet'
                            : choices.map((choice) => choice.label).join(', ')}
                        </dd>
                      </div>
                      <div>
                        <dt>Who can use it</dt>
                        <dd>Only you, and assistants you start</dd>
                      </div>
                      <div>
                        <dt>To stop</dt>
                        <dd>Disconnect it on this page, at any time</dd>
                      </div>
                    </dl>
                    <div className="divided">
                      {!ready ? (
                        <p className="muted">
                          Connecting {providerName} isn’t set up for your company yet. Ask whoever
                          set up Ensemus for your company to set it up.
                        </p>
                      ) : choices.length === 0 ? (
                        <p className="muted">
                          Nothing your company lets people connect is available for {providerName}{' '}
                          yet.
                        </p>
                      ) : (
                        <MyConnectForm
                          organizationId={organizationId}
                          connectorType={connectorType}
                          providerName={providerName}
                          capabilities={choices}
                        />
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
