import { randomUUID } from 'node:crypto';
import {
  acceptGrantInvitation,
  confirmGrant,
  getGrant,
  noPlanGate,
  proposeGrant,
  setFederationEnabled,
  type ObjectStore,
} from '@ensemus/application';
import { openAppDatabase, withTenantTx, type TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { federationGrantTargetRef } from '@ensemus/domain/federation-events';
import { createActivities } from '@ensemus/workflows/activities';
import { federationGrantAcceptedWorkflowIdFor } from '@ensemus/workflows/schemas';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSaasPorts } from '../../workers/workflow/src/saas-ports';
import {
  client,
  clearDeploymentProfile,
  seedGrant,
  setDeploymentProfile,
} from '../helpers/federation';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
import { WORKFLOWS } from '../replay/corpus';

describe('collaboration grant worker lifecycle', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let worker: ReturnType<typeof openAppDatabase>;
  let sql: Awaited<ReturnType<typeof client>>;
  const rejectStorage = () => Promise.reject(new Error('UNEXPECTED_STORAGE_ACCESS'));
  const store = {
    put: rejectStorage,
    get: rejectStorage,
    delete: rejectStorage,
    exists: rejectStorage,
  } satisfies ObjectStore;
  const activities = () => createActivities({ database: worker.db, store });
  const proposal = {
    purpose: 'document_review',
    maxClassification: 'internal',
    expiresInDays: 10,
    invitationExpiresInDays: 2,
    note: 'Generated review scope',
  } as const;

  async function readyParties() {
    const pair = await makeTwoTenants(app.db);
    for (const { owner } of [pair.a, pair.b]) {
      await proveSecondFactor(owner);
      await setFederationEnabled(
        app.db,
        owner.context,
        {
          enabled: true,
          expectedVersion: 0,
        },
        noPlanGate,
      );
    }
    return pair;
  }

  async function accepted(sharing: TenantContext, receiving: TenantContext) {
    const { grant, token } = await proposeGrant(app.db, sharing, proposal);
    return acceptGrantInvitation(app.db, receiving, { token, termsHash: grant.termsHash });
  }

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    worker = openAppDatabase(urls.worker());
    sql = await client(urls.superuser());
  });
  beforeEach(() => setDeploymentProfile({ crossOrgEnabled: true }));
  afterEach(clearDeploymentProfile);
  afterAll(async () => {
    await Promise.all([app.close(), worker.close(), sql.end()]);
  });

  it('notifies the sharing owner once even if the worker retries concurrently', async () => {
    const pair = await readyParties();
    const sharing = pair.a.owner.context;
    const receiving = pair.b.owner.context;
    const grant = await accepted(sharing, receiving);
    const notify = activities().notifyFederationGrantAccepted;
    const outsider = (await makeTwoTenants(app.db)).a.owner.context.organizationId;
    await expect(notify({ organizationId: outsider, grantId: grant.id })).resolves.toBe(0);
    await expect(
      notify({ organizationId: sharing.organizationId, grantId: grant.id }),
    ).resolves.toBe(0);

    const input = { organizationId: receiving.organizationId, grantId: grant.id };
    expect((await Promise.all([notify(input), notify(input)])).sort()).toEqual([0, 1]);
    await expect(notify(input)).resolves.toBe(0);

    const { rows } = await sql.query(
      'select organization_id, recipient_membership_id, kind from platform.notifications where target_ref=$1',
      [federationGrantTargetRef(grant.id)],
    );
    expect(rows).toEqual([
      {
        organization_id: sharing.organizationId,
        recipient_membership_id: sharing.membershipId,
        kind: 'federation.grant_accepted',
      },
    ]);
  });

  it('discards delayed notices once the sharing owner has already confirmed', async () => {
    const pair = await readyParties();
    const sharing = pair.a.owner.context;
    const receiving = pair.b.owner.context;
    const grant = await accepted(sharing, receiving);
    await confirmGrant(app.db, sharing, {
      grantId: grant.id,
      termsHash: grant.termsHash,
      expectedVersion: grant.version,
    });
    await expect(
      activities().notifyFederationGrantAccepted({
        organizationId: receiving.organizationId,
        grantId: grant.id,
      }),
    ).resolves.toBe(0);
    expect(
      (
        await sql.query('select id from platform.notifications where target_ref=$1', [
          federationGrantTargetRef(grant.id),
        ])
      ).rows,
    ).toEqual([]);
  });

  it('ends expired grants during scheduled upkeep and closes remaining grants during offboarding', async () => {
    const pair = await readyParties();
    const sharing = pair.a.owner.context;
    const receiving = pair.b.owner.context;
    const context = createServiceContext(sharing.organizationId);
    const expiry = Date.now() + 2_000;
    const due = await seedGrant(app.db, sharing, receiving, {
      status: 'proposed',
      expiresAt: new Date(expiry),
    });
    const live = await accepted(sharing, receiving);
    await new Promise((resolve) => setTimeout(resolve, Math.max(expiry - Date.now(), 0) + 100));
    await activities().sendReminders({ organizationId: sharing.organizationId });
    await expect(getGrant(app.db, sharing, due.id)).resolves.toMatchObject({
      status: 'ended',
      endReason: 'expired',
    });
    await expect(getGrant(app.db, receiving, live.id)).resolves.toMatchObject({
      status: 'accepted',
    });

    const { windDowns } = createSaasPorts(store).offboarding;
    await withTenantTx(worker.db, context, async (tx) => {
      for (const windDown of windDowns) await windDown(tx, context);
    });
    await expect(getGrant(app.db, receiving, live.id)).resolves.toMatchObject({
      status: 'ended',
      endReason: 'disabled',
    });
    await activities().sendReminders({ organizationId: sharing.organizationId });
    const { rows } = await sql.query(
      "select payload->>'reason' as reason from platform.domain_events where organization_id=$1 and event_type='federation.grant_ended' order by payload->>'reason'",
      [sharing.organizationId],
    );
    expect(rows).toEqual([{ reason: 'disabled' }, { reason: 'expired' }]);
  });

  it.runIf(process.env.ENSEMUS_TEST_FEDERATION_TEMPORAL === '127.0.0.1:57432')(
    'delivers the acceptance through a live Temporal worker on an isolated queue',
    async () => {
      const pair = await readyParties();
      const sharing = pair.a.owner.context;
      const receiving = pair.b.owner.context;
      const grant = await accepted(sharing, receiving);
      const address = '127.0.0.1:57432';
      const connection = await Connection.connect({ address, connectTimeout: '5 seconds' });
      try {
        const native = await NativeConnection.connect({ address });
        try {
          const taskQueue = 'federation-qualification-' + randomUUID();
          const runner = await Worker.create({
            connection: native,
            taskQueue,
            workflowsPath: WORKFLOWS,
            activities: {
              notifyFederationGrantAccepted: activities().notifyFederationGrantAccepted,
            },
          });
          const { workflow } = new Client({ connection });
          const input = { organizationId: receiving.organizationId, grantId: grant.id };
          const executed = await runner.runUntil(async () => {
            const handle = await workflow.start('federationGrantAcceptedWorkflow', {
              args: [input],
              workflowId: federationGrantAcceptedWorkflowIdFor(input),
              taskQueue,
              workflowExecutionTimeout: '30 seconds',
            });
            await handle.result();
            return handle.fetchHistory();
          });
          expect(
            executed.events?.some((event) => event.activityTaskCompletedEventAttributes != null),
          ).toBe(true);
          const { rows } = await sql.query(
            'select recipient_membership_id from platform.notifications where organization_id=$1 and target_ref=$2',
            [sharing.organizationId, federationGrantTargetRef(grant.id)],
          );
          expect(rows).toEqual([{ recipient_membership_id: sharing.membershipId }]);
        } finally {
          await native.close();
        }
      } finally {
        await connection.close();
      }
    },
  );
});
