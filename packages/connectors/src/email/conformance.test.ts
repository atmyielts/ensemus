// Every connector runs the SDK's suite in its own test file (ADR-027 D3). The sdk slice builds the suite.
// Until that lands on this branch it throws NOT_IMPLEMENTED, and this says so as a todo rather than
// passing: nothing here can read as conformance before the suite has really run.
import { it } from 'vitest';
import { describeConnectorConformance } from '../testing';
import { createEmailConnector } from './index';

const make = () =>
  createEmailConnector({ tls: 'required', messageIdDomain: 'mail.example.invalid' });
const config = { fromAddress: 'sender@example.invalid', tlsServerName: 'relay.example.invalid' };

try {
  describeConnectorConformance('email_smtp', make, { config });
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'NOT_IMPLEMENTED') throw error;
  it.todo('email_smtp passes the SDK conformance suite, once the sdk slice is merged');
}
