import { randomUUID } from 'node:crypto';
import { getInvoice } from '@ensemus/application/saas/invoices';
import { listInvoicePayments } from '@ensemus/application/saas/payments';
import { loadSaasConfig } from '@ensemus/config';
import { can } from '@ensemus/domain/policy';
import Link from 'next/link';
import { BillingMoney } from '@/components/billing-money';
import { ConfirmForm } from '@/components/confirm-form';
import { BackLink, Empty, ErrorNotice, PageHead, formatDateTime } from '@/components/ui';
import { requestPaymentAction, resolvePaymentAction } from '@/server/payment-actions';
import { orNotFound, requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Payment | Ensemus' };
const labels: Record<string, string> = {
  ready: 'Waiting to start',
  sending: 'Processing',
  reconciling: 'Checking the processor',
  succeeded: 'Paid',
  failed: 'Unsuccessful',
  unknown: 'Payment outcome unknown',
  cancelled: 'Cancelled',
};
export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; invoiceId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, invoiceId } = await params;
  const { database, context } = await requireAccountTenant(organizationId);
  const [invoice, payments] = await Promise.all([
    orNotFound(getInvoice(database, context, invoiceId)),
    orNotFound(listInvoicePayments(database, context, { invoiceId })),
  ]);
  const config = loadSaasConfig(),
    base = `/o/${organizationId}/account/invoices/${invoice.id}`;
  const live = payments.find((payment) =>
    ['ready', 'sending', 'reconciling', 'unknown', 'succeeded'].includes(payment.status),
  );
  const manageable = can(context.role, 'billing.manage');
  return (
    <div className="stack">
      <BackLink href={base}>Invoice details</BackLink>
      <PageHead
        title="Review payment"
        description="Check the invoice before it is charged to your saved payment method."
      />
      <ErrorNotice code={(await searchParams).error} />
      <dl className="facts">
        <dt>Invoice</dt>
        <dd>{invoice.invoiceNumber ?? 'Draft'}</dd>
        <dt>Total</dt>
        <dd>
          <BillingMoney
            amount={invoice.totalMicros}
            currency={invoice.currency}
            minorUnitExponent={invoice.minorUnitExponent}
          />
        </dd>
        <dt>Status</dt>
        <dd>{invoice.status}</dd>
      </dl>
      {invoice.status === 'paid' ? (
        <p className="notice">This invoice is paid. No further payment is needed.</p>
      ) : live?.status === 'unknown' ? (
        <p className="notice" role="status">
          The processor may have charged this invoice. Automatic attempts have stopped. Check the
          processor record or contact support before confirming that no charge occurred.
        </p>
      ) : live ? (
        <p className="notice" role="status">
          {labels[live.status]}. This page shows the last recorded result. Reload to check for an
          update.
        </p>
      ) : invoice.status !== 'open' ? (
        <p className="notice">
          This invoice cannot currently be paid. Review its details or contact support.
        </p>
      ) : !config.billingEnabled || !config.paymentProcessor ? (
        <p className="notice">
          Paying online isn’t set up for your company. Contact support for how to pay this invoice.
        </p>
      ) : manageable ? (
        <ConfirmForm
          action={requestPaymentAction}
          summary="Pay this invoice"
          consequence="I authorize the exact invoice total shown above to be charged using the processor's recorded payment method."
          confirmLabel="Request payment"
          fields={
            <>
              <input type="hidden" name="organizationId" value={organizationId} />
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <input type="hidden" name="requestKey" value={randomUUID()} />
            </>
          }
        />
      ) : (
        <p className="muted">An owner or administrator can request payment.</p>
      )}
      <section className="stack" aria-labelledby="payment-history">
        <h2 id="payment-history">Payment history</h2>
        {payments.length === 0 ? (
          <Empty>No payment has been requested for this invoice.</Empty>
        ) : (
          <ul className="list">
            {payments.map((payment) => (
              <li key={payment.id}>
                <div>
                  <strong>{labels[payment.status]}</strong>
                  <p className="muted">{formatDateTime(payment.createdAt)}</p>
                </div>
                {payment.status === 'unknown' && manageable && (
                  <ConfirmForm
                    action={resolvePaymentAction}
                    summary="Confirm no charge occurred"
                    consequence="I have verified the processor's records and confirm that this payment did not charge the invoice. This closes the uncertain attempt and permits a new payment request."
                    confirmLabel="Confirm no charge"
                    fields={
                      <>
                        <input type="hidden" name="organizationId" value={organizationId} />
                        <input type="hidden" name="invoiceId" value={invoice.id} />
                        <input type="hidden" name="paymentId" value={payment.id} />
                        <input type="hidden" name="expectedVersion" value={payment.version} />
                      </>
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <Link href={`/o/${organizationId}/account/support`}>Contact support</Link>
    </div>
  );
}
