// EXP-02, ADR-033 D2/D3. Accounting reads, annotations and invoice drafts; no posting or money-moving tool.
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import { parseBusinessActionPayload } from '../business/payload';
import {
  ACCOUNTING_CONNECTOR_TYPE,
  BUSINESS_TOOLS,
  BUSINESS_TOOL_VERSION,
} from '@ensemus/domain/business-connector';
import { createBusinessConnector, type BusinessConnectorOptions } from '../business';
import { ACCOUNTING_CONNECTOR_MANIFEST } from '../manifest-business';
import type { Connector } from '../index';
export { ACCOUNTING_CONNECTOR_TYPE } from '@ensemus/domain/business-connector';
export function createAccountingConnector(
  options: BusinessConnectorOptions,
): Connector<BusinessConnectorConfig> {
  return createBusinessConnector(
    {
      type: ACCOUNTING_CONNECTOR_TYPE,
      manifest: ACCOUNTING_CONNECTOR_MANIFEST,
      tools: Object.fromEntries(
        BUSINESS_TOOLS[ACCOUNTING_CONNECTOR_TYPE].map((tool) => [
          tool,
          {
            version: BUSINESS_TOOL_VERSION,
            parsePayload: (raw: unknown) => {
              const payload = parseBusinessActionPayload(ACCOUNTING_CONNECTOR_TYPE, tool, raw);
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
