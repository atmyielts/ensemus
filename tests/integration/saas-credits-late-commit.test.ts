// Requires merged M4 and M8 migrations. Two restricted agent-role transactions deliberately commit out of order.
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createWorkUnit } from '@ensemus/application';
import { consumeUsage } from '@ensemus/application/saas/credits';
import { startSubscription } from '@ensemus/application/saas/subscriptions';
import { createUsageLedgerReader } from '@ensemus/application/saas/usage-reader';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { seedPlan, seedRateCard } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('exact late-commit credit reconciliation', () => {
  it('consumes the newer committed usage, then the older committed usage exactly once', async () => {
    const app = openAppDatabase(urls.app());
    const auth = new pg.Client({ connectionString: urls.auth() });
    const older = new pg.Client({
      connectionString: urls.superuser(),
      options: '-c role=ensemus_agent',
    });
    const newer = new pg.Client({
      connectionString: urls.superuser(),
      options: '-c role=ensemus_agent',
    });
    await auth.connect();
    await older.connect();
    await newer.connect();
    try {
      const userId = randomUUID();
      await auth.query('insert into identity.users(id,name,email) values ($1,$2,$3)', [
        userId,
        'Late commit test',
        `${userId}@example.invalid`,
      ]);
      const { organizationId } = await createOrganization(app.db, {
        userId,
        name: 'Late commit test',
        commercialMode: 'cloud',
      });
      const owner = await resolveTenantContext(app.db, userId, organizationId);
      const context = createServiceContext(organizationId);
      const card = await seedRateCard({ meter: 'model_input_tokens' });
      await startSubscription(app.db, owner, await seedPlan({ mode: 'cloud', rateCard: card }));
      const work = await createWorkUnit(app.db, owner, {
        title: 'Ledger fixture',
        objective: 'Exercise commit order',
      });
      const serviceId = randomUUID(),
        definitionId = randomUUID(),
        versionId = randomUUID(),
        runId = randomUUID();
      const spec = '{}';
      const digest = createHash('sha256').update(spec).digest('hex');
      const testLimit = randomInt(1, 100);
      await withTenantTx(app.db, owner, async (tx) => {
        await tx.execute(
          sql`insert into org.service_identities(organization_id,id,owner_membership_id,purpose) values (${organizationId},${serviceId},${owner.membershipId},'ledger fixture')`,
        );
        await tx.execute(
          sql`insert into ai.agent_definitions(organization_id,id,slug,name,owner_membership_id,service_identity_id) values (${organizationId},${definitionId},${'test-' + definitionId},'Ledger fixture',${owner.membershipId},${serviceId})`,
        );
        await tx.execute(
          sql`insert into ai.agent_versions(organization_id,id,definition_id,version_number,spec,spec_sha256,evaluation_report_sha256,policy_version,max_cost_micros,published_by_membership_id) values (${organizationId},${versionId},${definitionId},1,${spec}::jsonb,${digest},${digest},'test',${testLimit},${owner.membershipId})`,
        );
        await tx.execute(
          sql`insert into ai.agent_runs(organization_id,id,work_unit_id,agent_version_id,initiator_membership_id,service_identity_id,effective_classification,max_model_turns,max_tool_calls,max_total_tokens,max_cost_micros,timeout_seconds,delegated_scopes) values (${organizationId},${runId},${work.id},${versionId},${owner.membershipId},${serviceId},'internal',${testLimit},${testLimit},${testLimit},${testLimit},${testLimit},'{}'::jsonb)`,
        );
      });
      const firstId = randomUUID(),
        secondId = randomUUID();
      const insert = `insert into platform.usage_ledger(organization_id,id,idempotency_key,meter,quantity,unit,billing_period,commercial_mode,work_unit_id,run_id,status,billable) values ($1,$2,$3,'model_input_tokens',1,'unit',to_char(now(),'YYYY-MM'),'cloud',$4,$5,'final',true) returning created_at::text`;
      await older.query('begin');
      await older.query("select set_config('app.organization_id',$1,true)", [organizationId]);
      const oldTime = await older.query(insert, [
        organizationId,
        firstId,
        randomUUID(),
        work.id,
        runId,
      ]);
      await newer.query('begin');
      await newer.query("select set_config('app.organization_id',$1,true)", [organizationId]);
      const newTime = await newer.query(insert, [
        organizationId,
        secondId,
        randomUUID(),
        work.id,
        runId,
      ]);
      await newer.query('commit');
      expect(new Date(newTime.rows[0].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(oldTime.rows[0].created_at).getTime(),
      );
      const reader = createUsageLedgerReader();
      expect((await consumeUsage(app.db, context, reader, { limit: 1 })).entries).toBe(1);
      await older.query('commit');
      expect((await consumeUsage(app.db, context, reader, { limit: 1 })).entries).toBe(1);
      expect((await consumeUsage(app.db, context, reader, { limit: 1 })).entries).toBe(0);
      const rows = await withTenantTx(app.db, context, (tx) =>
        tx.execute(
          sql`select usage_ref,count(*)::int as n from billing.credit_ledger where kind='consumption' group by usage_ref order by usage_ref`,
        ),
      );
      expect(rows.rows).toEqual(
        [firstId, secondId].sort().map((usage_ref) => ({ usage_ref, n: 1 })),
      );
    } finally {
      await older.query('rollback').catch(() => undefined);
      await newer.query('rollback').catch(() => undefined);
      await older.end();
      await newer.end();
      await auth.end();
      await app.close();
    }
  });
});
