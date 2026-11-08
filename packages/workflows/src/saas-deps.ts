// What M8's Activities are handed. The ports default to refusing (ADR-032 D9), and workers wire in sibling code
// at the final merge. Nothing here reaches the web tier (lint).
import type {
  AgentHaltPort,
  OffboardingPorts,
  RetentionSource,
  UsageLedgerPort,
} from '@ensemus/application/saas/ports';
import type { AppDatabase } from '@ensemus/database';
import type { PaymentProcessorRegistry } from '@ensemus/saas/payment';
import type { TaxPort } from '@ensemus/saas/tax';
import type { ConnectorActivityDeps } from './connector-deps';

export type BillingActivityDeps = {
  database: AppDatabase;
  usage: UsageLedgerPort;
  agents: AgentHaltPort;
};

export type RetentionActivityDeps = {
  database: AppDatabase;
  sources: readonly RetentionSource[];
};

export type OffboardingActivityDeps = {
  database: AppDatabase;
  ports: OffboardingPorts;
};

/** The platform side of paying: only what reads and writes PostgreSQL. */
export type PaymentPlatformDeps = { database: AppDatabase };

/** The connector queue's side: what holds a credential and leaves the process. */
export type PaymentConnectorDeps = ConnectorActivityDeps & {
  /** Empty until the owner chooses a processor, and `get` answers null, so a charge is refused. */
  processors: PaymentProcessorRegistry;
  /** The operator's own organization and connection, which hold the processor's credential. */
  billingOrganizationId: string | null;
  billingConnectionId: string | null;
  /** Null until the owner chooses a provider. `provider_computed` then leaves invoices as drafts. */
  tax: TaxPort | null;
};
