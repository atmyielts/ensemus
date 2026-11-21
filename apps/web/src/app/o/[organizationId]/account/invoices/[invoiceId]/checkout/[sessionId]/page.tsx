import { getCheckoutStatus } from '@ensemus/application/saas/checkout';
import type { CheckoutProvider } from '@ensemus/domain/checkout';
import { can } from '@ensemus/domain/policy';
import type { CheckoutDisplay } from '@ensemus/saas/checkout';
import { BillingMoney } from '@/components/billing-money';
import { ConfirmForm } from '@/components/confirm-form';
import {
  ActionLink,
  BackLink,
  ErrorNotice,
  PageHead,
  ReloadLink,
  formatDateTime,
} from '@/components/ui';
import { closeCheckoutAction } from '@/server/checkout-actions';
import { orNotFound, requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Payment status | Ensemus' };

const names: Record<CheckoutProvider, string> = {
  payme: 'Payme',
  click: 'Click',
  paddle: 'Card, through Paddle',
};

// What each state honestly means for the person paying. A payment is never shown as paid until the
// payment company has confirmed it to us, and never as failed while it could still go through.
const copy: Record<CheckoutDisplay, { title: string; description: string }> = {
  preparing: {
    title: 'Getting your payment page ready',
    description: 'This usually takes a few seconds. Check again in a moment to continue.',
  },
  waiting: {
    title: 'Waiting for your payment',
    description:
      'Nothing has been taken yet. Finish on the payment page, and this page shows the result once the payment company confirms it.',
  },
  processing: {
    title: 'Your payment is being processed',
    description:
      'The payment company has started your payment. Please don’t pay again: this page updates as soon as it’s confirmed.',
  },
  paid: {
    title: 'Payment received',
    description: 'Thank you. The payment company confirmed your payment, and the invoice is paid.',
  },
  not_paid: {
    title: 'This payment didn’t go through',
    description: 'No money was taken for it. You can choose a way to pay again.',
  },
  refunded: {
    title: 'This payment was refunded',
    description:
      'The payment company returned this payment. We’ve let your account owners know, and support can help with what happens next.',
  },
};

export default async function CheckoutStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; invoiceId: string; sessionId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, invoiceId, sessionId } = await params;
  const { database, context } = await requireAccountTenant(organizationId);
  const status = await orNotFound(getCheckoutStatus(database, context, { invoiceId, sessionId }));
  const invoicePath = `/o/${organizationId}/account/invoices/${status.invoiceId}`;
  const here = `${invoicePath}/checkout/${status.sessionId}`;
  const words = copy[status.display];
  const manageable = can(context.role, 'billing.manage');
  return (
    <div className="stack">
      <BackLink href={invoicePath}>Invoice details</BackLink>
      <PageHead title={words.title} description={words.description} />
      <ErrorNotice code={(await searchParams).error} />
      <section className="card stack" aria-labelledby="payment-summary">
        <h2 id="payment-summary">Payment</h2>
        <dl className="facts">
          <dt>Amount</dt>
          <dd>
            <BillingMoney
              amount={status.amountMicros}
              currency={status.currency}
              minorUnitExponent={status.minorUnitExponent}
            />
          </dd>
          <dt>Paying with</dt>
          <dd>{names[status.processor]}</dd>
          <dt>Last update</dt>
          <dd>{formatDateTime(status.updatedAt)}</dd>
        </dl>
        <div className="row">
          {status.display === 'waiting' && status.checkoutUrl ? (
            <ActionLink href={status.checkoutUrl}>Go to the payment page</ActionLink>
          ) : status.display === 'paid' || status.display === 'refunded' ? (
            <ActionLink href={invoicePath}>Back to the invoice</ActionLink>
          ) : status.display === 'not_paid' ? (
            <ActionLink href={`${invoicePath}/checkout`}>Choose a way to pay</ActionLink>
          ) : (
            <ReloadLink href={here}>Check again</ReloadLink>
          )}
          {status.display === 'waiting' && <ReloadLink href={here}>Check again</ReloadLink>}
        </div>
      </section>
      {status.closable && manageable && (
        <ConfirmForm
          action={closeCheckoutAction}
          summary="Pay another way instead"
          consequence="I haven’t paid on this payment page, and I want to choose another way to pay."
          confirmLabel="Close this payment page"
          fields={
            <>
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="invoiceId" value={status.invoiceId} />
              <input type="hidden" name="sessionId" value={status.sessionId} />
            </>
          }
        />
      )}
    </div>
  );
}
