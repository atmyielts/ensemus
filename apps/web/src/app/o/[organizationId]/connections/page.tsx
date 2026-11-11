import { randomUUID } from 'node:crypto';
import {
  AppError,
  getAuthorization,
  listAuthorizations,
  listConnections,
  listWebhookActivity,
  type OAuthAuthorizationView,
} from '@ensemus/application';
import {
  getMemberCapabilities,
  listMemberConnections,
  MEMBER_OWNABLE_CAPABILITIES,
} from '@ensemus/application/suite-settings';
import { can } from '@ensemus/domain/policy';
import {
  CAPABILITY_SCOPES,
  CONNECTABLE_CAPABILITIES,
  isOAuthErrorCode,
  SUITE_PROVIDER,
  type SuiteConnectorType,
} from '@ensemus/domain/workspace-suites';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { ResourceRefresh } from '@/components/resource-refresh';
import { SubmitButton } from '@/components/submit-button';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { messageFor } from '@/lib/messages';
import { CONNECTOR_CATALOG, manifestOf } from '@/server/api';
import { revokeConnectionAction } from '@/server/external-action-actions';
import { oauthRedirectUri, platformClientId } from '@/server/oauth';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
import {
  revokeMyConnectionAction,
  setMemberCapabilitiesAction,
} from '../settings/connections/actions';
import {
  CONNECTION_STATE_WORDS,
  MEMBER_CAPABILITY_WORDS,
  suiteName,
} from '../settings/connections/capability-words';
import { NewConnectionForm } from './new-connection-form';
import { SuiteConnectForm, type SuiteCapabilityChoice } from './suite-connect-form';
import { WebhookForm } from './webhook-form';

export const metadata = { title: 'Connections | Ensemus' };

const STATE_WORDS: Record<string, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'done' },
  disabled: { label: 'Disabled', tone: 'attention' },
  revoked: { label: 'Revoked', tone: '' },
};

const DELIVERY_WORDS: Record<string, string> = {
  received: 'Waiting to be checked',
  applied: 'Signature good, and acted on',
  duplicate: 'Signature good, and already seen',
  rejected: 'Refused',
  failed: 'Could not be processed',
};

const REJECT_WORDS: Record<string, string> = {
  BAD_SIGNATURE: 'The signature did not match.',
  SIGNATURE_MISSING: 'It had no signature.',
  TIMESTAMP_OUTSIDE_WINDOW: 'Its time was too far from now, as an old request replayed would be.',
  TIMESTAMP_MISSING: 'It had no time on it.',
  MALFORMED_PAYLOAD: 'The signature was good, and the body was not something Ensemus understands.',
  ENDPOINT_NOT_ACTIVE: 'The address had been turned off.',
  SECRET_UNAVAILABLE: 'Ensemus could not open the signing secret, which is not the sender’s fault.',
  NOT_PROCESSED_IN_TIME: 'Nothing checked it in time, so it was dropped.',
};

const SUITE_NAMES: Record<SuiteConnectorType, string> = {
  google_workspace: 'Google Workspace',
  microsoft_365: 'Microsoft 365',
};

const isSuiteType = (type: string): type is SuiteConnectorType => Object.hasOwn(SUITE_NAMES, type);

const CAPABILITY_WORDS: Record<string, { label: string; description: string }> = {
  files: {
    label: 'Read files',
    description: 'Search and cite documents, each only for the people who can open it there.',
  },
  directory: {
    label: 'Read groups',
    description: 'Mirror each group as a team, so a file shared with a group reaches its members.',
  },
};

/** Where a consent attempt got to, in plain words. Never the provider's own text. */
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
  connected: { label: 'Connected', tone: 'done', detail: 'It is connected and listed above.' },
  denied: { label: 'Not connected', tone: 'bad', detail: '' },
  failed: { label: 'Not connected', tone: 'bad', detail: '' },
  expired: {
    label: 'Expired',
    tone: '',
    detail: 'This took longer than ten minutes, so nothing was connected. Start again.',
  },
};

const IN_PROGRESS = new Set(['pending', 'code_received', 'exchanging']);

function capabilityChoices(connectorType: SuiteConnectorType): SuiteCapabilityChoice[] {
  return CONNECTABLE_CAPABILITIES.map((id) => ({
    id,
    label: CAPABILITY_WORDS[id]?.label ?? id,
    description: CAPABILITY_WORDS[id]?.description ?? '',
    scopes: CAPABILITY_SCOPES[connectorType][id],
  }));
}

/** The attempt the callback sent this person back to, or nothing if it is not theirs to see. */
async function focusedAttempt(
  database: Parameters<typeof getAuthorization>[0],
  context: Parameters<typeof getAuthorization>[1],
  authorizationId: string | undefined,
): Promise<OAuthAuthorizationView | null> {
  if (!authorizationId) return null;
  try {
    return await getAuthorization(database, context, { authorizationId });
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

function AttemptSummary({ attempt }: { attempt: OAuthAuthorizationView }) {
  const words = ATTEMPT_WORDS[attempt.status] ?? { label: attempt.status, tone: '', detail: '' };
  // The same wording the callback's redirect shows, so an attempt reads alike wherever it is seen.
  const detail =
    (isOAuthErrorCode(attempt.errorCode) && messageFor(attempt.errorCode)) ||
    words.detail ||
    'Nothing was connected. Start again.';
  return (
    <>
      <span className="row">
        <strong>{attempt.displayName}</strong>
        <span className={`badge ${words.tone}`}>{words.label}</span>
      </span>
      <p className="muted">
        {SUITE_NAMES[attempt.connectorType]}, through{' '}
        {attempt.clientKind === 'platform' ? 'Ensemus’s app' : 'your own app'}, started{' '}
        {formatDateTime(attempt.createdAt)}. {detail}
      </p>
    </>
  );
}

export default async function ConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; authorization?: string }>;
}) {
  const { organizationId } = await params;
  const { error, authorization } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  // The consent callback sends everyone back here. A member's own attempt, and anyone's who may not
  // manage connections, belongs on their own page, which shows only what is theirs.
  const own = `/o/${organizationId}/settings/connections`;
  if (!can(context.role, 'connection.manage')) {
    if (authorization) redirect(`${own}?authorization=${encodeURIComponent(authorization)}`);
    if (error) redirect(`${own}?error=${encodeURIComponent(error)}`);
    // The usual not found: this page is not there for someone who may not manage connections.
    notFound();
  }
  const [allRows, activity, attempts, opened, members, memberCapabilities] = await Promise.all([
    listConnections(database, context),
    listWebhookActivity(database, context),
    listAuthorizations(database, context),
    focusedAttempt(database, context, authorization),
    listMemberConnections(database, context),
    getMemberCapabilities(database, context),
  ]);
  if (opened && opened.ownerMembershipId === context.membershipId) {
    redirect(`${own}?authorization=${encodeURIComponent(opened.id)}`);
  }
  // Another member's own attempt is not followed here.
  const focused = opened && opened.ownerMembershipId === null ? opened : null;
  // A member's own connection is listed apart, by whose it is and its state, and never by its name.
  const memberIds = new Set(members.map((member) => member.id));
  const rows = allRows.filter((row) => !memberIds.has(row.id));
  // The latest few of the organization's, apart from the one this page was opened for, which has its own
  // place. A member's own attempt is theirs to follow.
  const recent = attempts
    .filter((attempt) => attempt.ownerMembershipId === null && attempt.id !== focused?.id)
    .slice(0, 5);
  const enabled = getRuntime().config.connectorsEnabled;
  const base = `/o/${organizationId}`;
  const nameOf = new Map(rows.map((row) => [row.id, row.displayName]));

  return (
    <>
      <p className="back">
        <Link href={`${base}/external-actions`}>Back to external actions</Link>
      </p>
      <PageHead
        title="Connections"
        description="How Ensemus reaches systems outside itself. Credentials are sealed, and nobody can read them back."
      />
      <ErrorNotice code={error} />
      <div className="stack">
        {focused && (
          <section className="card" aria-labelledby="attempt-heading">
            <h2 id="attempt-heading">Connecting</h2>
            <div role="status">
              <AttemptSummary attempt={focused} />
            </div>
            <ResourceRefresh active={IN_PROGRESS.has(focused.status)} />
          </section>
        )}
        {!enabled && (
          <p className="notice warn flush">
            Connectors are not turned on for this deployment, so nothing here can send or receive
            anything. An operator turns them on. Nothing is being simulated in the meantime.
          </p>
        )}
        <section className="card" aria-labelledby="connections-heading">
          <h2 id="connections-heading">In this organization</h2>
          {rows.length === 0 ? (
            <Empty>No connections yet.</Empty>
          ) : (
            <ul className="list">
              {rows.map((row) => {
                const state = STATE_WORDS[row.state] ?? { label: row.state, tone: '' };
                const manifest = manifestOf(row.connectorType);
                return (
                  <li key={row.id} className="block">
                    <span className="row">
                      <strong>{row.displayName}</strong>
                      <span className={`badge ${state.tone}`}>{state.label}</span>
                    </span>
                    <p className="muted">
                      {manifest?.displayName ??
                        (isSuiteType(row.connectorType)
                          ? SUITE_NAMES[row.connectorType]
                          : 'A connector this deployment does not know')}
                      .{' '}
                      {(manifest?.credential.required ?? isSuiteType(row.connectorType))
                        ? row.hasCredential
                          ? 'A credential is on file.'
                          : 'No credential is on file.'
                        : 'It needs no credential.'}
                    </p>
                    {row.lastErrorCode && (
                      <p className="notice warn flush">
                        The last problem, with code <code>{row.lastErrorCode}</code>.
                      </p>
                    )}
                    {enabled && row.state === 'active' && manifest?.capabilities.webhooks && (
                      <div className="gap-above">
                        <WebhookForm
                          organizationId={organizationId}
                          connectionId={row.id}
                          connectionName={row.displayName}
                        />
                      </div>
                    )}
                    {row.state === 'active' && (
                      <div className="gap-above">
                        <ConfirmForm
                          action={revokeConnectionAction}
                          fields={
                            <>
                              <input type="hidden" name="organizationId" value={organizationId} />
                              <input type="hidden" name="connectionId" value={row.id} />
                              <input type="hidden" name="version" value={row.version} />
                            </>
                          }
                          summary="Revoke"
                          summaryLabel={`Revoke ${row.displayName}`}
                          consequence={`Revoke ${row.displayName} for good. Anything not yet attempted will not go out through it, and any work asking for its receipt will need another connection.`}
                          confirmLabel="Revoke for good"
                          confirmFullLabel={`Revoke for good: ${row.displayName}`}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <section className="card" aria-labelledby="members-heading">
          <h2 id="members-heading">Members’ own accounts</h2>
          <p className="muted">
            Members can connect their own Google or Microsoft account from their own connections
            page, for what you allow here. Only that member, and assistants they start, can use it.
            You see whose each is and whether it is active, never what it reaches, and you can
            revoke one.
          </p>
          <form className="fields" action={setMemberCapabilitiesAction}>
            <input type="hidden" name="organizationId" value={organizationId} />
            <fieldset className="group">
              <legend>What members may connect</legend>
              {MEMBER_OWNABLE_CAPABILITIES.map((capability) => {
                const words = (
                  MEMBER_CAPABILITY_WORDS as Record<string, { label: string; description: string }>
                )[capability];
                return (
                  <label key={capability} className="check">
                    <input
                      type="checkbox"
                      name="capability"
                      value={capability}
                      defaultChecked={memberCapabilities.includes(capability)}
                    />
                    <span>
                      {words?.label ?? capability}. {words?.description}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <p className="muted">
              Taking one away stops new connections for it. Accounts already connected keep it until
              revoked below. Leave all of them clear to let members connect nothing.
            </p>
            <div>
              <SubmitButton working="Saving">Save what members may connect</SubmitButton>
            </div>
          </form>
          <h3 className="gap-above">Connected by members</h3>
          {members.length === 0 ? (
            <Empty>No member has connected their own account.</Empty>
          ) : (
            <ul className="list">
              {members.map((member) => {
                const state = CONNECTION_STATE_WORDS[member.state] ?? {
                  label: member.state,
                  tone: '',
                };
                const whose = `${member.ownerName}’s ${suiteName(member.connectorType)}`;
                return (
                  <li key={member.id} className="block">
                    <span className="row">
                      <strong>{whose}</strong>
                      <span className={`badge ${state.tone}`}>{state.label}</span>
                    </span>
                    <p className="muted">Connected {formatDateTime(member.createdAt)}.</p>
                    {member.state !== 'revoked' && (
                      <div className="gap-above">
                        <ConfirmForm
                          action={revokeMyConnectionAction}
                          fields={
                            <>
                              <input type="hidden" name="organizationId" value={organizationId} />
                              <input type="hidden" name="connectionId" value={member.id} />
                              <input type="hidden" name="from" value="admin" />
                            </>
                          }
                          summary="Revoke"
                          summaryLabel={`Revoke ${whose}`}
                          consequence={`Revoke ${whose} for good. Assistants stop using it at once, and anything not yet sent through it will not go out. Only ${member.ownerName} can connect it again.`}
                          confirmLabel="Revoke for good"
                          confirmFullLabel={`Revoke for good: ${whose}`}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {activity.length > 0 && (
          <section className="card" aria-labelledby="callbacks-heading">
            <h2 id="callbacks-heading">Recent callbacks</h2>
            <p className="muted">
              A sender always hears the same answer, so this is the only place that shows whether a
              signature passed. It shows no content.
            </p>
            <ul className="list">
              {activity.map((delivery) => (
                <li key={delivery.id} className="block">
                  <strong>{DELIVERY_WORDS[delivery.state] ?? 'Not recognized'}</strong>{' '}
                  <small>
                    {nameOf.get(delivery.connectionId) ?? 'A connection'},{' '}
                    {formatDateTime(delivery.receivedAt)}
                  </small>
                  {delivery.rejectCode && (
                    <p className="muted">
                      {REJECT_WORDS[delivery.rejectCode] ?? 'No more detail was recorded.'}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        {recent.length > 0 && (
          <section className="card" aria-labelledby="attempts-heading">
            <h2 id="attempts-heading">Recent attempts to connect</h2>
            <ul className="list">
              {recent.map((attempt) => (
                <li key={attempt.id} className="block">
                  <AttemptSummary attempt={attempt} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {enabled && (
          <section className="card" aria-labelledby="suite-heading">
            <h2 id="suite-heading">Connect Google Workspace or Microsoft 365</h2>
            <p className="muted">
              You agree on Google’s or Microsoft’s own page, and Ensemus never sees your password.
              What you choose here is all it asks for.
            </p>
            {(Object.keys(SUITE_NAMES) as SuiteConnectorType[]).map((connectorType) => (
              <details key={connectorType} className="gap-above">
                <summary>Connect {SUITE_NAMES[connectorType]}</summary>
                <SuiteConnectForm
                  organizationId={organizationId}
                  connectorType={connectorType}
                  providerName={SUITE_NAMES[connectorType]}
                  capabilities={capabilityChoices(connectorType)}
                  platformAvailable={platformClientId(SUITE_PROVIDER[connectorType]) !== null}
                  redirectUri={oauthRedirectUri()}
                />
              </details>
            ))}
          </section>
        )}
        {enabled && (
          <section className="card" aria-labelledby="new-connection-heading">
            <h2 id="new-connection-heading">Add a connection</h2>
            <NewConnectionForm
              organizationId={organizationId}
              requestKey={randomUUID()}
              connectors={CONNECTOR_CATALOG.map(({ manifest }) => ({
                type: manifest.type,
                label: manifest.displayName,
              }))}
            />
          </section>
        )}
      </div>
    </>
  );
}
