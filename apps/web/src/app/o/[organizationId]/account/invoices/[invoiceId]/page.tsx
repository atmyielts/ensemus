import { getInvoice } from '@ensemus/application/saas/invoices';
import Link from 'next/link';
import { BillingMoney } from '@/components/billing-money';
import { BackLink, PageHead, formatDateTime } from '@/components/ui';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
export const metadata = { title: 'Invoice | Ensemus' };
const kinds: Record<string, string> = {
  platform_fee: 'Platform subscription',
  usage: 'Prepaid usage statement',
  top_up: 'Approved top-up',
  tax: 'Tax',
  rounding: 'Currency rounding',
};
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ organizationId: string; invoiceId: string }>;
}) {
  const { organizationId, invoiceId } = await params;
  const { database, context } = await requireAccountTenant(organizationId);
  const invoice = await orNotFound(getInvoice(database, context, invoiceId));
  const base = `/o/${organizationId}/account/invoices`;
  return (
    <div className="stack">
      <BackLink href={base}>All invoices</BackLink>
      <PageHead
        title={
          invoice.invoiceNumber === null ? 'Draft invoice' : `Invoice ${invoice.invoiceNumber}`
        }
        description={
          invoice.kind === 'top_up'
            ? 'A top-up of AI model use that you ordered.'
            : 'Your plan’s terms and what was used in this period.'
        }
      />
      {invoice.status === 'draft' ? (
        <p className="notice">
          This invoice is a draft. Tax and its final payable total are still being checked. Nothing
          has been charged.
        </p>
      ) : (
        <p className="notice">
          Status:{' '}
          {invoice.status === 'open'
            ? 'Awaiting payment'
            : invoice.status === 'void'
              ? 'Void'
              : invoice.status === 'paid'
                ? 'Paid'
                : 'Uncollectible'}
          . {invoice.paidAt && <>Paid {formatDateTime(invoice.paidAt)}.</>}
        </p>
      )}
      <dl className="facts">
        <dt>Issued</dt>
        <dd>{invoice.issuedAt ? formatDateTime(invoice.issuedAt) : 'Not issued'}</dd>
        <dt>Due</dt>
        <dd>{invoice.dueAt ? formatDateTime(invoice.dueAt) : 'Not issued'}</dd>
        {invoice.source.startsAt && invoice.source.endsAt && (
          <>
            <dt>Service period</dt>
            <dd>
              {formatDateTime(invoice.source.startsAt)} – {formatDateTime(invoice.source.endsAt)}
            </dd>
          </>
        )}
      </dl>
      <div className="table-wrap">
        <table>
          <caption>Every invoice line in {invoice.currency}</caption>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col">Quantity</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.lineNo}>
                <th scope="row">
                  {kinds[line.kind] ?? line.kind}
                  {line.meter && <p className="muted">{line.meter}</p>}
                </th>
                <td>
                  {line.quantity === null ? '—' : `${line.quantity.toString()} ${line.unit ?? ''}`}
                </td>
                <td>
                  <BillingMoney amount={line.amountMicros} currency={invoice.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="facts">
        <dt>Subtotal including rounding</dt>
        <dd>
          <BillingMoney amount={invoice.subtotalMicros} currency={invoice.currency} />
        </dd>
        <dt>Tax</dt>
        <dd>
          <BillingMoney amount={invoice.taxMicros} currency={invoice.currency} />
        </dd>
        <dt>{invoice.status === 'draft' ? 'Draft total' : 'Total'}</dt>
        <dd>
          <strong>
            <BillingMoney
              amount={invoice.totalMicros}
              currency={invoice.currency}
              minorUnitExponent={invoice.minorUnitExponent}
            />
          </strong>
        </dd>
      </dl>
      {invoice.lines.some((line) => line.kind === 'usage') && (
        <p className="muted">
          Prepaid usage is informational and is not charged again here. This statement reflects
          entries recorded when the invoice was drafted. Late entries and corrections appear in{' '}
          <Link href={`/o/${organizationId}/account/credits`}>credit activity</Link>.
        </p>
      )}
      {(invoice.status === 'open' || invoice.status === 'uncollectible') && (
        <div>
          <Link className="button" href={`${base}/${invoice.id}/pay`}>
            Review payment
          </Link>
        </div>
      )}
      <details>
        <summary>Pricing record</summary>
        <dl className="facts">
          <dt>Plan version</dt>
          <dd>{invoice.source.planVersionId ?? 'Not applicable'}</dd>
          <dt>Rate card</dt>
          <dd>{invoice.source.rateCardId ?? 'No inference billed by Ensemus'}</dd>
          <dt>Billing period</dt>
          <dd>{invoice.source.billingPeriodId ?? 'Explicit top-up order'}</dd>
        </dl>
      </details>
    </div>
  );
}
