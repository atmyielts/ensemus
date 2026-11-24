#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const dir = fileURLToPath(new URL('../../.local/secrets', import.meta.url));
mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
try {
  mkdirSync(dir, { mode: 0o700 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('Secrets directory already exists. Keep its keys and use the rotation guide.');
  process.exit(1);
}
chmodSync(dir, 0o700);

const hex = (bytes) => randomBytes(bytes).toString('hex');
const files = {
  db_superuser_password: hex(24),
  db_temporal_password: hex(24),
};
for (const role of [
  'migrator',
  'app',
  'agent',
  'worker',
  'connector',
  'knowledge',
  'auth',
  'dispatcher',
  'secrets',
  'mailer',
  'federation',
]) {
  const password = hex(24);
  files[`db_${role}_password`] = password;
  files[`db_${role}_url`] = `postgres://ensemus_${role}:${password}@postgres:5432/ensemus`;
}

function objectIdentity(name, prefix, actions) {
  const accessKey = hex(12);
  const secretKey = hex(24);
  files[`${prefix}_access_key`] = accessKey;
  files[`${prefix}_secret_key`] = secretKey;
  return { name, credentials: [{ accessKey, secretKey }], actions };
}
files['objects_identity.json'] = JSON.stringify({
  identities: [
    objectIdentity('ensemus', 'objects', ['Admin', 'Read', 'Write', 'List', 'Tagging']),
    objectIdentity('ensemus-ledger', 'objects_ledger', [
      'Read:ensemus/tombstone-ledger/*',
      'Write:ensemus/tombstone-ledger/*',
    ]),
    objectIdentity('ensemus-backup', 'objects_backup', [
      'Read:ensemus-backups',
      'Write:ensemus-backups',
      'List:ensemus-backups',
    ]),
  ],
});

for (const key of ['auth_secret', 'next_server_actions_key', 'temporal_codec_key']) {
  files[key] = randomBytes(32).toString('base64');
}
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
files['sealing_public_key.pem'] = publicKey;
files['sealing_private_key.pem'] = privateKey;

// Protect the host directory. Compose bind mounts keep the file mode, so nonroot
// services need to read the files mounted in their own containers.
for (const [name, value] of Object.entries(files)) {
  const path = join(dir, name);
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o644);
}
console.log('Install secrets created in .local/secrets.');
