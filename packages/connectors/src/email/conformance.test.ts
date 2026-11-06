// Every connector runs the SDK's suite in its own test file (ADR-027 D3).
import { describeConnectorConformance } from '../testing';
import { createEmailConnector } from './index';

const make = () =>
  createEmailConnector({ tls: 'required', messageIdDomain: 'mail.example.invalid' });
const config = { fromAddress: 'sender@example.invalid', tlsServerName: 'relay.example.invalid' };

describeConnectorConformance('email_smtp', make, { config });
