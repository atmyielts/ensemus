// The SDK conformance helper is supplied by M3. This remains owed until that milestone is composed.
import { createFakePaymentProcessor } from '@ensemus/saas/testing';
import { createPaymentConnector } from '@ensemus/connectors/payment';
import { describeConnectorConformance } from '@ensemus/connectors/testing';

describeConnectorConformance(
  'scripted payment adapter',
  () =>
    createPaymentConnector(
      createFakePaymentProcessor({
        lookup: 'none',
        onCharge: () => ({
          outcome: 'not_sent',
          code: 'PROCESSOR_NOT_CONFIGURED',
          retryable: false,
        }),
        interpret: () => {
          throw new Error('TEST_MALFORMED_EVENT');
        },
      }),
    ),
  { config: {} },
);
