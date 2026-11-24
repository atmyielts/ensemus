// Generated connection-row facts for the generic SDK suite, which owns no database.
// Action checks retain its hostile/silent networks and canary credential. Only successful syncs use
// the local adapter's read credential/network. Missing-row-scope refusals use the unwrapped constructors.
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import type { Connector } from '../index';
import type { BusinessConnectorOptions } from '../business';
import { createFakeAdapter } from './business-adapter';
export function businessSdkFixture(
  make: (options: BusinessConnectorOptions) => Connector<BusinessConnectorConfig>,
  config: BusinessConnectorConfig,
): Connector {
  const adapter = createFakeAdapter(),
    connector = make({ tls: 'none', sink: { applyPage: async () => undefined } });
  return {
    ...connector,
    actions: {
      send: (context, request) =>
        connector.actions!.send(
          {
            ...context,
            config: connector.parseConfig(context.config),
            grantedScopes: config.scopes,
          },
          request,
        ),
      reconcile: (context, request) =>
        connector.actions!.reconcile(
          {
            ...context,
            config: connector.parseConfig(context.config),
            grantedScopes: config.scopes,
          },
          request,
        ),
    },
    sync: {
      readPage: (context, request) =>
        connector.sync!.readPage(
          {
            ...context,
            config: connector.parseConfig(context.config),
            grantedScopes: config.scopes,
            credentials: adapter.credentials,
            network: adapter.network,
          },
          request,
        ),
    },
  };
}
