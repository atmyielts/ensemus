// The operator's two identity commands (ADR-031 D8, D9). No tenant can do either of these for itself:
//   docker compose run --rm --no-deps migrate node dist/identity-operator.js inspect-sso-provider <provider ID>
//   docker compose run --rm --no-deps migrate node dist/identity-operator.js verify-sso-domain <provider ID> <reviewed SHA256>
//   docker compose run --rm --no-deps migrate node dist/identity-operator.js reset-second-factor <email>
// Check domain ownership/provider keys, or the person, outside the product first. The reviewed SHA256
// binds exactly the inspected provider configuration; it is never refreshed implicitly at verification.
import { readSecret } from '@ensemus/config';
import {
  inspectSsoProvider,
  resetSecondFactor,
  verifySsoDomain,
} from '@ensemus/database/sso-operator';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('identity-operator');

async function main() {
  const [command, argument, expectedSha256] = process.argv.slice(2);
  const url = readSecret('DATABASE_URL_MIGRATOR');
  if (command === 'inspect-sso-provider' && argument) {
    const result = await inspectSsoProvider(url, argument);
    process.stdout.write(`${result ? JSON.stringify(result, null, 2) : 'not_found'}\n`);
    process.exitCode = result ? 0 : 1;
    return;
  }
  if (command === 'verify-sso-domain' && argument && expectedSha256) {
    const outcome = await verifySsoDomain(url, { providerId: argument, expectedSha256 });
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
    'Usage: identity-operator inspect-sso-provider <provider ID> | verify-sso-domain <provider ID> <reviewed SHA256> | reset-second-factor <email>\n',
  );
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  log.error('identity_operator.failed', { errorCode: errorCode(error) });
  process.exitCode = 1;
});
