// Owned by the connector-crm slice (EXP-02). See docs/06-delivery/m11a-slices.md and ADR-033 D2.
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import type { BusinessConnectorOptions } from '../business';
import type { Connector } from '../index';

export { CRM_CONNECTOR_TYPE } from '@ensemus/domain/business-connector';

/** The CRM connector. It reads the selected streams and proposes changes to writable fields only. */
export function createCrmConnector(
  _options: BusinessConnectorOptions,
): Connector<BusinessConnectorConfig> {
  throw new Error('NOT_IMPLEMENTED');
}
