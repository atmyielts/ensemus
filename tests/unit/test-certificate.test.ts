// Generated certificates must always be accepted by the actual Node TLS parser, regardless of signature length.
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { describe, it, expect } from 'vitest';
import { generateTestCertificate } from '../helpers/smtp-sink';
describe('generated local TLS certificates', () => {
  it.each(['adapter.example.invalid', 'relay.example.invalid', 'x.invalid'])(
    'parses, verifies and matches its key for %s on every generated signature',
    (name) => {
      for (let i = 0; i < 40; i++) {
        const generated = generateTestCertificate(name);
        expect(() => createSecureContext(generated)).not.toThrow();
        const certificate = new X509Certificate(generated.cert);
        expect(certificate.verify(certificate.publicKey)).toBe(true);
        expect(certificate.checkHost(name)).toBe(name);
        expect(certificate.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
          createPublicKey(createPrivateKey(generated.key)).export({ type: 'spki', format: 'der' }),
        );
      }
    },
  );
});
