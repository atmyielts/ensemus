// Hosted checkout in the connector worker (ADR-032 D4a). Reads configuration and mounted secrets only, and
// builds nothing for a provider the server does not name: with none named, every processor lookup answers
// null, every checkout address is unknown, and a Paddle checkout closes unopened.
import { AppError, idSchema } from '@ensemus/application';
import { loadCheckoutConfig, type CheckoutConfig } from '@ensemus/config/checkout';
import { readSecret } from '@ensemus/config';
import type { Connector } from '@ensemus/connectors';
import {
  createCheckoutConnector,
  createClickProcessor,
  createPaddleClient,
  createPaddleProcessor,
  createPaddleTaxPort,
  createPaymeProcessor,
  PADDLE_API_TLS_NAMES,
  type PaddleClient,
} from '@ensemus/connectors/checkout';
import { exchangeHttpOverRelay } from '@ensemus/connectors/provider-http';
import { createGatewayNetwork } from '@ensemus/connectors/runtime';
import {
  attestCheckoutCallback,
  attestCheckoutLookup,
  type openSecretsDatabase,
} from '@ensemus/database/secrets';
import type { PaymentProcessor, PaymentProcessorRegistry } from '@ensemus/saas/payment';
import type { TaxPort } from '@ensemus/saas/tax';
import {
  isVerifiedCheckoutCallback,
  type VerifiedCheckoutCallback,
} from '@ensemus/workflows/webhook-activities';

export type CheckoutComposition = {
  config: CheckoutConfig;
  processors: PaymentProcessorRegistry;
  connectors: readonly Connector[];
  paddle: PaddleClient | null;
  tax: TaxPort | null;
};

/**
 * Paddle's key is a mounted file read once here, like the operator's OAuth client secrets. It is lent to
 * each request as a copy and never logged. The gateway's one target and the TLS name fixed in code for
 * the environment are the only way it can leave.
 */
export function composeCheckout(env: NodeJS.ProcessEnv = process.env): CheckoutComposition {
  const config = loadCheckoutConfig(env);
  const adapters = new Map<string, PaymentProcessor>();
  if (config.paddle) adapters.set('paddle', createPaddleProcessor());
  if (config.payme) adapters.set('payme', createPaymeProcessor());
  if (config.click) adapters.set('click', createClickProcessor());
  let paddle: PaddleClient | null = null;
  if (config.paddle) {
    const key = Buffer.from(readSecret('ENSEMUS_PADDLE_API_KEY', env));
    const gateway = env.ENSEMUS_EGRESS_PADDLE;
    const tlsName = PADDLE_API_TLS_NAMES[config.paddle.environment];
    paddle = createPaddleClient({
      environment: config.paddle.environment,
      taxCategory: config.paddle.taxCategory,
      withApiKey: async (use) => {
        const lent = Buffer.from(key);
        try {
          return await use(lent);
        } finally {
          lent.fill(0);
        }
      },
      http: async (request) => {
        // No gateway means no route: the request fails with a code, as an unset suite route does.
        if (!gateway) throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
        const response = await exchangeHttpOverRelay(
          createGatewayNetwork(gateway),
          tlsName,
          {
            method: request.method,
            path: request.path,
            headers: request.headers,
            ...(request.body ? { body: request.body } : {}),
            timeoutMs: 30_000,
            maxResponseBytes: 262_144,
            signal: AbortSignal.timeout(30_000),
          },
          undefined,
        );
        return { status: response.status, body: response.body };
      },
    });
  }
  return {
    config,
    processors: { get: (name) => adapters.get(name) ?? null },
    connectors: config.providers.map((provider) => createCheckoutConnector(provider)),
    paddle,
    tax: paddle ? createPaddleTaxPort(paddle) : null,
  };
}

/** The secrets-role witnesses. The process-local brand proves the verifier, not a caller, made the proof. */
export function createCheckoutAttesters(secrets: ReturnType<typeof openSecretsDatabase>['db']) {
  return {
    async callback(proof: VerifiedCheckoutCallback) {
      if (
        !isVerifiedCheckoutCallback(proof) ||
        Date.now() < proof.verifiedAtEpochMs ||
        Date.now() - proof.verifiedAtEpochMs > 60_000 ||
        !/^[0-9]{1,20}$/.test(proof.rowVersion)
      )
        throw new AppError('PREREQUISITES_INCOMPLETE');
      try {
        return await attestCheckoutCallback(secrets, {
          organizationId: idSchema.parse(proof.organizationId),
          deliveryId: idSchema.parse(proof.deliveryId),
          rowVersion: proof.rowVersion,
          restoreGeneration: idSchema.parse(proof.restoreGeneration),
          endpointId: idSchema.parse(proof.endpointId),
          connectionId: idSchema.parse(proof.connectionId),
          signingSecretId: idSchema.parse(proof.signingSecretId),
          processor: proof.processor,
          bodySha256: proof.bodySha256,
          requestDigest: proof.requestDigest,
          action: proof.action,
          routeSha256: proof.routeSha256,
          txnRef: proof.txnRef,
          amountMinor: proof.amountMinor,
          currency: proof.currency,
        });
      } catch {
        throw new Error('CHECKOUT_VERIFICATION_UNAVAILABLE');
      }
    },
    async lookup(input: {
      organizationId: string;
      sessionId: string;
      restoreGeneration: string;
      action: 'paddle.lookup_paid' | 'paddle.lookup_cancelled';
      txnRef: string;
      amountMinor: bigint | null;
      currency: string | null;
    }) {
      try {
        return await attestCheckoutLookup(secrets, {
          organizationId: idSchema.parse(input.organizationId),
          sessionId: idSchema.parse(input.sessionId),
          restoreGeneration: idSchema.parse(input.restoreGeneration),
          action: input.action,
          txnRef: input.txnRef,
          amountMinor: input.amountMinor,
          currency: input.currency,
        });
      } catch {
        throw new Error('CHECKOUT_VERIFICATION_UNAVAILABLE');
      }
    },
  };
}
