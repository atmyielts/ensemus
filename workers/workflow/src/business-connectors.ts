import { loadBusinessConnectorRoutes } from '@ensemus/config/business';
// Which business connectors this deployment offers (ADR-033 D2). A connector is on the list only if an operator
// gave it a gateway instance to go through. One with no route does not exist here, which is what the
// integrations doc asks for: clearly unavailable, not silently simulated. Air-gapped installs set none of them.
import { applyBusinessRecordPage } from '@ensemus/application';
import type { Connector } from '@ensemus/connectors';
import { createAccountingConnector } from '@ensemus/connectors/accounting';
import { routeConnector, type BusinessRecordSink } from '@ensemus/connectors/business';
import { createCrmConnector } from '@ensemus/connectors/crm';
import { createMeetingNotesConnector } from '@ensemus/connectors/meetings';
import { createGatewayNetwork } from '@ensemus/connectors/runtime';
import { createTicketingConnector } from '@ensemus/connectors/ticketing';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';

type Env = Readonly<Record<string, string | undefined>>;

export function createBusinessRecordSink(database: AppDatabase): BusinessRecordSink {
  return {
    applyPage: ({ organizationId, ...page }) =>
      applyBusinessRecordPage(database, createServiceContext(organizationId), page),
  };
}

export function businessConnectorsFrom(env: Env, database: AppDatabase): readonly Connector[] {
  const routes = loadBusinessConnectorRoutes(env);
  const tls = env.ENSEMUS_BUSINESS_TLS === 'none' ? 'none' : 'required';
  const ca = env.ENSEMUS_BUSINESS_CA_PEM;
  const transport = { tls, ...(ca ? { ca } : {}) } as const;
  const sink = createBusinessRecordSink(database);
  const connectors: Connector[] = [];
  const add = <T>(address: string | undefined, make: () => Connector<T>) => {
    if (!address) return;
    connectors.push(routeConnector(make(), createGatewayNetwork(address)) as Connector);
  };
  add(routes.crm_http, () => createCrmConnector({ ...transport, sink }));
  add(routes.ticketing_http, () => createTicketingConnector({ ...transport, sink }));
  add(routes.accounting_http, () => createAccountingConnector({ ...transport, sink }));
  add(env.ENSEMUS_EGRESS_GATEWAY_MEETING_NOTES, () => createMeetingNotesConnector(transport));
  return connectors;
}
