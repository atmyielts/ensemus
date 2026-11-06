import 'server-only';
import { AppError, ingestWebhookDelivery } from '@ensemus/application';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { errorCode } from '@ensemus/telemetry';
import { createWebhookLimiter, handleWebhookRequest } from '@/lib/webhook-limiter';
import { getRestoreGate, getRuntime } from './runtime';

// A small pool of its own, so a flood at this address cannot use up what the product needs. Opened on
// first use, because a deployment with connectors off never needs it.
const INGRESS_CONNECTIONS = 2;
let ingress: ReturnType<typeof openAppDatabase> | undefined;

const limiter = createWebhookLimiter();

/** The route's whole job. The token goes no further than the service, and is never logged. */
export function handleWebhook(request: Request, token: string): Promise<Response> {
  const { config, log } = getRuntime();
  return handleWebhookRequest(request, token, {
    enabled: () => config.connectorsEnabled,
    limiter,
    ingest: async (input) => {
      ingress ??= openAppDatabase(readSecret('DATABASE_URL_APP'), { max: INGRESS_CONNECTIONS });
      try {
        return await ingestWebhookDelivery(ingress.db, input, {
          assertServing: (context) => getRestoreGate().assertServing(context),
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'RESTORE_PENDING') return 'restoring';
        throw error;
      }
    },
    onError: (error) => log.warn('webhook.ingress_failed', { errorCode: errorCode(error) }),
  });
}
