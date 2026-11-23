import { describe, it, expect } from 'vitest';
import { loadBusinessConnectorRoutes } from './business';
describe('operator business routes', () => {
  it('offers none by default, including an offline or Cloud deployment', () => {
    expect(loadBusinessConnectorRoutes({})).toEqual({});
    expect(loadBusinessConnectorRoutes({ ENSEMUS_MODE: 'cloud' })).toEqual({});
  });
  it.each(['byom', 'sovereign'])('takes only explicit routes in %s', (mode) => {
    expect(
      loadBusinessConnectorRoutes({
        ENSEMUS_MODE: mode,
        ENSEMUS_EGRESS_GATEWAY_CRM: ' crm-relay:2525 ',
        ENSEMUS_EGRESS_GATEWAY_ACCOUNTING: '127.0.0.1:1234',
      }),
    ).toEqual({ crm_http: 'crm-relay:2525', accounting_http: '127.0.0.1:1234' });
  });
  it('refuses Cloud adapter routing until the multi-tenant route contract exists', () => {
    expect(() =>
      loadBusinessConnectorRoutes({
        ENSEMUS_MODE: 'cloud',
        ENSEMUS_EGRESS_GATEWAY_CRM: 'crm-relay:2525',
      }),
    ).toThrow(/require BYOM or Sovereign/);
  });
  it.each([
    'relay',
    'relay:0',
    'relay:65536',
    'user:generated-password@relay:2525',
    'relay:2525/path',
    'relay:2525?token=generated-secret',
    'relay:2525#fragment',
    'http://relay:2525',
  ])('refuses malformed or credential-bearing route %s without echoing it', (address) => {
    let error: unknown;
    try {
      loadBusinessConnectorRoutes({ ENSEMUS_EGRESS_GATEWAY_CRM: address });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ message: 'Invalid ENSEMUS_EGRESS_GATEWAY_CRM' });
  });
});
