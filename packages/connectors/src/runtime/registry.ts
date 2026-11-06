import type { Connector, ConnectorRegistry } from '../index';

/** An explicit list, built at startup. A connector that is not on it does not exist. */
export function createConnectorRegistry(connectors: readonly Connector[]): ConnectorRegistry {
  const byType = new Map(connectors.map((connector) => [connector.manifest.type, connector]));
  if (byType.size !== connectors.length) throw new Error('Two connectors share a type');
  return {
    get: (type) => byType.get(type),
    manifests: () => [...byType.values()].map((connector) => connector.manifest),
  };
}
