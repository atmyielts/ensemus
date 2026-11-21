// Owned by the connector-ticketing slice (EXP-02). See docs/06-delivery/m11a-slices.md and ADR-033 D2.
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import type { BusinessConnectorOptions } from '../business';
import type { Connector } from '../index';

export { TICKETING_CONNECTOR_TYPE } from '@ensemus/domain/business-connector';

/** The ticketing connector. It updates writable fields and adds internal notes, and never replies out. */
export function createTicketingConnector(
  _options: BusinessConnectorOptions,
): Connector<BusinessConnectorConfig> {
  throw new Error('NOT_IMPLEMENTED');
}
