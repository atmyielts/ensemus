// What offboarding asks of M3 and M7 before a tenant can be ready for erasure (LIFE-04, ADR-032 D9).
// Both run in the offboarding step's own service transaction, so the step's re-read after them sees what
// they did, and neither commits apart from it.
import {
  appendAudit,
  connections,
  webhookEndpoints,
  workUnits,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { processRuns } from '@ensemus/database/product';
import { connectionRef } from '@ensemus/domain/external-action';
import { AGGREGATE_CONNECTION, CONNECTION_REVOKED } from '@ensemus/domain/integration-events';
import { AGGREGATE_PROCESS_RUN, PROCESS_RUN_STOP_REQUESTED } from '@ensemus/domain/product-events';
import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { AppError } from '../errors';
import { emit } from '../events';
import type { OffboardingPorts } from './ports';

const PAGE = 100;
const OFFBOARDING_REASON = 'TENANT_OFFBOARDING';

const requireService = (context: TenantContext) => {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
};

/**
 * Revokes every connection the tenant still has, the organization's and each member's own (suite
 * connections, ADR-038, are rows here too), exactly as `revokeConnection` and `revokeMyConnection` do:
 * the row moves to `revoked` with its version moved on by one, its callback addresses close in the same
 * transaction, and `connection.revoked` is emitted, so the connector worker's existing revoke run deletes
 * the sealed credential and the endpoints' signing secrets through the broker. Nothing here reads a secret.
 *
 * The database decides whether a service may do this: the connection guard admits a service revoke only
 * for a tenant whose offboarding is at this step (0700, FLAGGED FOR HUMAN SECURITY REVIEW). Anything it
 * refuses throws, and the step does not move on.
 */
export function createOffboardingConnectionsPort(): NonNullable<OffboardingPorts['connections']> {
  return {
    async revokeAllInTx(tx: Tx, context: TenantContext) {
      requireService(context);
      let after: string | null = null;
      for (;;) {
        const page: { id: string; version: number }[] = await tx
          .select({ id: connections.id, version: connections.version })
          .from(connections)
          .where(
            and(
              eq(connections.organizationId, context.organizationId),
              ne(connections.state, 'revoked'),
              ...(after ? [gt(connections.id, after)] : []),
            ),
          )
          .orderBy(asc(connections.id))
          .limit(PAGE)
          .for('update');
        for (const row of page) {
          const version = row.version + 1;
          const [moved] = await tx
            .update(connections)
            .set({ state: 'revoked', revokedAt: sql`now()`, updatedAt: sql`now()`, version })
            .where(
              and(
                eq(connections.organizationId, context.organizationId),
                eq(connections.id, row.id),
                eq(connections.version, row.version),
                ne(connections.state, 'revoked'),
              ),
            )
            .returning({ id: connections.id });
          if (!moved) throw new AppError('VERSION_CONFLICT');
          await tx
            .update(webhookEndpoints)
            .set({ state: 'revoked', updatedAt: sql`now()` })
            .where(
              and(
                eq(webhookEndpoints.organizationId, context.organizationId),
                eq(webhookEndpoints.connectionId, row.id),
                ne(webhookEndpoints.state, 'revoked'),
              ),
            );
          await emit(tx, context, {
            eventType: CONNECTION_REVOKED,
            aggregateType: AGGREGATE_CONNECTION,
            aggregateId: row.id,
            aggregateVersion: version,
            classification: 'internal',
            payload: { connectionId: row.id },
          });
          await appendAudit(tx, {
            organizationId: context.organizationId,
            actorType: 'service',
            action: 'connection.revoked',
            targetRef: connectionRef(row.id),
            decision: 'allow',
            safeReason: OFFBOARDING_REASON,
          });
        }
        const last = page.at(-1);
        if (page.length < PAGE || !last) return;
        after = last.id;
      }
    },
  };
}

/**
 * M7's automations: asks every live process run to stop, as a person's stop does, so its workflow ends at
 * its next step rather than starting another. The guard on `studio.process_runs` lets a service set the
 * stop on a running or waiting run without changing its status or version (0418). A queued run has no
 * workflow yet; the work it would act on is cancelled by the offboarding step that follows, and its
 * recheck then refuses to start. The event wakes the run's workflow through the dispatcher.
 */
export function createProcessRunWindDown(): OffboardingPorts['windDowns'][number] {
  return async (tx: Tx, context: TenantContext) => {
    requireService(context);
    const live = await tx
      .select({
        id: processRuns.id,
        version: processRuns.version,
        classification: workUnits.classification,
      })
      .from(processRuns)
      .innerJoin(
        workUnits,
        and(
          eq(workUnits.organizationId, processRuns.organizationId),
          eq(workUnits.id, processRuns.rootWorkUnitId),
        ),
      )
      .where(
        and(
          eq(processRuns.organizationId, context.organizationId),
          inArray(processRuns.status, ['running', 'waiting']),
          isNull(processRuns.stopCode),
        ),
      )
      .orderBy(asc(processRuns.id))
      .for('update', { of: processRuns });
    for (const run of live) {
      await tx
        .update(processRuns)
        .set({ stopCode: 'STOP_REQUESTED', updatedAt: new Date() })
        .where(
          and(eq(processRuns.organizationId, context.organizationId), eq(processRuns.id, run.id)),
        );
      await emit(tx, context, {
        eventType: PROCESS_RUN_STOP_REQUESTED,
        aggregateType: AGGREGATE_PROCESS_RUN,
        aggregateId: run.id,
        aggregateVersion: run.version,
        classification: run.classification,
        payload: { process_run_id: run.id },
      });
    }
  };
}
