// The actual SDK checks, with explicit generated row scopes. No provider or socket.
import { describeConnectorConformance } from '../testing';
import { businessSdkFixture } from '../testing/business-conformance';
import { BUSINESS_STREAMS } from '@ensemus/domain/business-connector';
import { createTicketingConnector } from './index';
const config = {
  streams: Object.keys(BUSINESS_STREAMS['ticketing_http']),
  scopes: ['ticketing_http.read', 'ticketing_http.write'],
};
describeConnectorConformance(
  'ticketing_http',
  () => businessSdkFixture(createTicketingConnector, config),
  {
    config,
    payload: {
      record: {
        stream: 'ticketing.tickets',
        external_id: 'generated-record',
        expected_version: '1',
      },
      changes: { priority: 'normal' },
    },
  },
);
