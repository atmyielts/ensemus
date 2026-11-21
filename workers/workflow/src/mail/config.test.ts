import { describe, expect, it } from 'vitest';
import { loadMailConfig } from './config';

const env = {
  ENSEMUS_MAIL_GATEWAY: 'mail-gateway:2525',
  ENSEMUS_PUBLIC_URL: 'https://ensemus.example.com',
  ENSEMUS_MAIL_FROM_ADDRESS: 'ensemus@example.com',
  ENSEMUS_MAIL_TLS_SERVER_NAME: 'smtp.example.com',
  ENSEMUS_MAIL_PASSWORD: 'relay-secret',
};

describe('the mail worker settings', () => {
  it('requires TLS with a certificate name unless told otherwise', () => {
    const config = loadMailConfig(env);
    expect(config.tls).toEqual({ mode: 'required', servername: 'smtp.example.com' });
    expect(config.messageIdDomain).toBe('ensemus.example.com');
    expect(config.fromName).toBe('Ensemus');
    expect(config.username).toBe('ensemus@example.com');
    expect(config.password.toString()).toBe('relay-secret');
    expect(() => loadMailConfig({ ...env, ENSEMUS_MAIL_TLS_SERVER_NAME: '' })).toThrow(
      /ENSEMUS_MAIL_TLS_SERVER_NAME/,
    );
    expect(() => loadMailConfig({ ...env, ENSEMUS_MAIL_TLS_SERVER_NAME: '10.0.0.1' })).toThrow();
    expect(loadMailConfig({ ...env, ENSEMUS_MAIL_TLS: 'none' }).tls).toEqual({ mode: 'none' });
  });

  it('names the setting at fault, never its value', () => {
    for (const [name, value] of [
      ['ENSEMUS_MAIL_GATEWAY', 'https://relay.example.com'],
      ['ENSEMUS_MAIL_FROM_ADDRESS', 'not an address'],
      ['ENSEMUS_MAIL_FROM_NAME', 'Ensemus\r\nBcc: eve@example.com'],
      ['ENSEMUS_MAIL_TLS', 'optional'],
      ['ENSEMUS_PUBLIC_URL', 'https://ensemus.example.com/app'],
    ]) {
      expect(() => loadMailConfig({ ...env, [name!]: value })).toThrow(name);
      try {
        loadMailConfig({ ...env, [name!]: value });
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    }
    expect(() => loadMailConfig({ ...env, ENSEMUS_MAIL_PASSWORD: '' })).toThrow(
      /ENSEMUS_MAIL_PASSWORD/,
    );
  });
});
