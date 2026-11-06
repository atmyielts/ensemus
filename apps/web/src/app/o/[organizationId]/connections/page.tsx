import { randomUUID } from 'node:crypto';
import { listConnections, listWebhookActivity } from '@ensemus/application';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { CONNECTOR_CATALOG, manifestOf } from '@/server/api';
import { revokeConnectionAction } from '@/server/external-action-actions';
import { getRuntime } from '@/server/runtime';
import { requireTenant } from '@/server/tenant';
import { NewConnectionForm } from './new-connection-form';
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

export default async function ConnectionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { context, database } = await requireTenant(organizationId);
  // The usual not found: this page is not there for someone who may not manage connections.
  if (!can(context.role, 'connection.manage')) notFound();
  const [rows, activity] = await Promise.all([
    listConnections(database, context),
    listWebhookActivity(database, context),
  ]);
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
                      {manifest?.displayName ?? 'A connector this deployment does not know'}.{' '}
                      {manifest?.credential.required
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
                          confirmFullLabel={`Revoke ${row.displayName} for good`}
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
