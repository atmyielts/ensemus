// Private connector-worker composition. There is no default native adapter, target or merchant identity.
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { assertPaymentTransport } from '@ensemus/application/saas/payment-execution';
import { createServiceContext } from '@ensemus/database/service';
import type { openSecretsDatabase } from '@ensemus/database/secrets';
import {
  createPaymentHttpGateway,
  PAYMENT_CONNECTOR_PREFIX,
  SECRET_PURPOSE_PAYMENT_PROCESSOR,
} from '@ensemus/connectors/payment';
import type { PaymentProcessor } from '@ensemus/saas/payment';
import type { PaymentConnectorDeps } from '@ensemus/workflows/saas-deps';
import type { PaymentActivityOptions } from '@ensemus/workflows/payment-activities';
import { createPaymentIdentityAttester } from './payment-identity';
import { createPaymentLookupAttester } from './payment-lookup-attester';

export type SelectedNativePayment = Readonly<{
  processor: PaymentProcessor;
  /** Exact reviewed target corresponding to the actual native adapter and configured egress relay. */
  apiOrigin: string;
  webhookEndpointId?: string;
}>;
export function createPaymentRuntimeOptions(
  deps: PaymentConnectorDeps,
  broker: ReturnType<typeof openSecretsDatabase>['db'],
  native?: SelectedNativePayment,
): PaymentActivityOptions {
  const options: PaymentActivityOptions = {
    agents: createStandingAgentHaltPort(),
    attestIdentity: createPaymentIdentityAttester(broker),
    attestLookup: createPaymentLookupAttester(broker),
  };
  if (!native) return options;
  const name = native.processor.manifest.processor;
  const connector = deps.registry.get(PAYMENT_CONNECTOR_PREFIX + name);
  if (
    !deps.billingOrganizationId ||
    !deps.billingConnectionId ||
    deps.paymentProcessor !== name ||
    deps.processors.get(name) !== native.processor ||
    !native.processor.identifyExecution ||
    connector?.manifest.credential.purpose !== SECRET_PURPOSE_PAYMENT_PROCESSOR ||
    connector.manifest.version !== native.processor.manifest.version
  )
    throw new Error('PAYMENT_NATIVE_COMPOSITION_UNAVAILABLE');
  return {
    ...options,
    paymentApiOrigin: native.apiOrigin,
    ...(native.webhookEndpointId ? { paymentWebhookEndpointId: native.webhookEndpointId } : {}),
    requestThroughGateway: createPaymentHttpGateway({
      network: deps.network,
      apiOrigin: native.apiOrigin,
      processor: name,
      adapterVersion: native.processor.manifest.version,
      assertAuthority: (binding) =>
        assertPaymentTransport(
          deps.database,
          createServiceContext(binding.organizationId),
          binding,
        ),
    }),
  };
}
