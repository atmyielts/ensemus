// Trusted operator command. Dependencies are supplied by the composition root; absent ports refuse.
// node dist/ops.js tenant <provision|suspend|resume> --file <JSON> [--invitation-file <private file>]
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { parseArgs } from 'node:util';
import { AppError } from '@ensemus/application';
import {
  provisionTenant,
  setTenantStandingInTx,
  tenantCommandInputSchemas,
  type TenantProvisioningPort,
} from '@ensemus/application/saas/standing';
import type { AgentHaltPort } from '@ensemus/application/saas/ports';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { readSecret } from '@ensemus/config';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('tenant-command');
export async function tenantCommand(
  args: string[],
  bindings: { agents?: AgentHaltPort; provisioner?: TenantProvisioningPort } = {},
): Promise<number> {
  const agents = bindings.agents ?? createStandingAgentHaltPort();
  let parsed:
    | { command: 'provision'; input: Parameters<typeof provisionTenant>[1]; invitationFile: string }
    | {
        command: 'suspend' | 'resume';
        input: { organizationId: string; operatorRef: string; reasonCode: string };
      };
  try {
    const [command, ...flags] = args;
    if (command !== 'provision' && command !== 'suspend' && command !== 'resume')
      throw new Error('INVALID_COMMAND');
    const { values } = parseArgs({
      args: flags,
      strict: true,
      allowPositionals: false,
      options: {
        file: { type: 'string', multiple: true },
        'invitation-file': { type: 'string', multiple: true },
      },
    });
    if (values.file?.length !== 1 || !values.file[0]) throw new Error('INVALID_INPUT');
    const stat = statSync(values.file[0]);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024)
      throw new Error('INVALID_INPUT');
    const wire = readFileSync(values.file[0], 'utf8');
    if (Buffer.byteLength(wire) > 1024 * 1024) throw new Error('INVALID_INPUT');
    const data: unknown = JSON.parse(wire);
    if (command === 'provision') {
      if (
        values['invitation-file']?.length !== 1 ||
        !values['invitation-file'][0] ||
        !bindings.provisioner
      )
        throw new Error('PREREQUISITES_INCOMPLETE');
      parsed = {
        command,
        input: tenantCommandInputSchemas.provision.parse(data),
        invitationFile: values['invitation-file'][0],
      };
    } else {
      if (values['invitation-file']) throw new Error('PREREQUISITES_INCOMPLETE');
      parsed = { command, input: tenantCommandInputSchemas.standing.parse(data) };
    }
  } catch {
    log.error('tenant.refused', { reasonCode: 'INVALID_COMMAND_OR_CONFIGURATION' });
    return 2;
  }
  let database: ReturnType<typeof openAppDatabase> | undefined;
  let file: number | undefined;
  let completed = false;
  try {
    const url = readSecret('DATABASE_URL_APP');
    if (parsed.command === 'provision') file = openSync(parsed.invitationFile, 'wx', 0o600);
    database = openAppDatabase(url);
    if (parsed.command === 'provision') {
      const result = await provisionTenant(
        database.db,
        parsed.input,
        bindings.provisioner,
        async (invitation) => {
          writeFileSync(file!, JSON.stringify(invitation) + '\n', 'utf8');
          fsyncSync(file!);
        },
      );
      completed = true;
      log.info('tenant.provisioned', { organizationId: result.organizationId });
    } else {
      const context = createServiceContext(parsed.input.organizationId);
      const standing = parsed;
      await withTenantTx(database.db, context, (tx) =>
        setTenantStandingInTx(
          tx,
          context,
          {
            to: standing.command === 'suspend' ? 'suspended' : 'active',
            reasonCode: standing.input.reasonCode,
            actor: { type: 'operator', ref: standing.input.operatorRef },
          },
          agents,
        ),
      );
      log.info('tenant.standing_changed', { organizationId: context.organizationId });
    }
    return 0;
  } catch (error) {
    log.error('tenant.failed', { errorCode: errorCode(error) });
    return !database || error instanceof AppError ? 2 : 1;
  } finally {
    if (file !== undefined) closeSync(file);
    if (file !== undefined && !completed && parsed.command === 'provision') {
      try {
        unlinkSync(parsed.invitationFile);
      } catch {
        log.error('tenant.invitation_cleanup_failed', { reasonCode: 'PRIVATE_OUTPUT_UNAVAILABLE' });
      }
    }
    await database?.close();
  }
}
