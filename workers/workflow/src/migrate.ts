// The one setup job. Replicas never migrate themselves (see ADR-024 D4 and the deployment doc).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentProfileHash, loadTenancyConfig, readSecret } from '@ensemus/config';
import { applyDeploymentProfile } from '@ensemus/database/deployment';
import { runMigrations } from '@ensemus/database/migrate';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('migrate');
const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Preserve the default upgrade path when no operator chose a federation setting.
  const profile = process.env.ENSEMUS_CROSS_ORG_ENABLED ? loadTenancyConfig() : undefined;
  const migrator = readSecret('DATABASE_URL_MIGRATOR');
  await runMigrations(migrator, path.join(here, '..', 'migrations'), {
    requireFederationRole: profile?.crossOrgEnabled === true,
  });
  await new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  }).ensureBucket();
  if (profile) {
    await applyDeploymentProfile(migrator, {
      ...profile,
      profileSha256: deploymentProfileHash(profile),
    });
    log.info('deployment_profile.applied', { status: profile.tier });
  }
  log.info('migrate.done');
}

main().catch((error: unknown) => {
  log.error('migrate.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
