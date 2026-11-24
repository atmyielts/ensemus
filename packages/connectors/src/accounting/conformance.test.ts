// The actual SDK checks, with explicit generated row scopes. No provider or socket.
import { describeConnectorConformance } from '../testing';
import { businessSdkFixture } from '../testing/business-conformance';
import { BUSINESS_STREAMS } from '@ensemus/domain/business-connector';
import { createAccountingConnector } from './index';
const config = {
  streams: Object.keys(BUSINESS_STREAMS['accounting_http']),
  scopes: ['accounting_http.read', 'accounting_http.write'],
};
describeConnectorConformance(
  'accounting_http',
  () => businessSdkFixture(createAccountingConnector, config),
  {
    config,
    payload: {
      record: {
        stream: 'accounting.invoices',
        external_id: 'generated-record',
        expected_version: '1',
      },
      changes: { memo: 'Generated memo' },
    },
  },
);
