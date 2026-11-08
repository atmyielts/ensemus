// The operator's commands (ADR-032 D3). There is deliberately no web path to any of this: running it means
// having a shell on the deployment and a role an operator chose to let log in.
//   node dist/ops.js <area> <command> [--options]
// Each area is in its own file, owned by one slice, and answers with an exit status: 0 done, 1 left to do,
// 2 refused. Output is IDs, counts and codes, with no name, address or amount of anyone's.
import { createLogger, errorCode } from '@ensemus/telemetry';
import { catalogCommand } from './ops-catalog';
import { deskCommand } from './ops-desk';
import { eraseCommand } from './ops-erase';
import { incidentCommand } from './ops-incident';
import { tenantCommand } from './ops-tenant';

const log = createLogger('ops');
const REFUSED = 2;

const AREAS: Readonly<Record<string, (args: string[]) => Promise<number>>> = {
  catalog: catalogCommand,
  tenant: tenantCommand,
  erase: eraseCommand,
  desk: deskCommand,
  incident: incidentCommand,
};

async function main() {
  const [area, ...rest] = process.argv.slice(2);
  const command = area && Object.hasOwn(AREAS, area) ? AREAS[area] : undefined;
  if (!command) {
    log.error('ops.refused', { reasonCode: 'NOT_AN_AREA' });
    process.exitCode = REFUSED;
    return;
  }
  process.exitCode = await command(rest);
}

main().catch((error: unknown) => {
  log.error('ops.failed', { errorCode: errorCode(error) });
  process.exitCode = 1;
});
