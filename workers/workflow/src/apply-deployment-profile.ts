// The deploy job that says what this deployment is (ADR-035 D5). Run once per deploy, after migrate, with the
// migrator's URL. Owned by the tier slice. See docs/06-delivery/m11c-slices.md.
import { deploymentProfileHash, loadTenancyConfig, readSecret } from '@ensemus/config';
import { applyDeploymentProfile } from '@ensemus/database/deployment';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('apply-deployment-profile');

async function main() {
  const config = loadTenancyConfig();
  await applyDeploymentProfile(readSecret('DATABASE_URL_MIGRATOR'), {
    ...config,
    profileSha256: deploymentProfileHash(config),
  });
  log.info('deployment_profile.applied', { status: config.tier });
}

main().catch((error: unknown) => {
  log.error('deployment_profile.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
