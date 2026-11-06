// The entitlement seam (MODEL-04, COMM-02, ADR-028 FD-8). M6's signed offline license and M8's billing
// implement the same `Entitlements` port behind this. No price, plan or limit lives in code: the only
// rule here is what each commercial mode already means, and that a Cloud tenant has no included allowance
// until a row in `platform.entitlements` issues one. An answer here can only stop a call. It has no field
// that could allow something a policy denied, and the gateway checks policy after it regardless.
import { AppError } from '@ensemus/application';
import { readEntitlementFacts } from '@ensemus/application/ai-budget';
import type { Entitlements, EntitlementResult } from '@ensemus/application/ai-ports';
import type { EntitlementsView } from '@ensemus/contracts/ai';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { can } from '@ensemus/domain/policy';

export const FEATURE_AGENT_RUN = 'agent.run';
export const FEATURE_MODEL_CALL = 'model.call';

/** What a tenant paying its own provider has by being in that mode. Not a plan: a statement of the mode. */
const MODE_FEATURES: readonly string[] = [FEATURE_AGENT_RUN, FEATURE_MODEL_CALL];

export type CommercialMode = 'cloud' | 'byom' | 'sovereign';

export type EntitlementGrant = {
  mode: string;
  period: string;
  features: readonly string[];
  capacities: unknown;
};

/** The features this tenant has this month. A row for another mode or month gives nothing. */
export function entitledFeatures(
  mode: CommercialMode,
  grant: EntitlementGrant | null,
  period: string,
): readonly string[] {
  if (mode === 'byom' || mode === 'sovereign') return MODE_FEATURES;
  if (mode !== 'cloud' || !grant || grant.mode !== mode || grant.period !== period) return [];
  return grant.features;
}

/**
 * BYOM and Sovereign pay their own provider, so they are entitled and nothing they do is billable.
 * Cloud has nothing until a row says so. A feature nobody has heard of is denied in every mode.
 */
export function decideEntitlement(
  mode: CommercialMode,
  grant: EntitlementGrant | null,
  feature: string,
  period: string,
): EntitlementResult {
  if (!entitledFeatures(mode, grant, period).includes(feature)) {
    return { ok: false, code: 'ENTITLEMENT_DENIED' };
  }
  return { ok: true, billable: mode === 'cloud', commercialMode: mode };
}

/** Only whole numbers leave as capacities, whatever the JSON column holds. */
export function capacitiesOf(grant: EntitlementGrant | null, period: string, mode: string) {
  if (!grant || grant.mode !== mode || grant.period !== period) return {};
  const raw = grant.capacities;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (pair): pair is [string, number] =>
        typeof pair[1] === 'number' && Number.isSafeInteger(pair[1]),
    ),
  );
}

const periodOf = (now: Date) => now.toISOString().slice(0, 7);

/**
 * A database failure throws, and the Activity retries, so nothing runs and no outage reads as a denial
 * on the record. Nothing is cached, so a new row or a change of mode counts from the next call.
 */
export function createEntitlements(
  database: AppDatabase,
  options: { now?: () => Date } = {},
): Entitlements {
  const now = options.now ?? (() => new Date());
  return {
    async check(context, feature) {
      const period = periodOf(now());
      const facts = await readEntitlementFacts(database, context, { period });
      if (!facts) return { ok: false, code: 'ENTITLEMENT_DENIED' };
      return decideEntitlement(facts.mode, facts.grant, feature, period);
    },
  };
}

/** What this tenant is entitled to, for its admins. Needs `usage.view`, and holds no key or signature. */
export async function getEntitlementsView(
  database: AppDatabase,
  context: TenantContext,
  options: { now?: () => Date } = {},
): Promise<EntitlementsView> {
  if (context.actorType !== 'user' || !can(context.role, 'usage.view')) {
    throw new AppError('FORBIDDEN');
  }
  const period = periodOf((options.now ?? (() => new Date()))());
  const facts = await readEntitlementFacts(database, context, { period });
  if (!facts) throw new AppError('NOT_FOUND');
  return {
    mode: facts.mode,
    features: [...entitledFeatures(facts.mode, facts.grant, period)].sort(),
    capacity: capacitiesOf(facts.grant, period, facts.mode),
  };
}

/** Whole micro-USD as dollars, with the digits it needs and no float in the way. */
export function formatMicrosUsd(micros: number): string {
  if (!Number.isSafeInteger(micros)) throw new RangeError('Not a whole micro-USD amount');
  const negative = micros < 0;
  const size = BigInt(Math.abs(micros));
  const whole = (size / 1_000_000n).toLocaleString('en-US');
  const fraction = (size % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `${negative ? '-' : ''}$${whole}.${fraction}`;
}
