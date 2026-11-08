// Owned by the subscriptions slice (COMM-01). What M4's gateway and every other milestone call to ask
// whether something is licensed. See docs/06-delivery/m8-slices.md and ADR-032 D5.
import {
  organizations,
  subscriptions,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import {
  evaluateEntitlement,
  type EntitlementDecision,
  type EntitlementFacts,
  type EntitlementRequest,
  type TenantLifecycle,
} from '@ensemus/saas/entitlements';
import { desc, eq } from 'drizzle-orm';
import { AppError } from '../errors';
import { loadPlanTerms } from './catalog';
import { loadCreditBalanceInTx } from './credits';

async function entitlementFacts(
  tx: Tx,
  context: TenantContext,
  billingEnabled: boolean,
  balance: boolean,
): Promise<EntitlementFacts> {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, context.organizationId));
  if (!org || org.lifecycle === 'deleted') throw new AppError('NOT_FOUND');
  if (!['cloud', 'byom', 'sovereign'].includes(org.commercialMode)) throw new AppError('NOT_FOUND');
  const commercialMode = org.commercialMode as EntitlementFacts['commercialMode'];
  const [sub] =
    commercialMode === 'sovereign'
      ? []
      : await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.organizationId, context.organizationId))
          .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
          .limit(1);
  const plan = sub ? await loadPlanTerms(tx, sub.planVersionId) : null;
  const balanceMicrocredits =
    balance &&
    billingEnabled &&
    org.lifecycle === 'active' &&
    commercialMode === 'cloud' &&
    plan &&
    (sub?.status === 'active' || sub?.status === 'past_due')
      ? await loadCreditBalanceInTx(tx, context)
      : null;
  return {
    billingEnabled,
    commercialMode,
    lifecycle: org.lifecycle as TenantLifecycle,
    plan,
    subscriptionStatus: sub ? (sub.status as EntitlementFacts['subscriptionStatus']) : null,
    balanceMicrocredits,
  };
}

export type EntitlementsView = {
  mode: 'cloud' | 'byom' | 'sovereign';
  features: readonly string[];
  capacity: {
    balanceMicrocredits: string | null;
    includedMicrocredits: string | null;
    maxActiveMembers: number | null;
  };
};

/** Reads current facts and answers from `evaluateEntitlement`, in the caller's transaction. */
export async function checkEntitlementInTx(
  tx: Tx,
  context: TenantContext,
  request: EntitlementRequest,
  options: { billingEnabled: boolean },
): Promise<EntitlementDecision> {
  return evaluateEntitlement(
    await entitlementFacts(tx, context, options.billingEnabled, request.kind === 'model_capacity'),
    request,
  );
}

/**
 * What M4's `getEntitlementsView` and its `/entitlements` route read for a Cloud or BYOM tenant, for any member.
 * It holds no key and nothing a tenant could not see, and nothing here can override a policy decision.
 */
export async function getEntitlements(
  database: AppDatabase,
  context: TenantContext,
  options: { billingEnabled: boolean },
): Promise<EntitlementsView> {
  if (context.actorType !== 'user') throw new AppError('NOT_FOUND');
  return withAccountTx(database, context, async (tx) => {
    const facts = await entitlementFacts(tx, context, options.billingEnabled, true);
    return {
      mode: facts.commercialMode,
      features: facts.plan?.features ?? [],
      capacity: {
        balanceMicrocredits: facts.balanceMicrocredits?.toString() ?? null,
        includedMicrocredits: facts.plan?.includedMicrocredits?.toString() ?? null,
        maxActiveMembers: facts.plan?.maxActiveMembers ?? null,
      },
    };
  });
}

/** M4's `EntitlementResult` from `@ensemus/application/ai-ports`, as written there (ADR-028 FD-8). */
export type EntitlementPortResult =
  | { ok: true; billable: boolean; commercialMode: 'cloud' | 'byom' | 'sovereign' }
  | { ok: false; code: 'ENTITLEMENT_DENIED' };

/**
 * M4's `Entitlements` port for Cloud and BYOM, in that port's shape so it needs no import from M4, the same
 * as M6's `createSovereignEntitlements`. `@ensemus/commercial`'s `createEntitlements` calls this at the final
 * merge. `check` answers M4's features: `model.call` is a capacity check, where BYOM is `billable: false`,
 * and anything else is a feature on the plan. `decide` is the richer answer, for an admin's diagnostics.
 */
export function createEntitlementChecker(database: AppDatabase, billingEnabled: boolean) {
  return {
    async check(context: TenantContext, feature: string): Promise<EntitlementPortResult> {
      return withTenantTx(database, context, async (tx) => {
        const facts = await entitlementFacts(tx, context, billingEnabled, feature === 'model.call');
        const request: EntitlementRequest =
          feature === 'model.call'
            ? { kind: 'model_capacity', estimatedMicrocredits: 0n }
            : { kind: 'feature', feature };
        const decision = evaluateEntitlement(facts, request);
        return decision.allowed
          ? {
              ok: true,
              billable: feature === 'model.call' && facts.commercialMode === 'cloud',
              commercialMode: facts.commercialMode,
            }
          : { ok: false, code: 'ENTITLEMENT_DENIED' };
      });
    },
    decide(context: TenantContext, request: EntitlementRequest): Promise<EntitlementDecision> {
      return withAccountTx(database, context, (tx) =>
        checkEntitlementInTx(tx, context, request, { billingEnabled }),
      );
    },
  };
}
