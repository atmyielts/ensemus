import { randomUUID } from 'node:crypto';
import { getCreditSummary } from '@ensemus/application/saas/credits';
import { listTopUpOffers } from '@ensemus/application/saas/catalog';
import { listTopUps } from '@ensemus/application/saas/top-ups';
import { loadSaasConfig } from '@ensemus/config';
import { quoteHash } from '@ensemus/saas/credits';
import Link from 'next/link';
import { ConfirmForm } from '@/components/confirm-form';
import { BillingMoney } from '@/components/billing-money';
import { Empty, ErrorNotice, formatDateTime, PageHead } from '@/components/ui';
import { requestTopUpAction } from '@/server/credit-actions';
import { orNotFound, requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Credits | Ensemus' };
export default async function CreditsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId } = await params;
  const { error } = await searchParams;
  const { database, context } = await requireAccountTenant(organizationId);
  const [summary, offers, topUps] = await Promise.all([
    orNotFound(getCreditSummary(database, context)),
    orNotFound(listTopUpOffers(database, context)),
    orNotFound(listTopUps(database, context)),
  ]);
  const enabled = loadSaasConfig().billingEnabled;
  return (
    <div className="stack">
      <PageHead
        title="Credits"
        description="Model capacity and the orders you explicitly request."
        actions={<Link href={`/o/${organizationId}/account/billing`}>Billing</Link>}
      />
      <ErrorNotice code={error} />
      {summary.balanceMicrocredits === null ? (
        <p className="notice">
          This account has no Ensemus model credit balance. Your own provider bills model usage in
          BYOM.
        </p>
      ) : (
        <>
          <dl className="facts">
            <dt>Remaining microcredits</dt>
            <dd>{summary.balanceMicrocredits.toString()}</dd>
            <dt>Included each period</dt>
            <dd>{summary.includedMicrocredits?.toString() ?? 'No allowance published'}</dd>
          </dl>
          {summary.balanceMicrocredits <= 0n && (
            <p className="notice" role="status">
              Model activity is paused because capacity is exhausted. No top-up is bought
              automatically.{' '}
              {summary.overagePolicy === 'explicit_top_up'
                ? 'Review an available top-up below.'
                : 'Contact the operator about an approved plan change.'}
            </p>
          )}
        </>
      )}
      <section className="stack" aria-labelledby="top-ups-title">
        <h2 id="top-ups-title">Available top-ups</h2>
        {!enabled ? (
          <p>Purchases are unavailable while hosted billing is disabled.</p>
        ) : offers.length === 0 ? (
          <Empty>No top-up is available for this account’s current plan and standing.</Empty>
        ) : (
          <ul className="list">
            {offers.map((offer) => (
              <li key={offer.offerId}>
                <div>
                  <strong>{offer.microcredits.toString()} microcredits</strong>
                  <p>
                    <BillingMoney amount={offer.priceMicros} currency={offer.currency} /> before
                    applicable tax and currency rounding. Review the invoice before payment.
                  </p>
                </div>
                <ConfirmForm
                  action={requestTopUpAction}
                  fields={
                    <>
                      <input type="hidden" name="organizationId" value={organizationId} />
                      <input type="hidden" name="offerId" value={offer.offerId} />
                      <input type="hidden" name="quoteHash" value={quoteHash(offer)} />
                      <input type="hidden" name="requestKey" value={randomUUID()} />
                    </>
                  }
                  summary="Review top-up"
                  consequence="I request this top-up at the price shown. Credits arrive only after its invoice is paid."
                  confirmLabel="Create top-up invoice"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="stack" aria-labelledby="orders-title">
        <h2 id="orders-title">Top-up orders</h2>
        {topUps.length === 0 ? (
          <Empty>No top-ups have been requested.</Empty>
        ) : (
          <ul className="list">
            {topUps.map((order) => (
              <li key={order.id}>
                <span>
                  <BillingMoney amount={order.priceMicros} currency={order.currency} /> ·{' '}
                  {order.status}
                </span>
                <span>{formatDateTime(order.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="stack" aria-labelledby="credit-history-title">
        <h2 id="credit-history-title">Recent credit activity</h2>
        {summary.recent.length === 0 ? (
          <Empty>No credit activity yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <caption>Credit ledger entries, most recent first</caption>
              <thead>
                <tr>
                  <th scope="col">Activity</th>
                  <th scope="col">Microcredits</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {summary.recent.map((entry, index) => (
                  <tr key={index}>
                    <td>{entry.kind}</td>
                    <td>{entry.amountMicrocredits.toString()}</td>
                    <td>{formatDateTime(entry.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
