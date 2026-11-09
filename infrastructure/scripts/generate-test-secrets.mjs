#!/usr/bin/env node
// Creates throwaway secrets for local and CI stacks under .local/secrets (ignored by git).
// These are test values only. Real deployments supply their own through a secret mount.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, '.local', 'secrets');
mkdirSync(dir, { recursive: true });

const put = (name, make) => {
  const path = join(dir, name);
  if (!existsSync(path)) writeFileSync(path, make(), { mode: 0o644 });
};
const password = () => randomBytes(24).toString('hex');
const read = (name) => import('node:fs').then((fs) => fs.readFileSync(join(dir, name), 'utf8'));

for (const role of [
  'superuser',
  'migrator',
  'app',
  'agent',
  'auth',
  'dispatcher',
  'secrets',
  'temporal',
]) {
  put(`db_${role}_password`, password);
}
for (const [name, role, file] of [
  ['db_migrator_url', 'ensemus_migrator', 'db_migrator_password'],
  ['db_app_url', 'ensemus_app', 'db_app_password'],
  ['db_agent_url', 'ensemus_agent', 'db_agent_password'],
  ['db_auth_url', 'ensemus_auth', 'db_auth_password'],
  ['db_secrets_url', 'ensemus_secrets', 'db_secrets_password'],
  ['db_dispatcher_url', 'ensemus_dispatcher', 'db_dispatcher_password'],
]) {
  const pw = await read(file);
  put(name, () => `postgres://${role}:${pw}@postgres:5432/ensemus`);
}
put('objects_access_key', () => randomBytes(12).toString('hex'));
put('objects_secret_key', () => randomBytes(24).toString('hex'));
put('objects_ledger_access_key', () => randomBytes(12).toString('hex'));
put('objects_ledger_secret_key', () => randomBytes(24).toString('hex'));
const credentials = (access, secret) => ({
  accessKey: readFileSync(join(dir, access), 'utf8'),
  secretKey: readFileSync(join(dir, secret), 'utf8'),
});
// Worked out from the keys above every time, so a secrets folder made before a new identity existed
// gets it too.
writeFileSync(
  join(dir, 'objects_identity.json'),
  JSON.stringify({
    identities: [
      {
        name: 'ensemus',
        credentials: [credentials('objects_access_key', 'objects_secret_key')],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
      {
        // The dispatcher writes the tombstone ledger and can touch nothing else in the store, so
        // the process that may never see a customer's content still cannot (ADR-026).
        name: 'ensemus-ledger',
        credentials: [credentials('objects_ledger_access_key', 'objects_ledger_secret_key')],
        actions: ['Read:ensemus/tombstone-ledger/*', 'Write:ensemus/tombstone-ledger/*'],
      },
    ],
  }),
  { mode: 0o644 },
);
put('auth_secret', () => randomBytes(32).toString('base64'));
put('temporal_codec_key', () => randomBytes(32).toString('base64'));
put('next_server_actions_key', () => randomBytes(32).toString('base64'));

if (!existsSync(join(dir, 'sealing_private_key.pem'))) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(join(dir, 'sealing_private_key.pem'), privateKey, { mode: 0o644 });
  writeFileSync(join(dir, 'sealing_public_key.pem'), publicKey, { mode: 0o644 });
}

// A license trust root for the test stack (ADR-030 D3), and the generated key it trusts. compose.test.yaml
// mounts only the trust root, which holds public keys alone, into web, web-2 and worker. The private half stays
// here, outside every container, for tests/stack/sovereign-api.test.ts to sign test documents with. The key is
// marked test_only, so everything it signs says so on every page, and no real deployment trusts it.
const sovereignTest = join(root, '.local', 'sovereign-test');
mkdirSync(sovereignTest, { recursive: true });
const SIGNING_KEY_ID = 'stack-test-key';
const signingKeyFile = join(sovereignTest, 'test-signing-key.pem');
if (!existsSync(signingKeyFile)) {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(signingKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
}
writeFileSync(join(sovereignTest, 'test-signing-key.id'), `${SIGNING_KEY_ID}\n`, { mode: 0o644 });
// Worked out from the private key every time, so the trust root can never name a key that is not there.
const signingPublicKey = createPublicKey(createPrivateKey(readFileSync(signingKeyFile)));
writeFileSync(
  join(sovereignTest, 'trust-root.json'),
  JSON.stringify({
    format: 'ensemus.trust_root',
    format_version: 1,
    keys: [
      {
        key_id: SIGNING_KEY_ID,
        algorithm: 'ed25519',
        public_key: signingPublicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        purposes: [
          'license',
          'maintenance',
          'advisory',
          'support_policy',
          'bundle',
          'diagnostic_recipient',
        ],
        retired_on: null,
        compromised_on: null,
        test_only: true,
      },
    ],
    thresholds: {},
  }),
  { mode: 0o644 },
);
console.log(`Test secrets ready in ${dir}`);
