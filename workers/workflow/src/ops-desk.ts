// Owned by the support slice (OPS-22, OPS-24). `DATABASE_URL_SUPPORT` for the desk, and `DATABASE_URL_OPERATOR` for
// an operator's signature on a break-glass request. See docs/06-delivery/m8-slices.md and ADR-032 D8.
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadSaasConfig, readSecret } from '@ensemus/config';
import { openSupportDatabase } from '@ensemus/database/support';
import { openOperatorDatabase } from '@ensemus/database/operator';
import {
  getDeskTicket,
  deskCommandInputSchemas,
  draftSupportCoverage,
  approveSupportCoverage,
  retireSupportCoverage,
  listDeskQueue,
  replyAsDesk,
  requestBreakGlass,
  SupportContentBusy,
} from '@ensemus/application/saas/support-desk';
import { authorizeBreakGlassAsOperator } from '@ensemus/application/saas/break-glass';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('desk-command');
export { deskCommandInputSchemas };
export async function deskCommand(args: string[]): Promise<number> {
  let command: keyof typeof deskCommandInputSchemas, data: unknown, output: string | undefined;
  try {
    const [name, ...flags] = args;
    if (!name || !Object.hasOwn(deskCommandInputSchemas, name)) throw new Error('INVALID_COMMAND');
    command = name as keyof typeof deskCommandInputSchemas;
    const { values } = parseArgs({
      args: flags,
      strict: true,
      allowPositionals: false,
      options: {
        file: { type: 'string', multiple: true },
        'output-file': { type: 'string', multiple: true },
      },
    });
    if (
      values.file?.length !== 1 ||
      !values.file[0] ||
      (values['output-file'] && values['output-file'].length !== 1)
    )
      throw new Error('INVALID_INPUT');
    const stat = statSync(values.file[0]);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024)
      throw new Error('INVALID_INPUT');
    const wire = readFileSync(values.file[0], 'utf8');
    if (Buffer.byteLength(wire) > 1024 * 1024) throw new Error('INVALID_INPUT');
    data = JSON.parse(wire);
    deskCommandInputSchemas[command].parse(data);
    output = values['output-file']?.[0];
    if ((command === 'show') !== Boolean(output)) throw new Error('INVALID_INPUT');
  } catch {
    log.error('desk.refused', { reasonCode: 'INVALID_COMMAND_OR_CONFIGURATION' });
    return 2;
  }
  let support: ReturnType<typeof openSupportDatabase> | undefined,
    operator: ReturnType<typeof openOperatorDatabase> | undefined;
  try {
    if (command === 'queue' || command === 'show' || command === 'reply' || command === 'request') {
      support = openSupportDatabase(readSecret('DATABASE_URL_SUPPORT'));
      if (command === 'queue') {
        const value = deskCommandInputSchemas.queue.parse(data);
        const rows = await listDeskQueue(support.db, {
          limit: value.limit,
          ...(value.status ? { status: value.status } : {}),
        });
        for (const row of rows)
          log.info('desk.queue_item', {
            organizationId: row.organizationId,
            tableRef: `ticket:${row.ticketId}`,
            reasonCode: row.status.toUpperCase(),
          });
        return 0;
      }
      if (command === 'show') {
        const value = deskCommandInputSchemas.show.parse(data),
          record = await getDeskTicket(support.db, value),
          descriptor = openSync(output!, 'wx', 0o600);
        try {
          writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        log.info('desk.ticket_opened', {
          organizationId: value.organizationId,
          tableRef: `ticket:${value.ticketId}`,
        });
        return 0;
      }
      if (command === 'reply') {
        const value = deskCommandInputSchemas.reply.parse(data);
        await replyAsDesk(support.db, value);
        log.info('desk.replied', {
          organizationId: value.organizationId,
          tableRef: `ticket:${value.ticketId}`,
        });
        return 0;
      }
      const value = deskCommandInputSchemas.request.parse(data),
        result = await requestBreakGlass(support.db, value, loadSaasConfig().breakGlass);
      log.info('desk.access_requested', {
        organizationId: value.organizationId,
        tableRef: `break_glass:${result.requestId}`,
      });
      return 0;
    }
    operator = openOperatorDatabase(readSecret('DATABASE_URL_OPERATOR'));
    if (command === 'authorize') {
      const value = deskCommandInputSchemas.authorize.parse(data),
        result = await authorizeBreakGlassAsOperator(
          operator.db,
          value,
          loadSaasConfig().breakGlass,
          new Date(),
        );
      log.info('desk.operator_signed', {
        organizationId: value.organizationId,
        tableRef: `break_glass:${value.requestId}`,
        reasonCode: result.state.toUpperCase(),
      });
      return 0;
    }
    if (command === 'coverage-draft') {
      const value = deskCommandInputSchemas['coverage-draft'].parse(data);
      const result = await draftSupportCoverage(operator.db, value);
      log.info('desk.coverage_drafted', { tableRef: `coverage:${result.coverageId}` });
      return 0;
    }
    const value = deskCommandInputSchemas['coverage-approve'].parse(data);
    if (command === 'coverage-approve') await approveSupportCoverage(operator.db, value);
    else await retireSupportCoverage(operator.db, value);
    log.info('desk.coverage_changed', { tableRef: `coverage:${value.coverageId}` });
    return 0;
  } catch (error) {
    if (error instanceof SupportContentBusy) {
      log.warn('desk.busy', { reasonCode: error.code });
      return 1;
    }
    log.error('desk.failed', { errorCode: errorCode(error) });
    return 2;
  } finally {
    await support?.close();
    await operator?.close();
  }
}
