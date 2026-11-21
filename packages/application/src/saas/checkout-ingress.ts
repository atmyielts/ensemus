// The web tier's side of Payme's and Click's calls (ADR-032 D4a). Both wait on the line for an answer, so
// the web tier stores the bytes exactly as M3 does, believing none of them, and then reads back the one
// answer the connector worker stored for that delivery, or learns that the worker refused it. It holds no
// key and decides nothing: every answer it can give by itself is one that reveals no order.
import {
  checkoutReplies,
  webhookDeliveries,
  withWebhookEndpointTx,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import {
  hashWebhookToken,
  isWebhookTokenShape,
  type WebhookRejectCode,
} from '@ensemus/domain/webhook';
import { and, eq } from 'drizzle-orm';
import { idSchema } from '../ids';
import { ingestWebhookDeliveryWithId, type IngestWebhookInput } from '../webhooks';

export type CheckoutIngressScheme = 'payme_basic_v1' | 'click_md5_v1';

export function ingestCheckoutCall(
  database: AppDatabase,
  input: IngestWebhookInput & { scheme: CheckoutIngressScheme },
  options: { assertServing?: (context: TenantContext) => Promise<void> } = {},
) {
  return ingestWebhookDeliveryWithId(
    database,
    { token: input.token, body: input.body, headers: input.headers },
    { ...options, scheme: input.scheme },
  );
}

export type CheckoutAnswer =
  | { kind: 'reply'; body: string }
  | { kind: 'rejected'; code: WebhookRejectCode | null }
  | { kind: 'pending' };

/** One read. The caller polls this, within its own deadline, for the delivery it just stored. */
export async function readCheckoutAnswer(
  database: AppDatabase,
  input: { token: string; deliveryId: string },
): Promise<CheckoutAnswer> {
  const deliveryId = idSchema.safeParse(input.deliveryId);
  if (!isWebhookTokenShape(input.token) || !deliveryId.success)
    return { kind: 'rejected', code: null };
  const answer = await withWebhookEndpointTx(
    database,
    hashWebhookToken(input.token),
    async (tx, { endpoint }): Promise<CheckoutAnswer> => {
      const [reply] = await tx
        .select({ body: checkoutReplies.body })
        .from(checkoutReplies)
        .where(
          and(
            eq(checkoutReplies.organizationId, endpoint.organizationId),
            eq(checkoutReplies.deliveryId, deliveryId.data),
          ),
        );
      if (reply) return { kind: 'reply', body: reply.body };
      const [delivery] = await tx
        .select({ state: webhookDeliveries.state, rejectCode: webhookDeliveries.rejectCode })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.organizationId, endpoint.organizationId),
            eq(webhookDeliveries.endpointId, endpoint.id),
            eq(webhookDeliveries.id, deliveryId.data),
          ),
        );
      if (!delivery) return { kind: 'rejected', code: null };
      if (delivery.state === 'received') return { kind: 'pending' };
      // Applied or a duplicate with no stored answer, rejected, or failed: none has an answer to repeat.
      return { kind: 'rejected', code: (delivery.rejectCode as WebhookRejectCode | null) ?? null };
    },
  );
  return answer ?? { kind: 'rejected', code: null };
}
