import { randomUUID } from 'node:crypto';
import { listAvailablePlans } from '@ensemus/application/saas/catalog';
import { getBillingOverview } from '@ensemus/application/saas/subscriptions';
import { loadSaasConfig } from '@ensemus/config';
import { can } from '@ensemus/domain/policy';
import { BillingAccountForm } from '@/components/billing-account-form';
import { BillingMoney } from '@/components/billing-money';
import { ConfirmForm } from '@/components/confirm-form';
import { SubmitButton } from '@/components/submit-button';
import {
  ActionLink,
  BackLink,
  Empty,
  ErrorNotice,
  formatDateTime,
  PageHead,
} from '@/components/ui';
import {
  changePlanAction,
  requestCancellationAction,
  startSubscriptionAction,
  withdrawCancellationAction,
} from '@/server/billing-actions';
import { orNotFound, requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Billing | Ensemus' };
export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string; changed?: string }>;
}) {
  const { organizationId } = await params;
  const { error, changed } = await searchParams;
  const { database, context } = await requireAccountTenant(organizationId);
  const [overview, plans] = await Promise.all([
    orNotFound(getBillingOverview(database, context, loadSaasConfig())),
    orNotFound(listAvailablePlans(database, context)),
  ]);
  const sub = overview.subscription;
  const live = sub && sub.status !== 'canceled';
  const canManage = can(context.role, 'billing.manage');
  const fields = (
    <>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="version" value={sub?.version ?? ''} />
    </>
  );
  return (
    <div className="stack">
      <BackLink href={`/o/${organizationId}/account`}>Account</BackLink>
      <PageHead
        title="Billing"
        description="Your plan, what it includes, and the details your bills are addressed to."
      />
      <ErrorNotice code={error} />
      {changed === 'period_end' && (
        <p className="notice good" role="status">
          Your plan change is scheduled for the end of this period. Your existing access stays until
          then. No data is removed.
        </p>
      )}
      {changed === 'now' && (
        <p className="notice good" role="status">
          Your plan change is active. Your current billing period keeps its recorded terms.
        </p>
      )}
      {!overview.billingEnabled && (
        <p className="notice">
          Buying a plan online isn’t available for your company, so there is nothing to buy on this
          page. Your current plan and billing details are still here.
        </p>
      )}
      <nav className="row" aria-label="Billing">
        <ActionLink variant="secondary" href={`/o/${organizationId}/account/invoices`}>
          Invoices
        </ActionLink>
        <ActionLink variant="secondary" href={`/o/${organizationId}/account/credits`}>
          Credits and top-ups
        </ActionLink>
      </nav>
      <section aria-labelledby="subscription-title" className="stack">
        <h2 id="subscription-title">Subscription</h2>
        {overview.scheduledPlanChange && (
          <p className="notice">
            A plan change is scheduled for{' '}
            {formatDateTime(overview.scheduledPlanChange.effectiveAt)}.{' '}
            {Object.keys(overview.scheduledPlanChange.excess).length > 0 &&
              'Usage above the new limits becomes read-only; your data stays.'}
          </p>
        )}
        {sub ? (
          <>
            <dl className="facts">
              <dt>Status</dt>
              <dd>
                {sub.status === 'past_due'
                  ? 'Payment past due'
                  : sub.status === 'canceled'
                    ? 'Canceled'
                    : 'Active'}
              </dd>
              <dt>Current period</dt>
              <dd>
                {formatDateTime(sub.currentPeriodStart)} – {formatDateTime(sub.currentPeriodEnd)}
              </dd>
            </dl>
            {sub.cancelAtPeriodEnd && (
              <p className="notice">
                Cancellation is scheduled for {formatDateTime(sub.currentPeriodEnd)}. Your data is
                kept.
              </p>
            )}
            {canManage &&
              live &&
              overview.billingEnabled &&
              (sub.cancelAtPeriodEnd ? (
                <form action={withdrawCancellationAction}>
                  {fields}
                  <SubmitButton className="quiet">Keep subscription</SubmitButton>
                </form>
              ) : (
                <ConfirmForm
                  action={requestCancellationAction}
                  fields={fields}
                  summary="Cancel subscription"
                  consequence="I understand service continues until the current period ends and cancellation does not erase data."
                  confirmLabel="Schedule cancellation"
                />
              ))}
          </>
        ) : (
          <Empty title="No plan yet">
            No subscription has been started. Once your company is on a plan, its status and current
            billing period show here.
          </Empty>
        )}
      </section>
      <section aria-labelledby="plan-title" className="stack">
        <h2 id="plan-title">Available plans</h2>
        {plans.length === 0 ? (
          <Empty title="No plans to choose from yet">
            No plans are available to your company yet. Ask Support about the plans and terms that
            fit you.
          </Empty>
        ) : (
          <ul className="list">
            {plans.map((plan) => (
              <li key={plan.planVersionId} className="block">
                <div className="spread">
                  <div>
                    <strong>{plan.displayName}</strong>
                    <p>
                      <BillingMoney amount={plan.platformFeeMicros} currency={plan.currency} /> per{' '}
                      {plan.billingInterval}
                    </p>
                  </div>
                  {sub?.planVersionId === plan.planVersionId ? (
                    <span className="badge">Current plan</span>
                  ) : (
                    canManage &&
                    overview.billingEnabled && (
                      <form action={live ? changePlanAction : startSubscriptionAction}>
                        {fields}
                        <input type="hidden" name="planVersionId" value={plan.planVersionId} />
                        <input type="hidden" name="requestKey" value={randomUUID()} />
                        <SubmitButton
                          className="quiet"
                          label={`${live ? 'Change to' : 'Start'} ${plan.displayName}`}
                        >
                          {live ? 'Change plan' : 'Start subscription'}
                        </SubmitButton>
                      </form>
                    )
                  )}
                </div>
                <p>
                  Payment terms: {plan.paymentTermsDays} days.{' '}
                  {plan.maxActiveMembers === null
                    ? 'No published member cap.'
                    : `Up to ${plan.maxActiveMembers} active members.`}
                </p>
                <p>
                  {plan.includedMicrocredits === null
                    ? 'Model usage is billed by your own provider.'
                    : `Included capacity: ${plan.includedMicrocredits.toString()} microcredits. ${plan.overagePolicy === 'explicit_top_up' ? 'Additional capacity requires an explicit top-up.' : 'Model activity pauses when capacity is exhausted.'}`}
                </p>
                {plan.features.length > 0 && <p>Included features: {plan.features.join(', ')}.</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Moving to a smaller plan happens at the end of your current billing period. Anything over
          the new plan’s limits becomes read-only, and your data stays.
        </p>
      </section>
      <section aria-labelledby="details-title" className="card stack">
        <div>
          <h2 id="details-title">Billing details</h2>
          <p className="muted">The name and address your billing is under.</p>
        </div>
        {canManage ? (
          <BillingAccountForm organizationId={organizationId} account={overview.account} />
        ) : (
          <p>Ask an account administrator to update billing details.</p>
        )}
      </section>
    </div>
  );
}
