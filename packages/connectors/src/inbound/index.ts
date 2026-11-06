// The generic signed callback (ADR-027 D4): a customer's own system tells Ensemus something needs doing.
// `interpret` runs only after the signature has passed, and this is the one schema that reads a body.
import { inboundWebhookEnvelopeSchema } from '@ensemus/contracts/external-actions';
import { EMAIL_SEND_TOOL, EMAIL_SEND_VERSION } from '@ensemus/domain/external-action';
import { z } from 'zod';
import { MalformedWebhook, type Connector, type WebhookEffect } from '../index';
import { INBOUND_CONNECTOR_MANIFEST } from '../manifest';

export const INBOUND_CONNECTOR_TYPE = 'inbound_webhook';

export type InboundConfig = Record<string, never>;

const configSchema = z.strictObject({});
// Fatal, because a body that is not UTF-8 is not the JSON the signature was promised to cover.
const utf8 = new TextDecoder('utf-8', { fatal: true });

function parseEnvelope(body: Uint8Array) {
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(body));
  } catch {
    // The parser's message quotes the body, so it goes no further than this.
    throw new MalformedWebhook();
  }
  const parsed = inboundWebhookEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new MalformedWebhook();
  return parsed.data;
}

/**
 * The generic signed callback, in the envelope `inboundWebhookEnvelopeSchema` describes. It needs no
 * network and no credential, because its secret is the endpoint's signing secret. It can only ask: an
 * action still waits for a person, and the sender comes from the connection and not from this body.
 */
export function createInboundConnector(): Connector<InboundConfig> {
  return {
    manifest: INBOUND_CONNECTOR_MANIFEST,
    parseConfig: (raw) => configSchema.parse(raw) as InboundConfig,
    webhooks: {
      interpret(_context, webhook): readonly WebhookEffect[] {
        const envelope = parseEnvelope(webhook.body);
        switch (envelope.type) {
          case 'external_action.proposed':
            return [
              {
                kind: 'action_proposed',
                workUnitId: envelope.work_unit_id,
                connectionId: envelope.connection_id,
                toolName: EMAIL_SEND_TOOL,
                toolVersion: EMAIL_SEND_VERSION,
                payload: envelope.email,
              },
            ];
          case 'connector.sync_requested':
            return [{ kind: 'sync_requested' }];
        }
      },
    },
  };
}
