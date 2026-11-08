// Actual login-role negatives for0510. Positive child birth/hold/race coverage belongs to the joined
//0419 real receipt fixture; these cases never manufacture a child receipt to make cleanup green.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { pgCode } from '@ensemus/application';
import { sql } from 'drizzle-orm';
import { makeTwoTenants } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('delegated Work hold proof is an exact native-agent metadata path', () => {
  const app = openAppDatabase(urls.app()),
    agent = openAgentDatabase(urls.agent());
  let organizationId: string;
  const child = randomUUID(),
    work = randomUUID(),
    source = randomUUID(),
    job = randomUUID();
  const call = sql`select lifecycle.delegated_work_hold_free(${child}::uuid,${work}::uuid,'knowledge_source',${source}::uuid,${job}::uuid) allowed`;
  beforeAll(async () => {
    organizationId = (await makeTwoTenants(app.db)).a.organizationId;
  });
  afterAll(async () => {
    await agent.close();
    await app.close();
  });

  it('denies the actual app login even with a service actor', async () => {
    await expect(
      withTenantTx(app.db, createServiceContext(organizationId), (tx) => tx.execute(call)),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
  it('does not retain the agent grant after SET ROLE app', async () => {
    await expect(
      withTenantTx(agent.db, createServiceContext(organizationId), async (tx) => {
        await tx.execute(sql`set local role ensemus_app`);
        return tx.execute(call);
      }),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
  it.each(['user', 'agent', 'delegated'])(
    'returns false for a forged %s actor without reading a body',
    async (actor) => {
      const result = await withTenantTx(
        agent.db,
        createServiceContext(organizationId),
        async (tx) => {
          await tx.execute(sql`select set_config('app.actor_type',${actor},true)`);
          return tx.execute<{ allowed: boolean }>(call);
        },
      );
      expect(result.rows).toEqual([{ allowed: false }]);
    },
  );
  it('refuses an unproven/missing relationship and restores every private selector', async () => {
    await withTenantTx(agent.db, createServiceContext(organizationId), async (tx) => {
      const names = [
        'lifecycle.delegated_hold_org',
        'lifecycle.delegated_hold_run',
        'lifecycle.delegated_hold_source',
        'lifecycle.delegated_hold_job',
      ];
      for (const name of names)
        await tx.execute(sql`select set_config(${name},'prior-selector',true)`);
      expect((await tx.execute<{ allowed: boolean }>(call)).rows).toEqual([{ allowed: false }]);
      for (const name of names)
        expect(
          (await tx.execute<{ value: string }>(sql`select current_setting(${name},true) value`))
            .rows[0]?.value,
        ).toBe('prior-selector');
    });
  });
  it('keeps the internal RLS predicate private instead of making caller GUCs credentials', async () => {
    await expect(
      withTenantTx(agent.db, createServiceContext(organizationId), (tx) =>
        tx.execute(
          sql`select lifecycle.delegated_hold_scope(${organizationId}::uuid,${child}::uuid,${source}::uuid,${job}::uuid)`,
        ),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });
});
