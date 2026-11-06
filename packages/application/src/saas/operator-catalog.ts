// What the operator's commands do to the global price list, as `ensemus_operator`. It is here, and not in
// the web tier, because there is no web path to it at all. Owned by the catalog slice. See ADR-032 D2, D3.
import type { EnsemusDrizzle } from '@ensemus/database/operator';

export type OperatorDb = EnsemusDrizzle;
export type OperatorRef = { operatorRef: string };

export type DraftRateCardInput = OperatorRef & {
  code: string;
  currency: string;
  minorUnitExponent: number;
  lines: readonly { meter: string; unit: string; microcreditsPerUnit: bigint }[];
  topUpOffers: readonly { code: string; microcredits: bigint; priceMicros: bigint }[];
};

/** Writes the next version as a draft. Every number comes from the caller: there are no defaults. */
export function draftRateCard(
  _db: OperatorDb,
  _input: DraftRateCardInput,
): Promise<{ rateCardId: string; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Approves a draft from a set date, and retires what it replaces only for new periods. Audited. */
export function approveRateCard(
  _db: OperatorDb,
  _input: OperatorRef & { rateCardId: string; effectiveFrom: Date },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

export type DraftPlanVersionInput = OperatorRef & {
  planCode: string;
  displayName: string;
  commercialMode: 'cloud' | 'byom';
  currency: string;
  billingInterval: 'month' | 'year';
  paymentTermsDays: number;
  platformFeeMicros: bigint;
  includedMicrocredits: bigint | null;
  rateCardId: string | null;
  overagePolicy: 'pause' | 'explicit_top_up' | null;
  features: readonly string[];
  maxActiveMembers: number | null;
};

export function draftPlanVersion(
  _db: OperatorDb,
  _input: DraftPlanVersionInput,
): Promise<{ planVersionId: string; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

export function approvePlanVersion(
  _db: OperatorDb,
  _input: OperatorRef & { planVersionId: string },
): Promise<void> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Terms reference and steps both required. Without an approved one, collection takes no action. */
export function publishCollectionPolicy(
  _db: OperatorDb,
  _input: OperatorRef & {
    termsRef: string;
    steps: readonly { afterDays: number; action: string }[];
  },
): Promise<{ policyId: string; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** Records an adviser's guidance for a place. `adviserRef` is required, because it is the only basis. */
export function publishTaxTreatment(
  _db: OperatorDb,
  _input: OperatorRef & {
    countryCode: string;
    regionCode: string;
    treatment: 'provider_computed' | 'not_collected';
    adviserRef: string;
  },
): Promise<{ treatmentId: string; version: number }> {
  throw new Error('NOT_IMPLEMENTED');
}

/** A provider's bill, entered by hand from their invoice. */
export function enterProviderBill(
  _db: OperatorDb,
  _input: OperatorRef & {
    providerKind: string;
    periodStart: Date;
    periodEnd: Date;
    currency: string;
    amountMicros: bigint;
    sourceRef: string;
  },
): Promise<{ providerBillId: string }> {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * The real reader, in raw SQL over M4's `platform.usage_ledger` columns as landed (`provider_kind`, `billable`,
 * `cost_micros`, `created_at`). Raw, so this file does not need M4's Drizzle table to compile. Migration 0501
 * grants the operator this table once it exists.
 */
export function createProviderCostReader(_db: OperatorDb): import('./ports').ProviderCostPort {
  throw new Error('NOT_IMPLEMENTED');
}

/**
 * Sets a bill against the ledger through ProviderCostPort, and stores the difference. It reports, and
 * decides nothing: a person says reconciled or disputed (BILL-04). There is no tolerance in code.
 */
export function reconcileProviderBill(
  _db: OperatorDb,
  _input: OperatorRef & {
    providerBillId: string;
    decision: 'reconciled' | 'disputed' | null;
  },
  _ledger: import('./ports').ProviderCostPort,
): Promise<{ ledgerCostMicros: bigint; differenceMicros: bigint }> {
  throw new Error('NOT_IMPLEMENTED');
}
