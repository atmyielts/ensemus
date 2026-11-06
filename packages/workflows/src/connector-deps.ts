// What the connector worker hands its Activities. Nothing here reaches the web tier (lint).
import type { SecretLease } from '@ensemus/application';
import type { ConnectorNetwork, ConnectorRegistry } from '@ensemus/connectors';
import type { AppDatabase } from '@ensemus/database';

export type ConnectorActivityDeps = {
  database: AppDatabase;
  registry: ConnectorRegistry;
  /** SecretBroker. The only way to a credential or a signing secret. */
  secrets: SecretLease;
  /** The egress gateway. The only way out. */
  network: ConnectorNetwork;
};
