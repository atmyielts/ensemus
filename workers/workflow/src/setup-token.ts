// The operator's command for a first owner where sign-up is off (ID-01). Run it once per person:
//   docker compose run --rm --no-deps migrate node dist/setup-token.js
// The code goes to this terminal and nowhere else. It is never logged, and only its hash is stored.
import { readSecret } from '@ensemus/config';
import { issueSetupToken } from '@ensemus/database/setup-token';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('setup-token');

async function main() {
  const { token, expiresAt } = await issueSetupToken(readSecret('DATABASE_URL_MIGRATOR'));
  process.stdout.write(
    [
      `Setup code, for one new account, until ${expiresAt.toISOString()}:`,
      '',
      token,
      '',
      'Give it to the person setting up, by a private route. They open /setup on this deployment and',
      'enter it there with their name, email and a password. This code is not stored and cannot be',
      'shown again. Run this command again if it is lost or runs out.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  log.error('setup_token.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
