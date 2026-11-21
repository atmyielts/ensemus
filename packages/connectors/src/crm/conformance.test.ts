// The actual SDK checks, with explicit generated row scopes. No provider or socket.
import { describeConnectorConformance } from '../testing';
import { businessSdkFixture } from '../testing/business-conformance';
import { BUSINESS_STREAMS } from '@ensemus/domain/business-connector';
import { createCrmConnector } from './index';
const config = {
  streams: Object.keys(BUSINESS_STREAMS['crm_http']),
  scopes: ['crm_http.read', 'crm_http.write'],
};
describeConnectorConformance('crm_http', () => businessSdkFixture(createCrmConnector, config), {
  config,
  payload: {
    record: { stream: 'crm.accounts', external_id: 'generated-record', expected_version: '1' },
    changes: { status: 'reviewed' },
  },
});
