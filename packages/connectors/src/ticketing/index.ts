// EXP-02, ADR-033 D2/D3. Selected ticket records and internal notes; no customer-facing reply tool.
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import { parseBusinessActionPayload } from '../business/payload';
import {
  TICKETING_CONNECTOR_TYPE,
  BUSINESS_TOOLS,
  BUSINESS_TOOL_VERSION,
} from '@ensemus/domain/business-connector';
import { createBusinessConnector, type BusinessConnectorOptions } from '../business';
import { TICKETING_CONNECTOR_MANIFEST } from '../manifest-business';
import type { Connector } from '../index';
export { TICKETING_CONNECTOR_TYPE } from '@ensemus/domain/business-connector';
export function createTicketingConnector(
  options: BusinessConnectorOptions,
): Connector<BusinessConnectorConfig> {
  return createBusinessConnector(
    {
      type: TICKETING_CONNECTOR_TYPE,
      manifest: TICKETING_CONNECTOR_MANIFEST,
      tools: Object.fromEntries(
        BUSINESS_TOOLS[TICKETING_CONNECTOR_TYPE].map((tool) => [
          tool,
          {
            version: BUSINESS_TOOL_VERSION,
            parsePayload: (raw: unknown) => {
              const payload = parseBusinessActionPayload(TICKETING_CONNECTOR_TYPE, tool, raw);
              if (payload === null) throw new Error('PAYLOAD_CHANGED');
              return payload;
            },
          },
        ]),
      ),
    },
    options,
  );
}
