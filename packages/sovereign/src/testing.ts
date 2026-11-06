// Generated keys and documents for tests. Lint keeps this out of everything that ships, and every key it
// makes is marked `test_only`, which any page showing what it signed has to say out loud.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { PAYLOAD_TYPES, preAuthEncoding, type SignedEnvelope } from './envelope';
import { DOCUMENT_PURPOSES, parseTrustRoot, type DocumentPurpose, type TrustRoot } from './trust-root';

export type TestSigningKey = { keyId: string; privateKey: KeyObject; publicKeyBase64: string };

export function generateTestSigningKey(keyId = 'test-key-1'): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKey,
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export type TestKeyOptions = {
  purposes?: readonly DocumentPurpose[];
  retiredOn?: string;
  compromisedOn?: string;
  testOnly?: boolean;
};

/** The JSON text of a trust root, for a test that wants to read it the way a deployment does. */
export function testTrustRootText(
  keys: readonly (TestSigningKey & TestKeyOptions)[],
  thresholds: Partial<Record<DocumentPurpose, number>> = {},
): string {
  return JSON.stringify({
    format: 'ensemus.trust_root',
    format_version: 1,
    keys: keys.map((key) => ({
      key_id: key.keyId,
      algorithm: 'ed25519',
      public_key: key.publicKeyBase64,
      purposes: key.purposes ?? DOCUMENT_PURPOSES,
      retired_on: key.retiredOn ?? null,
      compromised_on: key.compromisedOn ?? null,
      test_only: key.testOnly ?? true,
    })),
    thresholds,
  });
}

export const testTrustRoot = (
  keys: readonly (TestSigningKey & TestKeyOptions)[],
  thresholds: Partial<Record<DocumentPurpose, number>> = {},
): TrustRoot => parseTrustRoot(testTrustRootText(keys, thresholds));

/** Signs any bytes as a document of this kind. A test can sign nonsense, which is often the point. */
export function signForTest(
  purpose: DocumentPurpose,
  payload: Buffer | object,
  keys: readonly TestSigningKey[],
): string {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const type = PAYLOAD_TYPES[purpose];
  const envelope: SignedEnvelope = {
    payloadType: type,
    payload: bytes.toString('base64'),
    signatures: keys.map((key) => ({
      keyid: key.keyId,
      sig: sign(null, preAuthEncoding(type, bytes), key.privateKey).toString('base64'),
    })),
  };
  return JSON.stringify(envelope);
}

const ID = '6f1c2c6e-1111-4111-8111-111111111111';

/** A well-formed license with generated values, for tests to adjust. */
export function testLicense(overrides: Record<string, unknown> = {}) {
  return {
    format: 'ensemus.license',
    format_version: 1,
    license_id: ID,
    issued_at: '2027-01-01T00:00:00.000Z',
    licensee: { display_name: 'Test Licensee', contract_reference: 'TEST-CONTRACT-1' },
    edition: 'sovereign',
    term: { kind: 'perpetual' },
    licensed_release: { line: '2.0', version: '2.0.0' },
    footprint: {
      organizations: null,
      seats: null,
      production_deployments: null,
      nonproduction_deployments: null,
    },
    components: ['web', 'worker'],
    update_rights: {
      security_patches_after_lapse: 'none',
      major_versions_with_maintenance: 'separate_purchase',
      releases_published_during_maintenance: 'kept_after_lapse',
      outside_rights_on_install: 'warn',
    },
    ...overrides,
  };
}

export function testMaintenance(overrides: Record<string, unknown> = {}) {
  return {
    format: 'ensemus.maintenance',
    format_version: 1,
    maintenance_id: '6f1c2c6e-2222-4222-8222-222222222222',
    license_id: ID,
    issued_at: '2027-01-01T00:00:00.000Z',
    starts_on: '2027-01-01',
    ends_on: '2027-12-31',
    ...overrides,
  };
}
