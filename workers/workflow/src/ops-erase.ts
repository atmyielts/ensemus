// Owned by the offboarding slice (LIFE-04). The last step of offboarding, which cannot be undone. `DATABASE_URL_APP`
// and `DATABASE_URL_ERASER`, and the role behind that second one cannot log in until an operator lets it.
// See docs/06-delivery/m8-slices.md and ADR-032 D7.
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AppError, type ObjectStore } from '@ensemus/application';
import {
  beginErasure,
  finishErasure,
  inspectErasure,
  resumeOffboarding,
  setTransitionEnd,
  eraseCommandInputSchemas,
  type EraseCommandInput,
} from '@ensemus/application/saas/offboarding';
import type { OffboardingAgentHaltPort } from '@ensemus/application/saas/ports';
import { createOffboardingAgentHaltPort } from '@ensemus/application/saas/offboarding-agent-port';
import {
  createTenantObjectErasure,
  type ErasureObjectStore,
} from '@ensemus/application/saas/tenant-object-erasure';
import { readSecret } from '@ensemus/config';
import { openAppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eraseTenantRows, listErasableTables, openEraserDatabase } from '@ensemus/database/eraser';
import { S3ObjectStore } from '@ensemus/storage';
import { createLogger, errorCode } from '@ensemus/telemetry';

const log = createLogger('erase-command');
export { eraseCommandInputSchemas };
export type EraseCommandBindings = { agents?: OffboardingAgentHaltPort; store?: ObjectStore };
export async function eraseCommand(
  args: string[],
  bindings: EraseCommandBindings = {},
): Promise<number> {
  let command: 'run' | 'transition' | 'resume',
    input: EraseCommandInput & { transitionEndsAt?: string },
    reportFile: string | undefined;
  try {
    const [name, ...flags] = args;
    if (name !== 'run' && name !== 'transition' && name !== 'resume')
      throw new Error('INVALID_COMMAND');
    command = name;
    const { values } = parseArgs({
      args: flags,
      strict: true,
      allowPositionals: false,
      options: {
        file: { type: 'string', multiple: true },
        'report-file': { type: 'string', multiple: true },
      },
    });
    if (
      values.file?.length !== 1 ||
      !values.file[0] ||
      (values['report-file'] && values['report-file'].length !== 1)
    )
      throw new Error('INVALID_INPUT');
    const stat = statSync(values.file[0]);
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024)
      throw new Error('INVALID_INPUT');
    const wire = readFileSync(values.file[0], 'utf8');
    if (Buffer.byteLength(wire) > 1024 * 1024) throw new Error('INVALID_INPUT');
    input = eraseCommandInputSchemas[command].parse(JSON.parse(wire));
    reportFile = values['report-file']?.[0];
    if (command === 'run' && !reportFile) throw new Error('PREREQUISITES_INCOMPLETE');
    if (command !== 'run' && reportFile) throw new Error('INVALID_INPUT');
  } catch {
    log.error('erasure.refused', { reasonCode: 'INVALID_COMMAND_OR_CONFIGURATION' });
    return 2;
  }
  let app: ReturnType<typeof openAppDatabase> | undefined,
    eraser: ReturnType<typeof openEraserDatabase> | undefined,
    reportDescriptor: number | undefined;
  let reportWritten = false;
  const writeReport = (report: unknown) => {
    if (reportDescriptor === undefined) throw new Error('ERASURE_REPORT_NOT_OPEN');
    writeFileSync(reportDescriptor, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fsyncSync(reportDescriptor);
    reportWritten = true;
  };
  try {
    // Reserve the private evidence path before touching the database or making erasure irreversible.
    // An existing/unwritable path must not be discovered after deleting tenant rows.
    if (command === 'run') reportDescriptor = openSync(reportFile!, 'wx', 0o600);
    app = openAppDatabase(readSecret('DATABASE_URL_APP'));
    const context = createServiceContext(input.organizationId);
    if (command === 'transition') {
      await setTransitionEnd(app.db, context, {
        offboardingId: input.offboardingId,
        operatorRef: input.operatorRef,
        transitionEndsAt: new Date(input.transitionEndsAt!),
      });
      log.info('erasure.transition_set', { organizationId: input.organizationId });
      return 0;
    }
    if (command === 'resume') {
      await resumeOffboarding(app.db, context, input);
      log.info('erasure.resumed', { organizationId: input.organizationId });
      return 0;
    }
    // Verify the restricted role connects before marking the request irreversible.
    eraser = openEraserDatabase(readSecret('DATABASE_URL_ERASER'));
    await listErasableTables(eraser.db);
    const store =
      bindings.store ??
      new S3ObjectStore({
        endpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? 'http://objects:8333',
        bucket: process.env.OBJECT_STORAGE_BUCKET ?? 'ensemus',
        accessKey: readSecret('OBJECT_STORAGE_ACCESS_KEY'),
        secretKey: readSecret('OBJECT_STORAGE_SECRET_KEY'),
      });
    if (!('listPages' in store) || typeof store.listPages !== 'function')
      throw new AppError('PREREQUISITES_INCOMPLETE');
    const objectErasure = createTenantObjectErasure({
      database: app.db,
      store: store as ErasureObjectStore,
    });
    const agents = bindings.agents ?? createOffboardingAgentHaltPort();
    const prior = await inspectErasure(app.db, context, input);
    if (prior.state === 'reported') {
      const checked = await finishErasure(
        app.db,
        context,
        { ...input, tables: [], blobsRemoved: 0 },
        agents,
        objectErasure,
      );
      writeReport(checked.report);
      log.info('erasure.reported', { organizationId: input.organizationId });
      return 0;
    }
    for (;;) {
      const page = await beginErasure(app.db, context, input);
      if (!page.more) break;
    }
    let pending = await inspectErasure(app.db, context, input);
    if (pending.activeHolds) throw new AppError('LEGAL_HOLD_ACTIVE');
    if (pending.ledgerPending || pending.unsettledActions) {
      writeReport({
        state: 'pending',
        reasonCode: pending.ledgerPending ? 'TOMBSTONE_LEDGER_PENDING' : 'UNSETTLED_ACTIONS',
        count: pending.ledgerPending + pending.unsettledActions,
      });
      log.warn('erasure.pending', {
        organizationId: input.organizationId,
        reasonCode: pending.ledgerPending ? 'TOMBSTONE_LEDGER_PENDING' : 'UNSETTLED_ACTIONS',
        count: pending.ledgerPending + pending.unsettledActions,
      });
      return 1;
    }
    let blobsRemoved = 0;
    for (let page = 0; page < 20; page++) {
      const purge = await objectErasure.purge(context, { ...input, limit: 25 });
      blobsRemoved += purge.files.purged;
      if (
        !purge.files.purged ||
        purge.files.failed ||
        purge.unconfirmedDeletes ||
        purge.archives.held
      )
        break;
    }
    pending = await inspectErasure(app.db, context, input);
    if (pending.activeHolds) throw new AppError('LEGAL_HOLD_ACTIVE');
    const physical = await objectErasure.confirm(context, input);
    if (pending.blobsPending || !physical.confirmed) {
      writeReport({
        state: 'pending',
        reasonCode: 'BLOB_PURGE_PENDING',
        count: pending.blobsPending + physical.objectsRemaining,
      });
      log.warn('erasure.pending', {
        organizationId: input.organizationId,
        reasonCode: 'BLOB_PURGE_PENDING',
        count: pending.blobsPending + physical.objectsRemaining,
      });
      return 1;
    }
    const tables = await eraseTenantRows(eraser.db, input.organizationId),
      finished = await finishErasure(
        app.db,
        context,
        { ...input, tables, blobsRemoved },
        agents,
        objectErasure,
      );
    writeReport(finished.report);
    log.info('erasure.checked', {
      organizationId: input.organizationId,
      count: finished.report?.rowsRemoved ?? 0,
      reasonCode: finished.state === 'reported' ? 'VERIFIED' : 'LEFT_OVER',
    });
    return finished.state === 'reported' ? 0 : 1;
  } catch (error) {
    if (reportDescriptor !== undefined && !reportWritten) {
      try {
        writeReport({ state: 'failed', errorCode: errorCode(error) });
      } catch {
        /* The retained database report remains authoritative if the local device fails. */
      }
    }
    log.error('erasure.failed', { errorCode: errorCode(error) });
    return 2;
  } finally {
    if (reportDescriptor !== undefined) closeSync(reportDescriptor);
    await app?.close();
    await eraser?.close();
  }
}
