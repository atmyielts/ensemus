// Operator command for the marketplace (ADR-034 D6). All it does itself is open the connections, and
// marketplace-command.ts is the command. The only process that ever holds the ensemus_marketplace role, run
// by a person on the worker image, and never left running.
import { loadSkillWorkerConfig, readSecret } from '@ensemus/config';
import { openMarketplaceOperatorDatabase } from '@ensemus/database/marketplace-operator';
import { S3ObjectStore } from '@ensemus/storage';
import { errorCode } from '@ensemus/telemetry';
import { log, marketplaceCommand } from './marketplace-command';

async function main() {
  const { db, close } = openMarketplaceOperatorDatabase(readSecret('DATABASE_URL_MARKETPLACE'));
  const store = new S3ObjectStore({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
    bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
    accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
    secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
  });
  const code = await marketplaceCommand(process.argv.slice(2), {
    db,
    store,
    reviewKeys: loadSkillWorkerConfig().reviewKeys,
    print: (line) => process.stdout.write(`${line}\n`),
  });
  await close();
  process.exit(code);
}

main().catch((error: unknown) => {
  log.error('marketplace_operator.failed', { errorCode: errorCode(error) });
  process.exit(1);
});
