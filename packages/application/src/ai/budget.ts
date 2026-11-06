// The people's side of budgets and usage (MODEL-04), which web may call. Needs `budget.manage` or
// `usage.view`. There is no default budget, so no budget means no run (FD-6). Only a person gets through:
// an agent's context carries its initiator's role, and an agent must not be able to raise its own budget.
import { randomUUID } from 'node:crypto';
import { setBudgetSchema, type SetBudget, type UsageSummary } from '@ensemus/contracts/ai';
import {
  actorOf,
  agentDefinitions,
  agentRuns,
  agentVersions,
  appendAudit,
  budgetReservations,
  budgets,
  entitlements,
  organizations,
  rateCards,
  usageLedger,
  withTenantTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import type { StopCode } from '@ensemus/domain/ai';
import { can, type Capability } from '@ensemus/domain/policy';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, foreignReference, pgCode } from '../errors';

const FOREIGN_KEY_VIOLATION = '23503';
const periodSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);

function requirePerson(context: TenantContext, capability: Capability) {
  if (context.actorType !== 'user' || !can(context.role, capability)) {
    throw new AppError('FORBIDDEN');
  }
}

function parsePeriod(input: { period: string }): string {
  const parsed = periodSchema.safeParse(input.period);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}

function parseBudget(raw: SetBudget): SetBudget {
  const parsed = setBudgetSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  const organizationWide = parsed.data.scope === 'organization';
  if (organizationWide !== (parsed.data.agent_version_id === null)) {
    throw new AppError('INVALID_INPUT');
  }
  return parsed.data;
}

/** The budget for this scope and month, with a new limit, or null when there is none yet. */
async function updateLimit(tx: Tx, organizationId: string, input: SetBudget) {
  const [row] = await tx
    .update(budgets)
    .set({ limitMicros: input.limit_micros, updatedAt: new Date() })
    .where(
      and(
        eq(budgets.organizationId, organizationId),
        eq(budgets.scope, input.scope),
        eq(budgets.period, input.period),
        input.agent_version_id === null
          ? isNull(budgets.agentVersionId)
          : eq(budgets.agentVersionId, input.agent_version_id),
      ),
    )
    .returning({ id: budgets.id });
  return row?.id ?? null;
}

/**
 * Sets the limit for one scope and month, creating the row if it is the first. What is already reserved
 * and spent stays as it is: this role has no grant to change them. A limit below what was spent is
 * allowed, and it stops new reservations. Setting it to the same figure twice is one row.
 */
export async function setBudget(
  database: AppDatabase,
  context: TenantContext,
  raw: SetBudget,
): Promise<{ budgetId: string }> {
  requirePerson(context, 'budget.manage');
  const input = parseBudget(raw);
  return withTenantTx(database, context, async (tx) => {
    let budgetId = await updateLimit(tx, context.organizationId, input);
    if (!budgetId) {
      try {
        const [inserted] = await tx
          .insert(budgets)
          .values({
            organizationId: context.organizationId,
            id: randomUUID(),
            scope: input.scope,
            agentVersionId: input.agent_version_id,
            period: input.period,
            limitMicros: input.limit_micros,
            createdByMembershipId: context.membershipId,
          })
          .onConflictDoNothing()
          .returning({ id: budgets.id });
        // Someone else's first write got there between the two statements, so this one is an update.
        budgetId = inserted?.id ?? (await updateLimit(tx, context.organizationId, input));
      } catch (error) {
        // An agent version in another tenant fails the tenant-safe key, and looks like a typing error.
        if (pgCode(error) === FOREIGN_KEY_VIOLATION) throw foreignReference();
        throw error;
      }
    }
    if (!budgetId) throw new AppError('INVALID_STATE');
    await appendAudit(tx, {
      organizationId: context.organizationId,
      ...actorOf(context),
      action: 'budget.set',
      targetRef: `budget:${budgetId}`,
      decision: 'allow',
    });
    return { budgetId };
  });
}

export type UsageFacts = {
  period: string;
  mode: 'cloud' | 'byom' | 'sovereign';
  limitMicros: number | null;
  reservedMicros: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  estimatedRows: number;
  billableRows: number;
  tenantEstimateRows: number;
};

/**
 * What a person is told about a month. BYOM and Sovereign are always labelled estimates and are never
 * billable, because their provider bills them (07-commercial §3, §4). Cloud is an estimate if any row
 * of it is: a lost answer, or a rate the tenant typed in themselves.
 */
export function summarizeUsage(facts: UsageFacts): UsageSummary {
  const cloud = facts.mode === 'cloud';
  return {
    period: facts.period,
    limit_micros: facts.limitMicros,
    reserved_micros: facts.reservedMicros,
    // A correction can take a month below nothing. A person sees that as nothing, and the rows stay.
    spent_micros: Math.max(0, facts.costMicros),
    billable: cloud && facts.billableRows > 0,
    is_estimate: !cloud || facts.estimatedRows > 0 || facts.tenantEstimateRows > 0,
    input_tokens: facts.inputTokens,
    output_tokens: facts.outputTokens,
  };
}

const sumOf = (column: unknown) => sql<string>`coalesce(sum(${column}), 0)::bigint`.mapWith(Number);

/**
 * One month for one tenant. Spending comes from the ledger, since that is what billing reads and what a
 * run reconciles to. The limit is the organization's own: an agent version's budget sits inside it, and
 * adding them up would count one call twice. For the same reason, one hold across two budgets counts once.
 */
export async function getUsageSummary(
  database: AppDatabase,
  context: TenantContext,
  input: { period: string },
): Promise<UsageSummary> {
  requirePerson(context, 'usage.view');
  const period = parsePeriod(input);
  return withTenantTx(database, context, async (tx) => {
    const [organization] = await tx
      .select({ commercialMode: organizations.commercialMode })
      .from(organizations);
    if (!organization) throw new AppError('NOT_FOUND');

    const [budget] = await tx
      .select({ limitMicros: budgets.limitMicros })
      .from(budgets)
      .where(
        and(
          eq(budgets.scope, 'organization'),
          isNull(budgets.agentVersionId),
          eq(budgets.period, period),
        ),
      );

    const holds = tx
      .select({ amount: sql`max(${budgetReservations.amountMicros})`.as('amount') })
      .from(budgetReservations)
      .innerJoin(
        budgets,
        and(
          eq(budgets.organizationId, budgetReservations.organizationId),
          eq(budgets.id, budgetReservations.budgetId),
        ),
      )
      .where(and(eq(budgetReservations.status, 'held'), eq(budgets.period, period)))
      .groupBy(budgetReservations.stepId, budgetReservations.attempt)
      .as('holds');
    const [held] = await tx.select({ total: sumOf(holds.amount) }).from(holds);

    const [ledger] = await tx
      .select({
        cost: sumOf(usageLedger.costMicros),
        input: sumOf(
          sql`case when ${usageLedger.meter} = 'model_input_tokens' then ${usageLedger.quantity} end`,
        ),
        output: sumOf(
          sql`case when ${usageLedger.meter} = 'model_output_tokens' then ${usageLedger.quantity} end`,
        ),
        estimated: sql<string>`count(*) filter (where ${usageLedger.status} = 'estimated')`.mapWith(
          Number,
        ),
        billable: sql<string>`count(*) filter (where ${usageLedger.billable})`.mapWith(Number),
        tenantEstimate:
          sql<string>`count(*) filter (where ${rateCards.source} = 'tenant_estimate')`.mapWith(
            Number,
          ),
      })
      .from(usageLedger)
      .leftJoin(
        rateCards,
        and(
          eq(rateCards.organizationId, usageLedger.organizationId),
          eq(rateCards.id, usageLedger.rateCardId),
        ),
      )
      .where(eq(usageLedger.billingPeriod, period));

    return summarizeUsage({
      period,
      mode: organization.commercialMode as UsageFacts['mode'],
      limitMicros: budget?.limitMicros ?? null,
      reservedMicros: held?.total ?? 0,
      costMicros: ledger?.cost ?? 0,
      inputTokens: ledger?.input ?? 0,
      outputTokens: ledger?.output ?? 0,
      estimatedRows: ledger?.estimated ?? 0,
      billableRows: ledger?.billable ?? 0,
      tenantEstimateRows: ledger?.tenantEstimate ?? 0,
    });
  });
}

export type BudgetView = {
  id: string;
  scope: 'organization' | 'agent_version';
  agentVersionId: string | null;
  agentName: string | null;
  agentVersionNumber: number | null;
  period: string;
  limitMicros: number;
  reservedMicros: number;
  spentMicros: number;
};

/** The budgets of one month, for the settings page. The organization's own comes first. */
export async function listBudgets(
  database: AppDatabase,
  context: TenantContext,
  input: { period: string },
): Promise<readonly BudgetView[]> {
  requirePerson(context, 'usage.view');
  const period = parsePeriod(input);
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: budgets.id,
        scope: budgets.scope,
        agentVersionId: budgets.agentVersionId,
        agentName: agentDefinitions.name,
        agentVersionNumber: agentVersions.versionNumber,
        period: budgets.period,
        limitMicros: budgets.limitMicros,
        reservedMicros: budgets.reservedMicros,
        spentMicros: budgets.spentMicros,
      })
      .from(budgets)
      .leftJoin(
        agentVersions,
        and(
          eq(agentVersions.organizationId, budgets.organizationId),
          eq(agentVersions.id, budgets.agentVersionId),
        ),
      )
      .leftJoin(
        agentDefinitions,
        and(
          eq(agentDefinitions.organizationId, agentVersions.organizationId),
          eq(agentDefinitions.id, agentVersions.definitionId),
        ),
      )
      .where(eq(budgets.period, period))
      .orderBy(desc(budgets.scope), asc(agentDefinitions.name), asc(agentVersions.versionNumber)),
  );
  return rows.map((row) => ({ ...row, scope: row.scope as BudgetView['scope'] }));
}

export type BudgetableVersion = { id: string; name: string; versionNumber: number };

/** What a budget can be set on, beyond the organization. Only this tenant's versions can be offered. */
export async function listBudgetableVersions(
  database: AppDatabase,
  context: TenantContext,
): Promise<readonly BudgetableVersion[]> {
  requirePerson(context, 'budget.manage');
  return withTenantTx(database, context, (tx) =>
    tx
      .select({
        id: agentVersions.id,
        name: agentDefinitions.name,
        versionNumber: agentVersions.versionNumber,
      })
      .from(agentVersions)
      .innerJoin(
        agentDefinitions,
        and(
          eq(agentDefinitions.organizationId, agentVersions.organizationId),
          eq(agentDefinitions.id, agentVersions.definitionId),
        ),
      )
      .orderBy(asc(agentDefinitions.name), asc(agentVersions.versionNumber)),
  );
}

// --- What @ensemus/commercial decides from. That package holds the rules, and this holds the SQL.

export type EntitlementFacts = {
  mode: UsageFacts['mode'];
  /** The newest row issued for this tenant's mode and this month, if anything has issued one. */
  grant: {
    mode: string;
    period: string;
    features: readonly string[];
    capacities: unknown;
  } | null;
};

/** Null when the tenant cannot be seen. It checks no capability, so callers show nothing unguarded. */
export function readEntitlementFacts(
  database: AppDatabase,
  context: TenantContext,
  input: { period: string },
): Promise<EntitlementFacts | null> {
  const period = parsePeriod(input);
  return withTenantTx(database, context, async (tx) => {
    const [organization] = await tx
      .select({ mode: organizations.commercialMode })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId));
    if (!organization) return null;
    const [grant] = await tx
      .select({
        mode: entitlements.mode,
        period: entitlements.period,
        features: entitlements.features,
        capacities: entitlements.capacities,
      })
      .from(entitlements)
      .where(
        and(
          eq(entitlements.organizationId, context.organizationId),
          eq(entitlements.mode, organization.mode),
          eq(entitlements.period, period),
        ),
      )
      .orderBy(desc(entitlements.version))
      .limit(1);
    return { mode: organization.mode as EntitlementFacts['mode'], grant: grant ?? null };
  });
}

// --- Admin diagnostics (07-commercial §6): why runs were stopped, in codes and counts, with no content.

export type DenialKind = 'entitlement' | 'budget' | 'policy';

const DENIALS: Partial<Record<StopCode, DenialKind>> = {
  ENTITLEMENT_DENIED: 'entitlement',
  BUDGET_EXHAUSTED: 'budget',
  BUDGET_NOT_CONFIGURED: 'budget',
  RATE_CARD_MISSING: 'budget',
  COST_LIMIT: 'budget',
  POLICY_DENIED: 'policy',
  PROFILE_CHANGED: 'policy',
};

/**
 * Whose answer a stop was. "Your plan does not include this" sends an admin to the account, and "your
 * policy does not allow this" sends them to their own rules. Null for a stop that was neither.
 */
export const diagnoseStop = (code: string): DenialKind | null => DENIALS[code as StopCode] ?? null;

/** One UTC month, as the half-open range an index can use. */
export function periodRange(period: string): { from: Date; to: Date } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month, 1)),
  };
}

export type StopDiagnostic = { code: string; kind: DenialKind; count: number };

export async function getStopDiagnostics(
  database: AppDatabase,
  context: TenantContext,
  input: { period: string },
): Promise<readonly StopDiagnostic[]> {
  requirePerson(context, 'usage.view');
  const { from, to } = periodRange(parsePeriod(input));
  const rows = await withTenantTx(database, context, (tx) =>
    tx
      .select({ code: agentRuns.stopCode, count: count() })
      .from(agentRuns)
      .where(
        and(
          inArray(agentRuns.stopCode, Object.keys(DENIALS)),
          gte(agentRuns.endedAt, from),
          lt(agentRuns.endedAt, to),
        ),
      )
      .groupBy(agentRuns.stopCode)
      .orderBy(asc(agentRuns.stopCode)),
  );
  return rows.flatMap((row) => {
    const kind = row.code ? diagnoseStop(row.code) : null;
    return row.code && kind ? [{ code: row.code, kind, count: row.count }] : [];
  });
}
