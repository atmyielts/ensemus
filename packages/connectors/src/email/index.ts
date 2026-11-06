// The email connector, the one real connector in M3 (ADR-027 D2, D3). What it sends comes only from the
// approved payload: nothing is looked up, so a client record changing does not change where a mail goes.
// It never retries and never asks what happened, because SMTP has no way to ask.
import { z } from 'zod';
import { emailSendPayloadSchema } from '@ensemus/contracts/external-actions';
import { SECRET_PURPOSE_CONNECTOR_CREDENTIAL } from '@ensemus/domain/connector';
import {
  EMAIL_CONNECTOR_TYPE,
  EMAIL_SEND_TOOL,
  EMAIL_SEND_VERSION,
} from '@ensemus/domain/external-action';
import { NotSent, type ActionRequest, type Connector, type ConnectorContext } from '../index';
import { buildMessage, dotStuff, UnsafeMessage } from './message';
import { deliver, RefusedBeforeCommit } from './smtp';

export { EMAIL_CONNECTOR_TYPE } from '@ensemus/domain/external-action';

/** Not secret, and never a host: the gateway decides where this connects. */
export type EmailConfig = {
  /** The one address this connection may send as. A payload naming another is refused. */
  fromAddress: string;
  fromName?: string;
  /** The name to check the relay's TLS certificate against. */
  tlsServerName?: string;
  /** Who to log in as, when that is not the sender. The password is the sealed credential. */
  username?: string;
};

const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Half of runSend's deadline. That deadline reads as "it may have gone", so a relay that stalls before
 * the commit point has to be given up on sooner, while this can still say for certain that nothing went.
 * Otherwise a silent relay would cost a person a false `unknown`. The rest of the time is for the reply.
 */
const BEFORE_COMMIT_MS = 30_000;

const noLineBreaks = (value: string) => !/[\r\n\0\v\f]/.test(value);
/** A DNS name with a letter in its last label, so an IP address cannot pass as a certificate name. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z][A-Za-z0-9-]{0,62}$/;

const configSchema = z.strictObject({
  fromAddress: z.email().max(254).refine(noLineBreaks),
  fromName: z.string().trim().min(1).max(120).refine(noLineBreaks).optional(),
  tlsServerName: z.string().regex(HOSTNAME).optional(),
  username: z.string().min(1).max(254).refine(noLineBreaks).optional(),
});

/** The SMTP connector. */
export function createEmailConnector(options: {
  /** `required` unless an operator has said otherwise for a relay on a trusted site network. */
  tls: 'required' | 'none';
  /** The domain in the deterministic Message-ID. */
  messageIdDomain: string;
  /** Another certificate authority to trust, such as a site's own. It never turns checking off. */
  ca?: string;
  /** Only a test changes this. */
  beforeCommitMs?: number;
}): Connector<EmailConfig> {
  const { tls, messageIdDomain, ca, beforeCommitMs = BEFORE_COMMIT_MS } = options;
  if (!HOSTNAME.test(messageIdDomain)) throw new Error('INVALID_MESSAGE_ID_DOMAIN');

  async function send(context: ConnectorContext<EmailConfig>, request: ActionRequest) {
    const { config, signal } = context;
    // Each of these fails the same way every time, so none is retryable and none contacts anyone. The
    // fixed list of codes has no closer word for a payload that no longer fits its connection.
    if (request.toolName !== EMAIL_SEND_TOOL || request.toolVersion !== EMAIL_SEND_VERSION) {
      throw new NotSent('PAYLOAD_CHANGED', false);
    }
    const parsed = emailSendPayloadSchema.safeParse(request.payload);
    if (!parsed.success) throw new NotSent('PAYLOAD_CHANGED', false);
    const payload = parsed.data;
    if (payload.from.address.toLowerCase() !== config.fromAddress.toLowerCase()) {
      throw new NotSent('PAYLOAD_CHANGED', false);
    }
    if (tls === 'required' && !config.tlsServerName) throw new NotSent('TLS_REQUIRED', false);

    // The same on every attempt, so that someone can search the relay's log for it.
    const messageId = `<${request.externalActionId}@${messageIdDomain}>`;
    let message;
    try {
      message = buildMessage({ payload, messageId, date: new Date() });
    } catch (error) {
      if (error instanceof UnsafeMessage) throw new NotSent('PAYLOAD_CHANGED', false);
      throw error;
    }
    if (signal.aborted) throw new NotSent('TIMEOUT_BEFORE_COMMIT', true);

    let stream;
    try {
      stream = await context.network.openRelay({ timeoutMs: CONNECT_TIMEOUT_MS, signal });
    } catch {
      throw signal.aborted
        ? new NotSent('TIMEOUT_BEFORE_COMMIT', true)
        : new NotSent('CONNECT_FAILED', true);
    }
    try {
      return await deliver({
        stream,
        signal,
        beforeCommitMs,
        tls:
          tls === 'required'
            ? {
                mode: 'required',
                servername: config.tlsServerName ?? '',
                ...(ca ? { ca } : {}),
              }
            : { mode: 'none' },
        ehloName: messageIdDomain,
        username: config.username ?? config.fromAddress,
        withCredential: (use) => context.credentials.withCredential(use),
        envelopeFrom: message.envelopeFrom,
        recipients: message.recipients,
        data: dotStuff(message.data),
        messageId,
      });
    } catch (error) {
      // Returned rather than thrown, because a thrown NotSent has nowhere to carry the relay's status.
      if (error instanceof RefusedBeforeCommit) {
        return {
          outcome: 'not_sent' as const,
          code: error.code,
          retryable: error.retryable,
          providerStatus: error.providerStatus,
        };
      }
      throw error;
    }
  }

  return {
    manifest: {
      type: EMAIL_CONNECTOR_TYPE,
      version: EMAIL_SEND_VERSION,
      displayName: 'Email (SMTP)',
      capabilities: {
        actions: [EMAIL_SEND_TOOL],
        reconcile: 'none',
        nativeIdempotency: false,
        sync: null,
        aclMapping: false,
        webhooks: null,
        network: 'egress_gateway',
      },
      credential: { required: true, purpose: SECRET_PURPOSE_CONNECTOR_CREDENTIAL },
    },
    parseConfig(raw) {
      const parsed = configSchema.safeParse(raw);
      // A fixed message: what was refused could hold anything, including something secret.
      if (!parsed.success) throw new Error('INVALID_CONNECTOR_CONFIG');
      if (tls === 'required' && !parsed.data.tlsServerName) {
        throw new Error('INVALID_CONNECTOR_CONFIG');
      }
      return parsed.data as EmailConfig;
    },
    actions: {
      send: (context, request) => send(context, request),
      // SMTP has no way to ask whether a message was taken. A person searches the relay's log instead.
      reconcile: async () => ({ answer: 'cannot_answer' }),
    },
  };
}
