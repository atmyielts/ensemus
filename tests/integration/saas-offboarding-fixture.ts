import { nativeSovereignContext } from '../helpers/sovereign';
import {
  advanceOffboarding,
  getOffboarding,
  requestOffboarding,
  setTransitionEnd,
} from '@ensemus/application/saas/offboarding';
import type { OffboardingPorts } from '@ensemus/application/saas/ports';
import { createServiceContext } from '@ensemus/database/service';
import {
  domainEvents,
  getOrganization,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { withAccountTx } from '@ensemus/database/account';
import { TOMBSTONE_RECORDED } from '@ensemus/domain/tombstone-ledger';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { createLedgerWriter } from '../../workers/workflow/src/tombstone-ledger';
import { urls } from '../helpers/stack';
import type { LifecycleMemoryStore } from './saas-lifecycle-fixture';
export function offboardingPorts(): OffboardingPorts {
  return {
    agents: {
      haltTenantAgents: async () => {
        throw new Error('TEST_BROAD_HALT_FORBIDDEN');
      },
      releaseTenantAgents: async () => {
        throw new Error('TEST_BROAD_RELEASE_FORBIDDEN');
      },
    },
    offboardingAgents: {
      haltOffboardingAgents: async () => undefined,
      releaseOffboardingAgents: async () => undefined,
    },
    exports: { latestExport: async () => null },
    windDowns: [],
  };
}
export async function readyToErase(
  database: AppDatabase,
  owner: TenantContext,
  ports = offboardingPorts(),
) {
  owner = await nativeSovereignContext(database, owner.userId, owner.organizationId);
  const organization = await getOrganization(database, owner);
  if (!organization) throw new Error('TEST_ORGANIZATION_MISSING');
  const service = createServiceContext(owner.organizationId),
    input = await requestOffboarding(
      database,
      owner,
      { confirmName: organization.name },
      ports.offboardingAgents,
    );
  await advanceOffboarding(database, service, ports, {
    offboardingId: input.offboardingId,
    now: new Date(),
  });
  await setTransitionEnd(database, service, {
    offboardingId: input.offboardingId,
    transitionEndsAt: new Date(Date.now() - 1000),
    operatorRef: 'test-operator@example.invalid',
  });
  for (let step = 0; step < 12; step++) {
    const view = await getOffboarding(database, owner);
    if (view?.state === 'ready_for_erasure') return { ...input, service, ports };
    await advanceOffboarding(database, service, ports, {
      offboardingId: input.offboardingId,
      now: new Date(),
    });
  }
  throw new Error('TEST_OFFBOARDING_DID_NOT_ADVANCE');
}

/** Runs the real ledger writer, then records only these delivered fixtures through the dispatcher role. */
export async function publishErasureLedger(
  database: AppDatabase,
  context: TenantContext,
  store: LifecycleMemoryStore,
) {
  const events = await withAccountTx(database, context, (tx) =>
      tx.select().from(domainEvents).where(eq(domainEvents.eventType, TOMBSTONE_RECORDED)),
    ),
    writer = createLedgerWriter(store),
    dispatcher = new pg.Client({ connectionString: urls.dispatcher() });
  await dispatcher.connect();
  try {
    for (const event of events) {
      await writer({
        organizationId: context.organizationId,
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        occurredAt: event.occurredAt,
        attempts: 0,
      });
      await dispatcher.query(
        "update platform.outbox_events set state='published' where organization_id=$1 and event_id=$2",
        [context.organizationId, event.id],
      );
    }
  } finally {
    await dispatcher.end();
  }
}
