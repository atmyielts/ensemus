// The operator's two identity commands (ADR-031 D8, D9). No tenant can do either of these for itself:
//   docker compose run --rm --no-deps migrate node dist/identity-operator.js verify-sso-domain <provider ID>
//   docker compose run --rm --no-deps migrate node dist/identity-operator.js reset-second-factor <email>
// Check the domain, or the person, outside the product first. These commands check nothing themselves.
import { readSecret } from '@ensemus/config';
import { resetSecondFactor, verifySsoDomain } from '@ensemus/database/sso-operator';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('identity-operator');

async function main() {
  const [command, argument] = process.argv.slice(2);
  const url = readSecret('DATABASE_URL_MIGRATOR');
  if (command === 'verify-sso-domain' && argument) {
    const outcome = await verifySsoDomain(url, { providerId: argument });
    process.stdout.write(`${outcome}\n`);
    process.exitCode = outcome === 'verified' ? 0 : 1;
    return;
  }
  if (command === 'reset-second-factor' && argument) {
    const outcome = await resetSecondFactor(url, { email: argument });
    process.stdout.write(`${outcome}\n`);
    process.exitCode = outcome === 'reset' ? 0 : 1;
    return;
  }
  process.stdout.write(
    'Usage: identity-operator verify-sso-domain <provider ID> | reset-second-factor <email>\n',
  );
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  log.error('identity_operator.failed', { errorCode: errorCode(error) });
  process.exitCode = 1;
});
