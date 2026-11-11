import { getOffboarding } from '@ensemus/application/saas/offboarding';
import { getOrganization } from '@ensemus/database';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmForm } from '@/components/confirm-form';
import { AccountReasonSelect } from '@/components/account-reason-select';
import { ActionLink, BackLink, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { cancelOffboardingAction } from '@/server/offboarding-actions';
import { getOffboardingAgents } from '@/server/offboarding-bindings';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
import { OffboardingRequestForm } from './request-form';
export const metadata = { title: 'Leave Ensemus | Ensemus' };
const labels: Record<string, string> = {
  requested: 'Request recorded',
  export_offered: 'Export offered',
  in_transition: 'Contractual transition',
  winding_down: 'Ending work and connections',
  ready_for_erasure: 'Waiting for the data to be erased',
  erasing: 'Erasure in progress',
  verified: 'Deletion verified',
  reported: 'Report recorded',
  cancelled: 'Cancelled',
};
export default async function LeavePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params,
    { database, context } = await requireAccountTenant(organizationId),
    offboarding = await orNotFound(getOffboarding(database, context)),
    organization = await getOrganization(database, context);
  if (!organization) notFound();
  const configured = Boolean(getOffboardingAgents());
  return (
    <div className="stack">
      <BackLink href={`/o/${organizationId}/account`}>Account</BackLink>
      <PageHead
        title="Leave Ensemus"
        description="Export your data, complete the agreed transition, and receive a report of verified erasure and retained records."
      />
      <ErrorNotice code={(await searchParams).error} />
      <p className="notice">
        Leaving stops new work. Billing, support, exports and this page stay available during the
        transition. Erasure happens only once every check below is met, and this page cannot start
        it.
      </p>
      <div className="row">
        <ActionLink variant="secondary" href={`/o/${organizationId}/account/exports`}>
          Prepare your data export
        </ActionLink>
        <ActionLink variant="secondary" href={`/o/${organizationId}/account/support`}>
          Contact support
        </ActionLink>
      </div>
      {!configured && (
        <p className="notice">
          Leaving can’t be requested from this page for your company. Contact support to arrange the
          next steps.
        </p>
      )}
      {offboarding ? (
        <section className="stack" aria-labelledby="leaving-status">
          <h2 id="leaving-status">{labels[offboarding.state]}</h2>
          <dl className="facts">
            <dt>Export offered</dt>
            <dd>
              {offboarding.exportOfferedAt
                ? formatDateTime(offboarding.exportOfferedAt)
                : 'Pending'}
            </dd>
            <dt>Transition ends</dt>
            <dd>
              {offboarding.transitionEndsAt
                ? formatDateTime(offboarding.transitionEndsAt)
                : 'Not yet recorded from your agreement'}
            </dd>
            <dt>Active legal holds</dt>
            <dd>{offboarding.activeHolds}</dd>
            <dt>Unsettled external actions or payments</dt>
            <dd>{offboarding.unsettledActions}</dd>
          </dl>
          {offboarding.activeHolds > 0 && (
            <p className="notice">
              Active legal holds prevent erasure. An organization owner can review them under{' '}
              <Link href={`/o/${organizationId}/account/legal-holds`}>legal holds</Link>.
            </p>
          )}
          {offboarding.unsettledActions > 0 && (
            <p className="notice">
              Some actions may have reached an external service. Their outcomes must be settled
              before erasure can proceed.
            </p>
          )}
          {offboarding.report && (
            <details>
              <summary>Recorded erasure report</summary>
              <p>
                {offboarding.report.rowsRemoved} rows removed across{' '}
                {offboarding.report.erasedTables} verified empty tables.{' '}
                {offboarding.report.blobsRemoved} stored objects removed.
              </p>
              {offboarding.report.leftOver.length > 0 && (
                <ul>
                  {offboarding.report.leftOver.map((item) => (
                    <li key={item.tableRef}>
                      {item.tableRef}: {item.rows} remaining ({item.reasonCode})
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted">
                Billing records, audit, deletion evidence, account identities and backups retained
                under their published rules are listed as exceptions in the erasure report.
              </p>
            </details>
          )}
          {configured && !['erasing', 'verified', 'reported'].includes(offboarding.state) && (
            <ConfirmForm
              action={cancelOffboardingAction}
              summary="Cancel offboarding"
              consequence="I want this organization to stay. Its previous service standing will be restored, while any other existing restrictions remain."
              confirmLabel="Cancel offboarding"
              fields={
                <>
                  <input type="hidden" name="organizationId" value={organizationId} />
                  <input type="hidden" name="version" value={offboarding.version} />
                  <AccountReasonSelect forAction="cancel_offboarding" />
                </>
              }
            />
          )}
        </section>
      ) : configured ? (
        <section className="stack" aria-labelledby="request-leaving">
          <h2 id="request-leaving">Request offboarding</h2>
          <OffboardingRequestForm
            organizationId={organizationId}
            organizationName={organization.name}
          />
        </section>
      ) : null}
    </div>
  );
}
