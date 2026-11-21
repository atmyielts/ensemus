// What the connector worker hands its Activities. Nothing here reaches the web tier (lint).
import type { SecretLease } from '@ensemus/application';
import type { ConnectorNetwork, ConnectorRegistry } from '@ensemus/connectors';
import type { AppDatabase } from '@ensemus/database';
import type { AgentHaltPort } from '@ensemus/application/saas/ports';
import type { VerifiedCheckoutCallback, VerifiedPaymentWebhook } from './webhook-activities';

export type ConnectorActivityDeps = {
  database: AppDatabase;
  registry: ConnectorRegistry;
  /** SecretBroker. The only way to a credential or a signing secret. */
  secrets: SecretLease;
  /** The egress gateway. The only way out. */
  network: ConnectorNetwork;
  /** Server-owned deployment configuration; absent/partial means payment webhooks refuse. */
  paymentWebhook?: {
    billingOrganizationId: string | null;
    billingConnectionId: string | null;
    processor: string | null;
  };
  /** Native secrets-role adapter only. The proof can be made only after actual signature/body parsing. */
  attestPaymentWebhook?: (
    proof: VerifiedPaymentWebhook,
  ) => Promise<{ token: string; expiresAt: Date }>;
  /** ADR-032 D4a. The deployment's own organization, which alone may hold checkout addresses. */
  checkoutWebhook?: { billingOrganizationId: string | null; agents?: AgentHaltPort };
  /** Secrets-role witness for one verified checkout call. Absent means checkout calls are refused. */
  attestCheckoutCallback?: (
    proof: VerifiedCheckoutCallback,
  ) => Promise<{ token: string; expiresAt: Date }>;
};
