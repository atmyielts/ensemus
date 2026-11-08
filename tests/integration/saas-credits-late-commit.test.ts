// Exact reconciliation over synthetic accepted M4 ledger rows, not proof of a paid/provider model call.
// Uses actual app/agent logins and real run/input fixtures; commits deliberately arrive out of order.
import { randomUUID } from 'node:crypto';
import { createWorkUnit } from '@ensemus/application';
import { consumeUsage } from '@ensemus/application/saas/credits';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { createAgentContext } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { seedPlan, seedRateCard } from '../helpers/saas';
import { urls } from '../helpers/stack';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
} from '../helpers/ai/fixtures';
import { createSaasPorts } from '../../workers/workflow/src/saas-ports';

describe('exact late-commit credit reconciliation through the runtime usage port', () => {
  it('consumes the newer commit, then the older commit exactly once', async () => {
    const app = openAppDatabase(urls.app()),
      agent = openAgentTestDatabase(2);
    let releaseOlder: (() => void) | undefined;
    let older: Promise<void> | undefined;
    try {
      const tenant = await seedAiTenant(app.db, { commercialMode: 'cloud' });
      const owner = tenant.owner,
        organizationId = tenant.organizationId;
      const service = createServiceContext(organizationId);
      const card = await seedRateCard({ meter: 'model_input_tokens' });
      await startSubscription(app.db, owner, await seedPlan({ mode: 'cloud', rateCard: card }));
      const version = await seedAgentVersion(app.db, owner);
      const work = await createWorkUnit(app.db, owner, {
        title: 'Ledger fixture',
        objective: 'Exercise commit order',
      });
      const runId = await seedQueuedRun(app.db, owner, { workUnitId: work.id, version });
      const context = await createAgentContext(agent.db, {
        organizationId,
        initiatorMembershipId: owner.membershipId,
        agentRunId: runId,
      });
      await prepareRunInputContext(agent.db, organizationId, runId);
      const firstId = randomUUID(),
        secondId = randomUUID();
      let observedOlder!: () => void;
      const insertedOlder = new Promise<void>((resolve) => {
        observedOlder = resolve;
      });
      const mayCommitOlder = new Promise<void>((resolve) => {
        releaseOlder = resolve;
      });
      const insert = (
        id: string,
      ) => sql`insert into platform.usage_ledger(organization_id,id,idempotency_key,meter,quantity,unit,cost_micros,billing_period,commercial_mode,work_unit_id,run_id,status,billable)
        values (${organizationId},${id},${'test-usage:' + id},'model_input_tokens',1,'unit',0,to_char(now(),'YYYY-MM'),'cloud',${work.id},${runId},'final',true)`;
      older = withTenantTx(agent.db, context, async (tx) => {
        await tx.execute(insert(firstId));
        observedOlder();
        await mayCommitOlder;
      });
      // This barrier observes the first actual SQL INSERT; no timer guesses commit ordering.
      await Promise.race([
        insertedOlder,
        older.then(() => {
          throw new Error('TEST_OLDER_INSERT_NOT_OBSERVED');
        }),
      ]);
      await withTenantTx(agent.db, context, (tx) => tx.execute(insert(secondId)));
      const usage = createSaasPorts({}).usage;
      expect(await consumeUsage(app.db, service, usage, { limit: 1 })).toMatchObject({
        entries: 1,
        microcredits: card.microcreditsPerUnit,
      });
      if (!releaseOlder) throw new Error('TEST_OLDER_BARRIER_MISSING');
      releaseOlder();
      await older;
      expect(await consumeUsage(app.db, service, usage, { limit: 1 })).toMatchObject({
        entries: 1,
        microcredits: card.microcreditsPerUnit,
      });
      expect((await consumeUsage(app.db, service, usage, { limit: 1 })).entries).toBe(0);
      const rows = await withTenantTx(app.db, service, (tx) =>
        tx.execute(
          sql`select usage_ref,count(*)::int as n from billing.credit_ledger where kind='consumption' group by usage_ref order by usage_ref`,
        ),
      );
      expect(rows.rows).toEqual(
        [firstId, secondId].sort().map((usage_ref) => ({ usage_ref, n: 1 })),
      );
    } finally {
      releaseOlder?.();
      await older?.catch(() => undefined);
      await agent.close();
      await app.close();
    }
  });
});
