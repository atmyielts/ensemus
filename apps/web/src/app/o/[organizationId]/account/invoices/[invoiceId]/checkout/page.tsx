import { getCheckoutOptions } from '@ensemus/application/saas/checkout';
import type { CheckoutProvider } from '@ensemus/domain/checkout';
import { can } from '@ensemus/domain/policy';
import { BillingMoney } from '@/components/billing-money';
import { SubmitButton } from '@/components/submit-button';
import { ActionLink, BackLink, Empty, ErrorNotice, PageHead } from '@/components/ui';
import { startCheckoutAction } from '@/server/checkout-actions';
import { checkoutSettings } from '@/server/checkout-settings';
import { orNotFound, requireAccountTenant } from '@/server/tenant';

export const metadata = { title: 'Pay invoice | Ensemus' };

const choices: Record<CheckoutProvider, { name: string; detail: string }> = {
  payme: {
    name: 'Payme',
    detail: "Pay in so'm on Payme's secure page with your card.",
  },
  click: {
    name: 'Click',
    detail: "Pay in so'm on Click's secure page with your card.",
  },
  paddle: {
    name: 'Visa or Mastercard',
    detail: 'Pay by card on Paddle’s secure page. Paddle processes card payments for us.',
  },
};

export default async function CheckoutChoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; invoiceId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, invoiceId } = await params;
  const { database, context } = await requireAccountTenant(organizationId);
  const options = await orNotFound(
    getCheckoutOptions(database, context, { invoiceId }, checkoutSettings()),
  );
  const base = `/o/${organizationId}/account/invoices/${options.invoiceId}`;
  const manageable = can(context.role, 'billing.manage');
  const amount = (
    <BillingMoney
      amount={options.totalMicros}
      currency={options.currency}
      minorUnitExponent={options.minorUnitExponent}
    />
  );
  return (
    <div className="stack">
      <BackLink href={base}>Invoice details</BackLink>
      <PageHead
        title="Pay this invoice"
        description="Choose how you’d like to pay. You finish on the payment company’s own secure page, then come back here to see the result."
      />
      <ErrorNotice code={(await searchParams).error} />
      <dl className="facts">
        <dt>Invoice</dt>
        <dd>{options.invoiceNumber ?? 'Draft'}</dd>
        <dt>Amount due</dt>
        <dd>{amount}</dd>
      </dl>
      {options.invoiceStatus === 'paid' ? (
        <Empty
          title="This invoice is paid"
          action={<ActionLink href={base}>Back to the invoice</ActionLink>}
        >
          There’s nothing more to pay. You can find the receipt details on the invoice.
        </Empty>
      ) : options.current ? (
        <Empty
          title="A payment is already under way"
          action={
            <ActionLink href={`${base}/checkout/${options.current.sessionId}`}>
              See payment progress
            </ActionLink>
          }
        >
          You started paying this invoice with {choices[options.current.processor].name}. See how
          it’s going before you try another way, so you’re never charged twice.
        </Empty>
      ) : options.invoiceStatus !== 'open' ? (
        <Empty
          title="This invoice can’t be paid online"
          action={
            <ActionLink href={`/o/${organizationId}/account/support`}>Contact support</ActionLink>
          }
        >
          It isn’t awaiting payment right now. Support can tell you what’s needed.
        </Empty>
      ) : options.providers.length === 0 ? (
        <Empty
          title="Online payment isn’t available for this invoice"
          action={
            <ActionLink href={`/o/${organizationId}/account/support`}>Contact support</ActionLink>
          }
        >
          Support can tell you how to pay it.
        </Empty>
      ) : !manageable ? (
        <p className="muted">An owner or administrator can pay this invoice.</p>
      ) : (
        <form className="card fields" action={startCheckoutAction}>
          <input type="hidden" name="organizationId" value={organizationId} />
          <input type="hidden" name="invoiceId" value={options.invoiceId} />
          <fieldset className="choice-list">
            <legend>How would you like to pay?</legend>
            {options.providers.map((provider, index) => (
              <label className="choice" key={provider}>
                <input
                  type="radio"
                  name="provider"
                  value={provider}
                  defaultChecked={index === 0}
                  required
                />
                <strong>{choices[provider].name}</strong>
                <small>{choices[provider].detail}</small>
              </label>
            ))}
          </fieldset>
          {options.providers.includes('payme') && (
            <label>
              Language on Payme’s page
              <small>Only Payme asks for this. Click and Paddle choose for you.</small>
              <select name="language" defaultValue="uz">
                <option value="uz">O‘zbekcha</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
            </label>
          )}
          <p className="muted">
            You’ll pay exactly {amount}. Nothing is charged until you confirm on the payment page.
          </p>
          <div>
            <SubmitButton>Continue to payment</SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
