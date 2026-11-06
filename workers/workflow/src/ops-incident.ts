import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readSecret } from '@ensemus/config';
import { openOperatorDatabase } from '@ensemus/database/operator';
import {
  incidentCommandInputSchemas,
  openIncident,
  assignIncidentRoles,
  updateIncident,
  resolveIncident,
  recordDrill,
  recordVulnerabilityReport,
  moveVulnerabilityReport,
} from '@ensemus/application/saas/operator-incidents';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('incident-command');
export { incidentCommandInputSchemas };
export async function incidentCommand(args: string[]): Promise<number> {
  let command: keyof typeof incidentCommandInputSchemas, data: unknown;
  try {
    const [name, ...flags] = args;
    if (!name || !Object.hasOwn(incidentCommandInputSchemas, name))
      throw new Error('INVALID_COMMAND');
    command = name as keyof typeof incidentCommandInputSchemas;
    const { values } = parseArgs({
      args: flags,
      strict: true,
      allowPositionals: false,
      options: { file: { type: 'string', multiple: true } },
    });
    if (values.file?.length !== 1 || !values.file[0]) throw new Error('INVALID_INPUT');
    const file = values.file[0],
      stat = statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024)
      throw new Error('INVALID_INPUT');
    const text = readFileSync(file, 'utf8');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('INVALID_INPUT');
    data = JSON.parse(text);
    incidentCommandInputSchemas[command].parse(data);
  } catch {
    log.error('incident.refused', { reasonCode: 'INVALID_COMMAND_OR_CONFIGURATION' });
    return 2;
  }
  let database: ReturnType<typeof openOperatorDatabase> | undefined;
  try {
    database = openOperatorDatabase(readSecret('DATABASE_URL_OPERATOR'));
    if (command === 'open') {
      const result = await openIncident(database.db, incidentCommandInputSchemas.open.parse(data));
      log.info('incident.opened', { tableRef: `incident:${result.incidentId}` });
    } else if (command === 'roles') {
      const value = incidentCommandInputSchemas.roles.parse(data);
      await assignIncidentRoles(database.db, {
        operatorRef: value.operatorRef,
        incidentId: value.incidentId,
        ...(value.securityLeadRef ? { securityLeadRef: value.securityLeadRef } : {}),
        ...(value.infrastructureLeadRef
          ? { infrastructureLeadRef: value.infrastructureLeadRef }
          : {}),
        ...(value.communicationsRef ? { communicationsRef: value.communicationsRef } : {}),
        ...(value.legalRef ? { legalRef: value.legalRef } : {}),
      });
    } else if (command === 'update') {
      const value = incidentCommandInputSchemas.update.parse(data);
      await updateIncident(database.db, {
        incidentId: value.incidentId,
        state: value.state,
        publicMessage: value.publicMessage,
        authorRef: value.authorRef,
        publish: value.publish,
        ...(value.origin ? { origin: value.origin } : {}),
      });
    } else if (command === 'resolve')
      await resolveIncident(database.db, incidentCommandInputSchemas.resolve.parse(data));
    else if (command === 'drill') {
      const result = await recordDrill(database.db, incidentCommandInputSchemas.drill.parse(data));
      log.info('incident.drill_recorded', { tableRef: `drill:${result.drillId}` });
    } else if (command === 'vulnerability') {
      const result = await recordVulnerabilityReport(
        database.db,
        incidentCommandInputSchemas.vulnerability.parse(data),
      );
      log.info('incident.vulnerability_recorded', { tableRef: `vulnerability:${result.reportId}` });
    } else {
      const value = incidentCommandInputSchemas.move.parse(data);
      await moveVulnerabilityReport(database.db, {
        operatorRef: value.operatorRef,
        reportId: value.reportId,
        state: value.state,
        expectedVersion: value.expectedVersion,
        ...(value.severity ? { severity: value.severity } : {}),
        ...(value.fixedInRef ? { fixedInRef: value.fixedInRef } : {}),
      });
    }
    log.info('incident.command_completed', { reasonCode: command.toUpperCase() });
    return 0;
  } catch (error) {
    log.error('incident.failed', { errorCode: errorCode(error) });
    return 2;
  } finally {
    await database?.close();
  }
}
