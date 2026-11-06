// One gateway, one target, which is the rule that makes ADR-027 D5 easy to reason about, so each kind of
// business system gets its own gateway instance rather than one gateway that can reach several (ADR-033 D2).
// This binds a connector to the instance for its kind. The connector still goes out only through
// `context.network`, and still names no host.
import type { Connector, ConnectorContext, ConnectorNetwork } from '../index';

export function routeConnector<TConfig>(
  connector: Connector<TConfig>,
  network: ConnectorNetwork,
): Connector<TConfig> {
  const routed = (context: ConnectorContext<TConfig>): ConnectorContext<TConfig> => ({
    ...context,
    network,
  });
  const { actions, sync } = connector;
  return {
    ...connector,
    ...(actions
      ? {
          actions: {
            send: (context, request) => actions.send(routed(context), request),
            reconcile: (context, request) => actions.reconcile(routed(context), request),
          },
        }
      : {}),
    ...(sync
      ? { sync: { readPage: (context, request) => sync.readPage(routed(context), request) } }
      : {}),
  };
}
