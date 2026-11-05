#!/usr/bin/env node
// Creates throwaway secrets for local and CI stacks under .local/secrets (ignored by git).
// These are test values only. Real deployments supply their own through a secret mount.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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

for (const role of ['superuser', 'migrator', 'app', 'auth', 'dispatcher', 'secrets', 'temporal']) {
  put(`db_${role}_password`, password);
}
for (const [name, role, file] of [
  ['db_migrator_url', 'ensemus_migrator', 'db_migrator_password'],
  ['db_app_url', 'ensemus_app', 'db_app_password'],
  ['db_auth_url', 'ensemus_auth', 'db_auth_password'],
  ['db_secrets_url', 'ensemus_secrets', 'db_secrets_password'],
  ['db_dispatcher_url', 'ensemus_dispatcher', 'db_dispatcher_password'],
]) {
  const pw = await read(file);
  put(name, () => `postgres://${role}:${pw}@postgres:5432/ensemus`);
}
put('objects_access_key', () => randomBytes(12).toString('hex'));
put('objects_secret_key', () => randomBytes(24).toString('hex'));
put('objects_identity.json', () =>
  JSON.stringify({
    identities: [
      {
        name: 'ensemus',
        credentials: [
          {
            accessKey: readFileSync(join(dir, 'objects_access_key'), 'utf8'),
            secretKey: readFileSync(join(dir, 'objects_secret_key'), 'utf8'),
          },
        ],
        actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
      },
    ],
  }),
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
console.log(`Test secrets ready in ${dir}`);
