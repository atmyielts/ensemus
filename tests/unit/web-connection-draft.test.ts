import { describe, it, expect } from 'vitest';
import { connectionDraft, connectionSettings } from '../../apps/web/src/lib/connection-draft';
describe('connection setup form decoding', () => {
  it.each(['crm_http', 'ticketing_http', 'accounting_http'])(
    'keeps safe %s choices without retaining credentials or posted grants',
    (type) => {
      const f = new FormData();
      f.set('connectorType', type);
      f.set('displayName', 'A connection');
      f.set('tlsServerName', ' adapter.example.invalid ');
      f.append('streams', 'selected.group');
      f.set('credential', 'GENERATED-PASSWORD');
      f.set('grantedScopes', 'forged.admin');
      f.set('host', '169.254.169.254');
      const draft = connectionDraft(f),
        settings = connectionSettings(draft);
      expect(settings).toEqual({
        tlsServerName: 'adapter.example.invalid',
        streams: ['selected.group'],
        scopes: [type + '.read'],
      });
      expect(JSON.stringify({ draft, settings })).not.toMatch(
        /GENERATED-PASSWORD|forged.admin|169.254/,
      );
      f.set('allowWrites', 'yes');
      expect(connectionSettings(connectionDraft(f)).scopes).toEqual([
        type + '.read',
        type + '.write',
      ]);
    },
  );
  it('leaves record selection empty and never converts other checkbox values into a write grant', () => {
    const f = new FormData();
    f.set('connectorType', 'crm_http');
    f.set('allowWrites', 'true');
    expect(connectionSettings(connectionDraft(f))).toEqual({
      streams: [],
      scopes: ['crm_http.read'],
    });
  });
  it('retains the existing email settings and keeps callback settings empty', () => {
    const f = new FormData();
    f.set('connectorType', 'email_smtp');
    f.set('fromAddress', ' sender@example.invalid ');
    f.set('fromName', ' Team ');
    expect(connectionSettings(connectionDraft(f))).toEqual({
      fromAddress: 'sender@example.invalid',
      fromName: 'Team',
    });
    f.set('connectorType', 'inbound_webhook');
    expect(connectionSettings(connectionDraft(f))).toEqual({});
  });
});
