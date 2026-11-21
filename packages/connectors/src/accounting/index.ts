// Owned by the connector-accounting slice (EXP-02). See docs/06-delivery/m11a-slices.md and ADR-033 D2.
import type { BusinessConnectorConfig } from '@ensemus/contracts/business-records';
import type { BusinessConnectorOptions } from '../business';
import type { Connector } from '../index';

export { ACCOUNTING_CONNECTOR_TYPE } from '@ensemus/domain/business-connector';

/** The accounting connector. It reads, annotates and drafts. It has no tool that posts or moves money. */
export function createAccountingConnector(
  _options: BusinessConnectorOptions,
): Connector<BusinessConnectorConfig> {
  throw new Error('NOT_IMPLEMENTED');
}
