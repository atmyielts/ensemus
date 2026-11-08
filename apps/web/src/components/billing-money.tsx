import { formatMoney } from '@ensemus/saas/money';

/** Exact display when a line has sub-minor precision; a published exponent is used for payable totals. */
export function BillingMoney({
  amount,
  currency,
  minorUnitExponent,
}: {
  amount: bigint;
  currency: string;
  minorUnitExponent?: number | null;
}) {
  if (minorUnitExponent !== undefined && minorUnitExponent !== null)
    return <span>{formatMoney(amount, currency, minorUnitExponent)}</span>;
  const size = amount < 0n ? -amount : amount;
  const fraction = (size % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (
    <span>
      {amount < 0n ? '-' : ''}
      {(size / 1_000_000n).toString()}
      {fraction ? '.' + fraction : ''} {currency}
    </span>
  );
}
