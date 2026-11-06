import { listBreakGlassRequests } from '@ensemus/application/saas/break-glass';
import { loadSaasConfig } from '@ensemus/config';
import Link from 'next/link';
import { ConfirmForm } from '@/components/confirm-form';
import { Empty, ErrorNotice, PageHead, formatDateTime } from '@/components/ui';
import { decideBreakGlassAction } from '@/server/support-actions';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
export const metadata = { title: 'Support access requests | Ensemus' };
export default async function BreakGlassPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireAccountTenant(organizationId),
    requests = await orNotFound(listBreakGlassRequests(database, context)),
    config = loadSaasConfig().breakGlass;
  return (
    <div className="stack">
      <PageHead
        title="Support access requests"
        description="Review the exact record, duration and signatures before recording a decision."
        actions={<Link href={`/o/${organizationId}/account/support`}>Support</Link>}
      />
      <ErrorNotice code={(await searchParams).error} />
      <p className="notice">
        These requests record consent only. This deployment provides no support read path to your
        work through an authorization.
      </p>
      {!config.enabled && (
        <p className="notice">
          New authorizations are turned off. You can still refuse a pending request or revoke an
          existing one.
        </p>
      )}
      {requests.length === 0 ? (
        <Empty>No support access requests have been recorded.</Empty>
      ) : (
        <ul className="list">
          {requests.map((request) => (
            <li key={request.id}>
              <section className="stack">
                <div>
                  <h2>{request.scopeLabel ?? 'Record no longer available'}</h2>
                  <p>
                    {request.scopeType.replaceAll('_', ' ')} · {request.state}
                  </p>
                  <Link href={`/o/${organizationId}/account/support/${request.ticketId}`}>
                    Related ticket
                  </Link>
                </div>
                <dl className="facts">
                  <dt>Reason code</dt>
                  <dd>{request.reasonCode}</dd>
                  <dt>Requested period</dt>
                  <dd>{request.requestedMinutes} minutes</dd>
                  <dt>Operator signature</dt>
                  <dd>{request.operatorAuthorized ? 'Recorded' : 'Pending'}</dd>
                  <dt>Customer signature</dt>
                  <dd>{request.customerAuthorized ? 'Recorded' : 'Pending'}</dd>
                  <dt>Expiry</dt>
                  <dd>
                    {request.expiresAt
                      ? formatDateTime(request.expiresAt)
                      : 'Starts only after both sides agree'}
                  </dd>
                </dl>
                {request.state === 'requested' &&
                  config.enabled &&
                  request.scopeLabel &&
                  !request.customerAuthorized &&
                  request.requestedMinutes <= config.maxMinutes && (
                    <ConfirmForm
                      action={decideBreakGlassAction}
                      summary="Record consent"
                      consequence="I approve this exact record and requested period. I understand that this records consent and gives support no read path in this deployment."
                      confirmLabel="Record consent"
                      fields={
                        <>
                          <input type="hidden" name="organizationId" value={organizationId} />
                          <input type="hidden" name="requestId" value={request.id} />
                          <input type="hidden" name="version" value={request.version} />
                          <input type="hidden" name="decision" value="authorize" />
                        </>
                      }
                    />
                  )}
                {(request.state === 'requested' || request.state === 'authorized') && (
                  <ConfirmForm
                    action={decideBreakGlassAction}
                    summary={request.state === 'authorized' ? 'Revoke consent' : 'Refuse request'}
                    consequence={
                      request.state === 'authorized'
                        ? 'End this authorization immediately.'
                        : 'Refuse this request. It cannot later be authorized.'
                    }
                    confirmLabel={
                      request.state === 'authorized' ? 'Revoke consent' : 'Refuse request'
                    }
                    fields={
                      <>
                        <input type="hidden" name="organizationId" value={organizationId} />
                        <input type="hidden" name="requestId" value={request.id} />
                        <input type="hidden" name="version" value={request.version} />
                        <input
                          type="hidden"
                          name="decision"
                          value={request.state === 'authorized' ? 'revoke' : 'deny'}
                        />
                      </>
                    }
                  />
                )}
              </section>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
