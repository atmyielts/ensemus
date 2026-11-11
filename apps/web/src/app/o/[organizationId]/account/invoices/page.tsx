import { listInvoices } from '@ensemus/application/saas/invoices';
import { AppError } from '@ensemus/application';
import Link from 'next/link';
import { BillingMoney } from '@/components/billing-money';
import { BackLink, Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { orNotFound, requireAccountTenant } from '@/server/tenant';
export const metadata = { title: 'Invoices | Ensemus' };
const statusWords: Record<string, string> = {
  draft: 'Draft',
  open: 'Awaiting payment',
  paid: 'Paid',
  void: 'Void',
  uncollectible: 'Uncollectible',
};
export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { organizationId } = await params;
  const { cursor } = await searchParams;
  const { database, context } = await requireAccountTenant(organizationId);
  let page: Awaited<ReturnType<typeof listInvoices>>;
  try {
    page = await orNotFound(listInvoices(database, context, cursor ? { after: cursor } : {}));
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'INVALID_INPUT') throw error;
    return (
      <div className="stack">
        <PageHead title="Invoices" />
        <ErrorNotice code="INVALID_INPUT" />
        <Link href={`/o/${organizationId}/account/invoices`}>Latest invoices</Link>
      </div>
    );
  }
  return (
    <div className="stack">
      <BackLink href={`/o/${organizationId}/account/billing`}>Billing</BackLink>
      <PageHead
        title="Invoices"
        description="Bills for your plan and for any top-ups you ordered."
      />
      {page.items.length === 0 ? (
        <Empty title="No invoices yet">
          No invoices have been created. Bills for your plan and top-ups appear here.
        </Empty>
      ) : (
        <div className="table-wrap row-titled">
          <table>
            <caption>Invoices, most recent first</caption>
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col">Status</th>
                <th scope="col">Total</th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <Link href={`/o/${organizationId}/account/invoices/${row.id}`}>
                      {row.invoiceNumber === null
                        ? 'Draft invoice'
                        : `Invoice ${row.invoiceNumber}`}
                    </Link>
                    <p className="muted">{row.kind === 'top_up' ? 'Top-up' : 'Subscription'}</p>
                  </th>
                  <td>{statusWords[row.status] ?? row.status}</td>
                  <td>
                    <BillingMoney amount={row.totalMicros} currency={row.currency} />
                    {row.status === 'draft' && <p className="muted">Before final tax</p>}
                  </td>
                  <td>{row.dueAt ? formatDateTime(row.dueAt) : 'Not issued'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor && (
        <Link
          href={`/o/${organizationId}/account/invoices?cursor=${encodeURIComponent(page.nextCursor)}`}
        >
          Older invoices
        </Link>
      )}
    </div>
  );
}
