// What a tenant may use (COMM-01). Pure. Feature authorization is apart from billing arithmetic, so money
// can never override a security or legal control (docs/07-commercial/02-entitlements-and-billing.md §1, §6).
// Owned by the subscriptions slice. See docs/06-delivery/m8-slices.md.
import type { PlanTerms } from './catalog';
import type { Microcredits } from './money';

/** The lifecycle values on org.organizations, and what each means for a person using the tenant. */
export const TENANT_LIFECYCLES = [
  'active',
  'read_only',
  'suspended',
  'offboarding',
  'deleted',
] as const;
export type TenantLifecycle = (typeof TENANT_LIFECYCLES)[number];

/** The moves a person or the system may make. `offboarding` to `deleted` also needs a finished erasure. */
export const TENANT_LIFECYCLE_TRANSITIONS: Readonly<
  Record<TenantLifecycle, readonly TenantLifecycle[]>
> = {
  active: ['read_only', 'suspended', 'offboarding'],
  read_only: ['active', 'suspended', 'offboarding'],
  suspended: ['active', 'read_only', 'offboarding'],
  offboarding: ['active', 'deleted'],
  deleted: [],
};

export const ENTITLEMENT_CODES = [
  'ALLOWED',
  'NO_SUBSCRIPTION',
  'SUBSCRIPTION_CANCELED',
  'TENANT_NOT_ACTIVE',
  'FEATURE_NOT_LICENSED',
  'CREDITS_EXHAUSTED',
  'CUSTOMER_BILLED',
  'BILLING_NOT_ENABLED',
] as const;
export type EntitlementCode = (typeof ENTITLEMENT_CODES)[number];

export type EntitlementFacts = {
  /** Billing is off on this deployment. Sovereign is always off: see `evaluateEntitlement`. */
  billingEnabled: boolean;
  commercialMode: 'cloud' | 'byom' | 'sovereign';
  lifecycle: TenantLifecycle;
  plan: PlanTerms | null;
  subscriptionStatus: 'active' | 'past_due' | 'canceled' | null;
  balanceMicrocredits: Microcredits | null;
};

export type EntitlementRequest =
  | { kind: 'feature'; feature: string }
  /** About to spend Ensemus-supplied inference. Never asked for BYOM, which answers CUSTOMER_BILLED. */
  | { kind: 'model_capacity'; estimatedMicrocredits: Microcredits };

export type EntitlementDecision = {
  allowed: boolean;
  code: EntitlementCode;
  /** Shown to an admin. It says what to do, such as top up, and carries nothing from a tenant's data. */
  remedy: 'none' | 'top_up' | 'upgrade' | 'pay_invoice' | 'contact_operator';
};

/**
 * The evaluation order is: deployment, standing, subscription, feature, capacity. It answers only "is this
 * licensed": policy and authorization still decide afterwards, and an allow here can never override them.
 * Sovereign has no subscription and no heartbeat, so it answers from `billingEnabled: false`, ALLOWED, and
 * M6's license check is what governs it. BYOM capacity is ALLOWED with CUSTOMER_BILLED, and never spends.
 */
export function evaluateEntitlement(
  _facts: EntitlementFacts,
  _request: EntitlementRequest,
): EntitlementDecision {
  throw new Error('NOT_IMPLEMENTED');
}

export type TenantCounts = { activeMembers: number };

export type PlanChangeEffect = {
  /** Upgrades apply now. Downgrades wait for the period's end, so nobody loses what they paid for. */
  effective: 'now' | 'period_end';
  /** How far over the new plan's limits this tenant is, by limit. Over means read-only, never removed. */
  excess: Readonly<Record<string, number>>;
};

/** What a plan change does. It removes nothing, ever (OPS-21). */
export function planChangeEffect(
  _from: PlanTerms,
  _to: PlanTerms,
  _counts: TenantCounts,
): PlanChangeEffect {
  throw new Error('NOT_IMPLEMENTED');
}
