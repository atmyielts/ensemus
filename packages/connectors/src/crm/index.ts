// EXP-02, ADR-033 D2/D3. Selected CRM records and reviewed writable-field changes.
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import { parseBusinessActionPayload } from '../business/payload';
import {
  CRM_CONNECTOR_TYPE,
  BUSINESS_TOOLS,
  BUSINESS_TOOL_VERSION,
} from '@ensemus/domain/business-connector';
import { createBusinessConnector, type BusinessConnectorOptions } from '../business';
import { CRM_CONNECTOR_MANIFEST } from '../manifest-business';
import type { Connector } from '../index';
export { CRM_CONNECTOR_TYPE } from '@ensemus/domain/business-connector';
export function createCrmConnector(
  options: BusinessConnectorOptions,
): Connector<BusinessConnectorConfig> {
  return createBusinessConnector(
    {
      type: CRM_CONNECTOR_TYPE,
      manifest: CRM_CONNECTOR_MANIFEST,
      tools: Object.fromEntries(
        BUSINESS_TOOLS[CRM_CONNECTOR_TYPE].map((tool) => [
          tool,
          {
            version: BUSINESS_TOOL_VERSION,
            parsePayload: (raw: unknown) => {
              const payload = parseBusinessActionPayload(CRM_CONNECTOR_TYPE, tool, raw);
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
