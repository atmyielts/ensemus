// What M8 needs from other milestones, each as one small port (ADR-032 D9). Sibling code implements these
// at the final merge. Until then nothing has a working implementation, so a real deployment refuses rather
// than guessing, and tests bring their own doubles.
import type { Tx, TenantContext } from '@ensemus/database';
import type { DataCategory } from '@ensemus/saas/lifecycle';
import type { UsagePage, UsageTotal } from '@ensemus/saas/usage';

/**
 * M4's `platform.usage_ledger`. Reads only, in the caller's tenant transaction. Refuses, by throwing
 * UsageUnavailable, where nothing implements it, and billing stops rather than invoicing no usage.
 */
export interface UsageLedgerPort {
  /** Ledger entries in the order written, from a cursor this port alone understands. */
  listSince(
    tx: Tx,
    context: TenantContext,
    input: { after: string | null; limit: number },
  ): Promise<UsagePage>;
  /** Billable usage in `[from, to)`, summed by meter. */
  sumForPeriod(
    tx: Tx,
    context: TenantContext,
    input: { from: Date; to: Date },
  ): Promise<readonly UsageTotal[]>;
}

/** Answers what the ledger recorded across every tenant, for setting against a provider's bill. */
export interface ProviderCostPort {
  /** Sums `cost_micros` over `billable` entries. Run by the operator role, which can read only that. */
  sumProviderCost(input: { providerKind: string; from: Date; to: Date }): Promise<bigint>;
}

export class UsageUnavailable extends Error {
  override name = 'UsageUnavailable';
  constructor() {
    super('USAGE_UNAVAILABLE');
  }
}

/**
 * M6's `COMM-05`. An export needs the customer's own public key (`requestOrganizationExport`), so nothing here
 * can start one. Offering means telling the owners and linking there, and this says what they have taken, from
 * `listOrganizationExports`. Refusing, where M6 is not wired in, keeps offboarding at its first step.
 */
export interface TenantExportPort {
  latestExport(tx: Tx, context: TenantContext): Promise<{ exportRef: string } | null>;
}

/**
 * M4's kill switch (`SEC-06`), which is an `organization`-scoped row in `governance.kill_switches`. Stops new
 * runs and winds down live ones. A repeat does nothing new.
 */
export interface AgentHaltPort {
  haltTenantAgents(tx: Tx, context: TenantContext, reasonCode: string): Promise<void>;
  releaseTenantAgents(tx: Tx, context: TenantContext, reasonCode: string): Promise<void>;
}

/** Whichever milestone owns a store of tenant data with its own purge. One per category, in a list. */
export interface RetentionSource {
  readonly category: DataCategory;
  /** IDs of records older than the cutoff, which are not already tombstoned, a bounded page at a time. */
  findExpired(
    tx: Tx,
    context: TenantContext,
    input: { before: Date; classification: string; limit: number },
  ): Promise<readonly string[]>;
  /** Removes one, through that store's normal deletion path. A legal hold refuses it there, below this. */
  remove(tx: Tx, context: TenantContext, id: string): Promise<void>;
}

/** Everything offboarding has to do outside its own tables, each settled before erasure can start. */
export interface OffboardingPorts {
  exports: TenantExportPort;
  agents: AgentHaltPort;
  /** Other milestones' scheduled work, such as M7 automations. Each ends what it started. */
  windDowns: readonly ((tx: Tx, context: TenantContext) => Promise<void>)[];
}

/**
 * The billing cycle's ports. `tax` calls leave this process, and run on the connector queue: see
 * @ensemus/workflows/payment-deps.
 */
export type BillingPorts = { usage: UsageLedgerPort };

/** The default, for a deployment where M4's ledger is not wired in. It refuses, and invoices nothing. */
export const usageNotWiredIn: UsageLedgerPort = {
  listSince() {
    throw new UsageUnavailable();
  },
  sumForPeriod() {
    throw new UsageUnavailable();
  },
};
