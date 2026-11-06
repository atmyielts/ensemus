// Owned by the email slice. See docs/06-delivery/m3-slices.md.
import type { Connector } from '../index';

export { EMAIL_CONNECTOR_TYPE } from '@ensemus/domain/external-action';

/** Not secret, and never a host: the gateway decides where this connects. */
export type EmailConfig = {
  /** The one address this connection may send as. A payload naming another is refused. */
  fromAddress: string;
  fromName?: string;
  /** The name to check the relay's TLS certificate against. */
  tlsServerName?: string;
};

/** The SMTP connector. Set up by the email slice with `createEmailConnector`. */
export function createEmailConnector(_options: {
  /** `required` unless an operator has said otherwise for a relay on a trusted site network. */
  tls: 'required' | 'none';
  /** The domain in the deterministic Message-ID. */
  messageIdDomain: string;
}): Connector<EmailConfig> {
  throw new Error('NOT_IMPLEMENTED');
}
