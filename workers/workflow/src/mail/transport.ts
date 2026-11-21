// The mail worker's only way out: one TCP connection to its own egress gateway per message, which forwards
// to the one relay an operator configured (ADR-027 D5). TLS runs end to end through the gateway and the
// relay's name is checked here, so the gateway sees only ciphertext. The SMTP client is the email
// connector's (ADR-027 D2), which knows exactly when a message may have gone. A refusal before the commit
// point is thrown with the relay's status kept, for the loop to tell a bounce from a busy relay.
import { connect, type Socket } from 'node:net';
import { NotSent } from '@ensemus/connectors';
import { deliver } from '@ensemus/connectors/email/smtp';
import type { AttemptResult } from '@ensemus/domain/external-action';
import type { MailConfig } from './config';
import type { MailTransport } from './loop';

const CONNECT_TIMEOUT_MS = 15_000;
/** Before this, a stall still means nothing went. After it, the client waits for the reply alone. */
const BEFORE_COMMIT_MS = 30_000;
/** The whole send, including the reply after the terminator. Well inside the claim lease. */
const SEND_DEADLINE_MS = 60_000;

function openGateway(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new NotSent('CONNECT_FAILED', true));
    };
    const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
    signal.addEventListener('abort', fail, { once: true });
    socket.once('error', fail);
    socket.once('connect', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      socket.off('error', fail);
      resolve(socket);
    });
  });
}

export function createSmtpTransport(config: MailConfig): MailTransport {
  return async (message): Promise<AttemptResult> => {
    const signal = AbortSignal.timeout(SEND_DEADLINE_MS);
    const stream = await openGateway(config.gateway.host, config.gateway.port, signal);
    return deliver({
      stream,
      signal,
      beforeCommitMs: BEFORE_COMMIT_MS,
      tls: config.tls,
      ehloName: config.messageIdDomain,
      username: config.username,
      // A copy for each login, wiped as soon as it has been written.
      withCredential: async (use) => {
        const secret = Buffer.from(config.password);
        try {
          await use(secret);
        } finally {
          secret.fill(0);
        }
      },
      envelopeFrom: message.envelopeFrom,
      recipients: message.recipients,
      data: message.data,
      messageId: message.messageId,
    });
  };
}
