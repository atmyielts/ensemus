import { randomUUID } from 'node:crypto';
import {
  AppError,
  getFederationSettings,
  listGrants,
  type FederationGrantView,
} from '@ensemus/application';
import { hasRecentMfa } from '@ensemus/application/privileged';
import { loadTenancyConfig } from '@ensemus/config';
import { interactiveSessionOf } from '@ensemus/database';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import { ErrorNotice, PageHead, formatDateTime } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { stepUpPath } from '@/lib/step-up';
import { requireTenant } from '@/server/tenant';
import { updateCollaboration } from './actions';
import { GrantScope, InvitationForms } from './invitation-forms';

export const metadata = { title: 'Collaboration | Ensemus' };

const statuses = {
  proposed: 'Invited',
  accepted: 'Awaiting confirmation',
  active: 'Active',
  ended: 'Ended',
};
function endingFor(grant: FederationGrantView) {
  if (grant.status === 'active') return { reason: 'revoked', label: 'Revoke grant' };
  if (grant.role === 'sharing' && (grant.status === 'accepted' || grant.status === 'proposed'))
    return { reason: 'cancelled', label: 'Cancel invitation' };
  if (grant.role === 'receiving' && grant.status === 'accepted')
    return { reason: 'declined', label: 'Withdraw acceptance' };
  return null;
}

export default async function CollaborationPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  if (!loadTenancyConfig().crossOrgEnabled) notFound();
  const { organizationId } = await params;
  const { database, context } = await requireTenant(organizationId);
  const settings = await getFederationSettings(database, context).catch((error) => {
    if (error instanceof AppError && error.code === 'NOT_FOUND') notFound();
    throw error;
  });
  if (!settings.available) notFound();
  const owner = can(context.role, 'federation.manage');
  const canEnd = can(context.role, 'federation.end');
  const path = '/o/' + organizationId + '/collaboration';
  const action = updateCollaboration.bind(null, organizationId);
  const [grants, query, ready] = await Promise.all([
    listGrants(database, context),
    searchParams,
    owner && hasRecentMfa(database, context, 'organization.manage', interactiveSessionOf(context)),
  ]);

  return (
    <>
      <PageHead
        title="Collaboration"
        description="Review invitations and manage which organizations this workspace can collaborate with."
      />
      <div className="stack">
        <ErrorNotice code={query.error} />
        {query.saved && !query.error && (
          <p className="notice good" role="status">
            Collaboration updated.
          </p>
        )}
        <Card asChild>
          <section className="card min-w-0" aria-labelledby="collaboration-settings">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="collaboration-settings" className="m-0">
                Workspace collaboration
              </h2>
              <Badge variant="outline">{settings.enabled ? 'Enabled' : 'Off'}</Badge>
            </div>
            {owner && !ready && (
              <Button asChild variant="outline">
                <Link href={stepUpPath(organizationId, path)}>Confirm your identity</Link>
              </Button>
            )}
            {owner &&
              ready &&
              (settings.enabled ? (
                <ConfirmForm
                  action={action}
                  fields={
                    <>
                      <input type="hidden" name="operation" value="disable" />
                      <input type="hidden" name="version" value={settings.version} />
                    </>
                  }
                  summary="Turn off"
                  confirmLabel="Turn off collaboration"
                  consequence="This ends every open grant. To collaborate again, both organizations will need a new grant."
                />
              ) : (
                <form action={action}>
                  <input type="hidden" name="operation" value="enable" />
                  <input type="hidden" name="version" value={settings.version} />
                  <SubmitButton working="Enabling collaboration">Enable collaboration</SubmitButton>
                </form>
              ))}
          </section>
        </Card>
        {ready && settings.enabled && (
          <InvitationForms
            org={organizationId}
            requestKey={randomUUID()}
            acceptanceKey={randomUUID()}
          />
        )}
        <Card asChild>
          <section className="card min-w-0" aria-labelledby="grants-heading">
            <h2 id="grants-heading">Grants</h2>
            {grants.length ? (
              <ul className="grid min-w-0 divide-y">
                {grants.map((grant) => {
                  const ending = canEnd && endingFor(grant);
                  const expired =
                    grant.status !== 'ended' && grant.expiresAt.getTime() <= Date.now();
                  const grantFields = (
                    <>
                      <input type="hidden" name="grantId" value={grant.id} />
                      <input type="hidden" name="version" value={grant.version} />
                    </>
                  );
                  return (
                    <li key={grant.id} className="grid min-w-0 gap-3 py-4">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="m-0 wrap-anywhere">
                          {grant.counterpartyName ?? 'Awaiting recipient'}
                        </h3>
                        <Badge variant="outline">
                          {expired ? 'Expired' : statuses[grant.status]}
                        </Badge>
                      </div>
                      <p className="m-0 text-sm text-muted-foreground">
                        {grant.role === 'sharing' ? 'Sharing side' : 'Receiving side'} · Expires{' '}
                        {formatDateTime(grant.expiresAt)}
                      </p>
                      {grant.counterpartyFingerprint && (
                        <p className="m-0 text-sm">
                          Fingerprint <code>{grant.counterpartyFingerprint}</code>
                        </p>
                      )}
                      <details>
                        <summary>Review scope</summary>
                        <GrantScope terms={grant.terms} />
                      </details>
                      {ready &&
                        settings.enabled &&
                        !expired &&
                        grant.role === 'sharing' &&
                        grant.status === 'accepted' && (
                          <ConfirmForm
                            action={action}
                            fields={
                              <>
                                {grantFields}
                                <input type="hidden" name="operation" value="activate" />
                                <input type="hidden" name="termsHash" value={grant.termsHash} />
                              </>
                            }
                            summary="Confirm recipient"
                            confirmLabel="Activate grant"
                            consequence="I have checked the other organization’s fingerprint and reviewed the scope."
                          />
                        )}
                      {ending && (
                        <ConfirmForm
                          action={action}
                          fields={
                            <>
                              {grantFields}
                              <input type="hidden" name="operation" value="end" />
                              <input type="hidden" name="reason" value={ending.reason} />
                            </>
                          }
                          summary={ending.label}
                          confirmLabel={ending.label}
                          consequence="This ends the grant permanently. The other organization may already have read material shared under it."
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="m-0 text-sm text-muted-foreground">No collaboration grants yet.</p>
            )}
          </section>
        </Card>
      </div>
    </>
  );
}
