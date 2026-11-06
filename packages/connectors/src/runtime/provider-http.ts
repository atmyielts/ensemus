// Owned by the connectors slice (CONNECT-04, CONNECT-05). See docs/06-delivery/m5-slices.md. A small HTTP/1.1
// client over TLS over a gateway's Duplex, because nothing else may open a connection here (lint), and a
// library would bring a way out of its own. Reads a bounded response, and follows no redirect.
import type { ConnectorNetwork } from '../index';
import type { ProviderHttpClient, ProviderRoute } from '../knowledge';

export type ProviderHttpOptions = {
  /** One gateway per route. A route with no gateway answers PROVIDER_ROUTE_UNAVAILABLE. */
  routes: Partial<Readonly<Record<ProviderRoute, ConnectorNetwork>>>;
  /** Only for `mcp_server`, whose name the operator sets with the gateway's target. */
  mcpTlsName?: string;
  /** Extra trust roots, for tests against a local fake only. Never set by a shipped entry point. */
  testCa?: Buffer;
};

export function createProviderHttpClient(_options: ProviderHttpOptions): ProviderHttpClient {
  throw new Error('NOT_IMPLEMENTED');
}
