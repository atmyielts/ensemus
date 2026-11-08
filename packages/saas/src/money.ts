// Money as whole micro-units of a currency, in bigint (ADR-032 D1). A float cannot add up an invoice, and
// the same unit is what M4's ledger records. No amount, currency or rate is ever written in code.

/** One millionth of a currency's main unit. */
export type Micros = bigint;
/** One millionth of an AI credit. What a credit is worth is on the rate card. */
export type Microcredits = bigint;

const MICROS_PER_UNIT = 1_000_000n;

/** A currency's smallest unit in micros. The exponent is rate card data, since it is not ours to assume. */
export function minorUnitMicros(minorUnitExponent: number): Micros {
  if (!Number.isInteger(minorUnitExponent) || minorUnitExponent < 0 || minorUnitExponent > 4) {
    throw new RangeError('INVALID_MINOR_UNIT');
  }
  return MICROS_PER_UNIT / 10n ** BigInt(minorUnitExponent);
}

/**
 * Rounds to something a processor can charge, half away from zero. Exact sums are kept on the lines, and
 * what this adds or takes away goes on its own `rounding` line, so an invoice still adds up to the micro.
 * The rounding rule is a reversible default in ADR-032 D1, and the adviser may ask for another.
 */
export function roundToMinorUnit(amount: Micros, minorUnitExponent: number): Micros {
  const unit = minorUnitMicros(minorUnitExponent);
  const negative = amount < 0n;
  const size = negative ? -amount : amount;
  const rounded = ((size + unit / 2n) / unit) * unit;
  return negative ? -rounded : rounded;
}

/** How money crosses an API: a string of digits, because JSON numbers cannot hold every bigint. */
export const microsToWire = (amount: bigint): string => amount.toString();

const WIRE = /^-?(0|[1-9][0-9]{0,18})$/;

export function microsFromWire(wire: string): bigint {
  if (!WIRE.test(wire)) throw new RangeError('INVALID_AMOUNT');
  return BigInt(wire);
}

/** Shows an amount with its code and no assumed symbol. For people, never for arithmetic. */
export function formatMoney(amount: Micros, currency: string, minorUnitExponent: number): string {
  const unit = minorUnitMicros(minorUnitExponent);
  const negative = amount < 0n;
  const size = negative ? -amount : amount;
  const whole = size / MICROS_PER_UNIT;
  const fraction = ((size % MICROS_PER_UNIT) / unit)
    .toString()
    .padStart(minorUnitExponent, '0')
    .slice(0, minorUnitExponent);
  const shown = minorUnitExponent === 0 ? whole.toString() : `${whole}.${fraction}`;
  return `${negative ? '-' : ''}${shown} ${currency}`;
}
