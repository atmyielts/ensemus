// 0553 (CI repair round 12, check finding 1). FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet
// reviewed by a person. 0552 dropped nineteen FKs from retained evidence into tables the eraser empties, so
// erasure can finish; 0553 puts back the birth half of each one as a BEFORE INSERT trigger (and BEFORE
// UPDATE OF where the table can be updated at all). Each case below runs as the role that really holds
// INSERT on the table (ensemus_agent for reservations, usage and egress; ensemus_app for budgets, kill
// switches and policy bundles) in its own tenant: a UUID that names no row, and a UUID that names another
// tenant's row, are both refused with EN423 RETAINED_REFERENT_MISSING and nothing is written. The real
// writers (setBudget, the run's reservation, usage and egress, the knowledge model-job principal,
// engageKillSwitch and releaseKillSwitch, an owner's policy bundle) still write; a switch whose engager is
// gone is still released through releaseKillSwitch by another person; an operator's switch (no tenant)
// that names a person is refused; the migrator-only probe policies admit nothing to a runtime role that
// sets their selectors, nor to the migrator outside a trigger (CI repair round 13, check findings 4, 5
// and 8); and 0553's postcondition, run again as the migrator in a rolled-back transaction, refuses each
// way the guard could be undone. That erasure still finishes with these triggers in place is
// agent-delegated-offboarding's L6 (leftOver []).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkUnit } from '@ensemus/application';
import { setBudget } from '@ensemus/application/ai-budget';
import { createEgressLog } from '@ensemus/application/ai-egress-log';
import { engageKillSwitch, releaseKillSwitch } from '@ensemus/application/ai-halt';
import type { LedgerEntry } from '@ensemus/application/ai-ports';
import { createUsageLedger } from '@ensemus/application/ai-usage';
import {
  executionSteps,
  openAppDatabase,
  policyBundles,
  withTenantTx,
  type AgentContext,
} from '@ensemus/database';
import { createAgentContext } from '@ensemus/database/agent';
import {
  openAgentTestDatabase,
  prepareRunInputContext,
  seedActiveProfile,
  seedAgentVersion,
  seedAiTenant,
  seedQueuedRun,
  seedRateCard,
  sha256Of,
  thisPeriod,
  withAdmittedRunTx,
  type AiTenant,
  type SeededAgentVersion,
} from '../helpers/ai/fixtures';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { seedQualifiedKnowledgeRoute } from '../helpers/knowledge-models';
import { makePerson, nativePersonContext } from '../helpers/product';
import { repoRoot, urls } from '../helpers/stack';

/** The nineteen columns 0552 dropped an FK from, as `[table, column]` (0552's reviewed list). */
const COLUMNS = [
  ['platform.budget_reservations', 'run_id'],
  ['platform.budget_reservations', 'step_id'],
  ['platform.budget_reservations', 'model_job_id'],
  ['platform.budget_reservations', 'model_call_id'],
  ['platform.budgets', 'agent_version_id'],
  ['platform.budgets', 'created_by_membership_id'],
  ['platform.usage_ledger', 'rate_card_id'],
  ['platform.usage_ledger', 'work_unit_id'],
  ['platform.usage_ledger', 'run_id'],
  ['platform.usage_ledger', 'step_id'],
  ['platform.usage_ledger', 'profile_id'],
  ['platform.usage_ledger', 'model_job_id'],
  ['platform.usage_ledger', 'model_call_id'],
  ['governance.egress_decisions', 'run_id'],
  ['governance.egress_decisions', 'step_id'],
  ['governance.egress_decisions', 'profile_id'],
  ['governance.kill_switches', 'engaged_by_membership_id'],
  ['governance.kill_switches', 'released_by_membership_id'],
  ['governance.policy_bundles', 'created_by_membership_id'],
] as const;
type Column = (typeof COLUMNS)[number][1];

/** What the trigger refuses with, through the wrapper Drizzle adds. The DETAIL names only the column. */
const missing = (table: string, column: string) => ({
  cause: expect.objectContaining({
    code: 'EN423',
    message: 'RETAINED_REFERENT_MISSING',
    detail: `${table}.${column}`,
  }),
});

const GUARD = 'lifecycle.require_retained_referent()';

describe('retained evidence names an existing referent of its own tenant at birth (0553)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4),
    su = new pg.Client({ connectionString: urls.superuser() }),
    migrator = new pg.Client({ connectionString: urls.migrator() });
  const ledger = () => createUsageLedger(agent.db);

  type Run = {
    runId: string;
    workUnitId: string;
    version: SeededAgentVersion;
    context: AgentContext;
  };
  type Side = {
    tenant: AiTenant;
    run: Run;
    stepId: string;
    profileId: string;
    rateCardId: string;
  };
  let ours: Side & { budgetId: string };
  let theirs: Side & { modelJobId: string; modelCallId: string };

  /** A queued run the agent role may account for, admitted the way the runtime admits it (ai-usage). */
  const startRun = async (tenant: AiTenant): Promise<Run> => {
    const version = await seedAgentVersion(app.db, tenant.owner);
    const work = await createWorkUnit(app.db, tenant.owner, {
      title: 'Agent work',
      objective: 'Do it.',
    });
    const runId = await seedQueuedRun(app.db, tenant.owner, { workUnitId: work.id, version });
    const context = await createAgentContext(agent.db, {
      organizationId: tenant.organizationId,
      initiatorMembershipId: tenant.owner.membershipId,
      agentRunId: runId,
    });
    await prepareRunInputContext(agent.db, tenant.organizationId, runId);
    return { runId, workUnitId: work.id, version, context };
  };
  /** A model-turn step, written in the runtime's admitted transaction (ai-usage). */
  const startStep = async (tenant: AiTenant, run: Run, stepNumber: number) => {
    const stepId = randomUUID();
    await withAdmittedRunTx(agent.db, run.context, (tx) =>
      tx.insert(executionSteps).values({
        organizationId: tenant.organizationId,
        id: stepId,
        runId: run.runId,
        stepNumber,
        kind: 'model_turn',
        state: 'in_flight',
        labelCode: 'THINKING',
      }),
    );
    return stepId;
  };
  const side = async (tenant: AiTenant): Promise<Side> => {
    const run = await startRun(tenant);
    const profileId = await seedActiveProfile(app.db, agent.db, tenant.owner);
    return {
      tenant,
      run,
      stepId: await startStep(tenant, run, 1),
      profileId,
      rateCardId: await seedRateCard(app.db, tenant.owner, profileId),
    };
  };
  const one = async (query: string, values: unknown[]) =>
    (await su.query<{ id: string }>(query, values)).rows[0]?.id;

  beforeAll(async () => {
    await su.connect();
    await migrator.connect();
    const a = await seedAiTenant(app.db),
      b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    // The other tenant's model job and call come from the knowledge model-job principal, its real writer:
    // a qualification job run here through the knowledge call store (0216).
    await seedQualifiedKnowledgeRoute(app.db, b.owner);
    const theirSide = await side(b);
    const modelJobId = await one(
      'select id::text id from ai.model_jobs where organization_id=$1 limit 1',
      [b.organizationId],
    );
    const modelCallId = await one(
      'select id::text id from ai.model_call_attempts where organization_id=$1 and job_id=$2 limit 1',
      [b.organizationId, modelJobId],
    );
    if (!modelJobId || !modelCallId) throw new Error('TEST_MODEL_JOB_PRINCIPAL_MISSING');
    theirs = { ...theirSide, modelJobId, modelCallId };
    // Our organization budget is set the way an owner sets it.
    const { budgetId } = await setBudget(app.db, a.owner, {
      scope: 'organization',
      agent_version_id: null,
      period: thisPeriod(),
      limit_micros: 1_000_000,
    });
    ours = { ...(await side(a)), budgetId };
  });
  afterAll(async () => {
    await migrator.end();
    await su.end();
    await agent.close();
    await app.close();
  });

  /** Another tenant's existing row for the column's target table. */
  const theirRow = (column: Column): string =>
    ({
      run_id: theirs.run.runId,
      step_id: theirs.stepId,
      model_job_id: theirs.modelJobId,
      model_call_id: theirs.modelCallId,
      agent_version_id: theirs.run.version.versionId,
      created_by_membership_id: theirs.tenant.owner.membershipId,
      rate_card_id: theirs.rateCardId,
      work_unit_id: theirs.run.workUnitId,
      profile_id: theirs.profileId,
      engaged_by_membership_id: theirs.tenant.owner.membershipId,
      released_by_membership_id: theirs.tenant.owner.membershipId,
    })[column];

  /**
   * One direct INSERT into the table, by the role that holds INSERT on it, in our own tenant: every other
   * referent is one of our own existing rows (or null), and only `column` is `value`.
   */
  const insert = (table: string, column: Column, value: string) => {
    const organizationId = ours.tenant.organizationId,
      pick = (name: Column, own: string | null) => (name === column ? value : own);
    switch (table) {
      case 'platform.budget_reservations':
        return withTenantTx(agent.db, ours.run.context, (tx) =>
          tx.execute(sql`insert into platform.budget_reservations
              (organization_id,budget_id,run_id,step_id,attempt,amount_micros,model_job_id,model_call_id)
            values (${organizationId}::uuid,${ours.budgetId}::uuid,${pick('run_id', ours.run.runId)}::uuid,
              ${pick('step_id', ours.stepId)}::uuid,${1000 + Math.floor(Math.random() * 1_000_000)},1,
              ${pick('model_job_id', null)}::uuid,${pick('model_call_id', null)}::uuid)`),
        );
      case 'platform.usage_ledger':
        return withTenantTx(agent.db, ours.run.context, (tx) =>
          tx.execute(sql`insert into platform.usage_ledger
              (organization_id,idempotency_key,meter,quantity,unit,cost_micros,billing_period,commercial_mode,
               rate_card_id,work_unit_id,run_id,step_id,profile_id,model_job_id,model_call_id,status,billable)
            values (${organizationId}::uuid,${`test:${randomUUID()}`},'tool_call',1,'call',0,${thisPeriod()},'byom',
              ${pick('rate_card_id', null)}::uuid,${pick('work_unit_id', ours.run.workUnitId)}::uuid,
              ${pick('run_id', ours.run.runId)}::uuid,${pick('step_id', null)}::uuid,${pick('profile_id', null)}::uuid,
              ${pick('model_job_id', null)}::uuid,${pick('model_call_id', null)}::uuid,'final',false)`),
        );
      case 'governance.egress_decisions':
        return withTenantTx(agent.db, ours.run.context, (tx) =>
          tx.execute(sql`insert into governance.egress_decisions
              (organization_id,run_id,step_id,profile_id,data_class,purpose,decision,reason_code,policy_version)
            values (${organizationId}::uuid,${pick('run_id', ours.run.runId)}::uuid,${pick('step_id', null)}::uuid,
              ${pick('profile_id', null)}::uuid,'internal','reason','deny','NO_CANDIDATE','test')`),
        );
      case 'platform.budgets':
        return withTenantTx(app.db, ours.tenant.owner, (tx) =>
          tx.execute(sql`insert into platform.budgets
              (organization_id,scope,agent_version_id,period,limit_micros,created_by_membership_id)
            values (${organizationId}::uuid,${column === 'agent_version_id' ? 'agent_version' : 'organization'},
              ${pick('agent_version_id', null)}::uuid,'2001-01',100,
              ${pick('created_by_membership_id', ours.tenant.owner.membershipId)}::uuid)`),
        );
      case 'governance.kill_switches':
        return withTenantTx(app.db, ours.tenant.owner, (tx) =>
          tx.execute(sql`insert into governance.kill_switches
              (organization_id,scope,reason_code,engaged_by_membership_id,released_at,released_by_membership_id)
            values (${organizationId}::uuid,'organization','TEST',
              ${pick('engaged_by_membership_id', ours.tenant.owner.membershipId)}::uuid,
              ${column === 'released_by_membership_id' ? new Date().toISOString() : null}::timestamptz,
              ${pick('released_by_membership_id', null)}::uuid)`),
        );
      case 'governance.policy_bundles':
        return withTenantTx(app.db, ours.tenant.owner, (tx) =>
          tx.execute(sql`insert into governance.policy_bundles
              (organization_id,version,sha256,document,active,created_by_membership_id)
            values (${organizationId}::uuid,${1_000_000 + Math.floor(Math.random() * 1_000_000)},
              ${sha256Of(randomUUID())},'{}'::jsonb,false,
              ${pick('created_by_membership_id', ours.tenant.owner.membershipId)}::uuid)`),
        );
      default:
        throw new Error(`TEST_UNKNOWN_TABLE:${table}`);
    }
  };
  const rowsNaming = async (table: string, column: string, value: string) =>
    (
      await su.query<{ n: number }>(
        `select count(*)::integer n from ${table} where organization_id=$1 and ${column}=$2::uuid`,
        [ours.tenant.organizationId, value],
      )
    ).rows[0]?.n;

  it.each(COLUMNS)(
    '[0553] %s.%s refuses a UUID that names no row, and one that names another tenant’s, writing nothing',
    async (table, column) => {
      for (const value of [randomUUID(), theirRow(column)]) {
        await expect(insert(table, column, value)).rejects.toMatchObject(missing(table, column));
        expect(await rowsNaming(table, column, value)).toBe(0);
      }
    },
  );

  it('[0553] the real writers still write, naming their own tenant’s rows', async () => {
    const { organizationId, owner } = ours.tenant,
      context = ours.run.context;
    // setBudget on our own agent version: agent_version_id and created_by_membership_id.
    const { budgetId: versionBudget } = await setBudget(app.db, owner, {
      scope: 'agent_version',
      agent_version_id: ours.run.version.versionId,
      period: thisPeriod(),
      limit_micros: 1_000_000,
    });
    expect(
      (
        await su.query(
          'select agent_version_id::text,created_by_membership_id::text from platform.budgets where organization_id=$1 and id=$2',
          [organizationId, versionBudget],
        )
      ).rows,
    ).toEqual([
      {
        agent_version_id: ours.run.version.versionId,
        created_by_membership_id: owner.membershipId,
      },
    ]);
    // The run's hold (run_id, step_id), as the inference gateway writes it.
    const held = await withAdmittedRunTx(agent.db, context, (tx) =>
      ledger().reserve(tx, context, {
        runId: ours.run.runId,
        stepId: ours.stepId,
        attempt: 1,
        agentVersionId: ours.run.version.versionId,
        amountMicros: 10,
      }),
    );
    expect(held).toMatchObject({ ok: true });
    // The run's priced usage (run_id, work_unit_id, rate_card_id, profile_id).
    const entry: LedgerEntry = {
      idempotencyKey: `test:${randomUUID()}`,
      meter: 'model_input_tokens',
      quantity: 10,
      unit: 'token',
      costMicros: 10,
      rateCardId: ours.rateCardId,
      rateCardVersion: 1,
      reservationId: null,
      workUnitId: ours.run.workUnitId,
      runId: ours.run.runId,
      stepId: null,
      profileId: ours.profileId,
      profileVersion: 1,
      providerKind: null,
      requestHash: null,
      status: 'final',
    };
    await expect(
      withTenantTx(agent.db, context, (tx) => ledger().record(tx, context, entry)),
    ).resolves.toBe(true);
    // The run's egress log (run_id, profile_id).
    await createEgressLog(agent.db).record(context, {
      runId: ours.run.runId,
      stepId: null,
      profileId: ours.profileId,
      dataClass: 'internal',
      purpose: 'reason',
      destinationHost: null,
      decision: 'deny',
      reasonCode: 'NO_CANDIDATE',
      policyVersion: 'test',
      requestHash: null,
      expiresAt: null,
    });
    const evidence = await su.query<Record<string, string | null>>(
      `select 'reservation' kind,run_id::text,step_id::text,null rate_card_id,null work_unit_id,null profile_id
         from platform.budget_reservations where organization_id=$1 and run_id=$2
       union all
       select 'usage',run_id::text,step_id::text,rate_card_id::text,work_unit_id::text,profile_id::text
         from platform.usage_ledger where organization_id=$1 and run_id=$2
       union all
       select 'egress',run_id::text,step_id::text,null,null,profile_id::text
         from governance.egress_decisions where organization_id=$1 and run_id=$2`,
      [organizationId, ours.run.runId],
    );
    expect(evidence.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'reservation',
          run_id: ours.run.runId,
          step_id: ours.stepId,
        }),
        expect.objectContaining({
          kind: 'usage',
          run_id: ours.run.runId,
          rate_card_id: ours.rateCardId,
          work_unit_id: ours.run.workUnitId,
          profile_id: ours.profileId,
        }),
        expect.objectContaining({
          kind: 'egress',
          run_id: ours.run.runId,
          profile_id: ours.profileId,
        }),
      ]),
    );
    // The knowledge model-job principal wrote its hold and usage (model_job_id, model_call_id) in beforeAll.
    const principal = await su.query<{ kind: string; n: number }>(
      `select 'reservation' kind,count(*)::integer n from platform.budget_reservations
         where organization_id=$1 and model_job_id=$2 and model_call_id=$3
       union all
       select 'usage',count(*)::integer from platform.usage_ledger
         where organization_id=$1 and model_job_id=$2 and model_call_id=$3 and profile_id is not null
           and rate_card_id is not null`,
      [theirs.tenant.organizationId, theirs.modelJobId, theirs.modelCallId],
    );
    for (const row of principal.rows) expect(row.n, row.kind).toBeGreaterThan(0);
    // An owner's policy bundle (created_by_membership_id).
    const version = 2_000_000 + Math.floor(Math.random() * 1_000_000);
    await withTenantTx(app.db, owner, (tx) =>
      tx.insert(policyBundles).values({
        organizationId,
        version,
        sha256: sha256Of(`bundle:${version}`),
        document: {},
        active: false,
        createdByMembershipId: owner.membershipId,
      }),
    );
    expect(
      (
        await su.query(
          'select created_by_membership_id::text from governance.policy_bundles where organization_id=$1 and version=$2',
          [organizationId, version],
        )
      ).rows,
    ).toEqual([{ created_by_membership_id: owner.membershipId }]);
  });

  it('[0553] engageKillSwitch and releaseKillSwitch write; a release naming no person of this tenant is refused', async () => {
    const { organizationId, owner } = ours.tenant;
    // A version no run uses, so the switch halts nothing else in this file.
    const target = await seedAgentVersion(app.db, owner);
    const { switchId } = await engageKillSwitch(app.db, owner, {
      scope: 'agent_version',
      target_ref: target.versionId,
      reason_code: 'INCIDENT',
    });
    // ensemus_app holds UPDATE (released_at, released_by_membership_id): the one runtime UPDATE of a
    // referent column, so its BEFORE UPDATE OF trigger refuses the same two UUIDs.
    for (const value of [randomUUID(), theirs.tenant.owner.membershipId])
      await expect(
        withTenantTx(app.db, owner, (tx) =>
          tx.execute(sql`update governance.kill_switches set released_at=now(),
              released_by_membership_id=${value}::uuid where id=${switchId}::uuid`),
        ),
      ).rejects.toMatchObject(missing('governance.kill_switches', 'released_by_membership_id'));
    await releaseKillSwitch(app.db, owner, { switchId });
    expect(
      (
        await su.query(
          `select engaged_by_membership_id::text,released_by_membership_id::text,released_at is not null released
             from governance.kill_switches where organization_id=$1 and id=$2`,
          [organizationId, switchId],
        )
      ).rows,
    ).toEqual([
      {
        engaged_by_membership_id: owner.membershipId,
        released_by_membership_id: owner.membershipId,
        released: true,
      },
    ]);
  });

  /**
   * The state erasure leaves (0552), reached the way production reaches it: X, an admin (ai.halt,
   * packages/domain/src/policy.ts), engages a tenant switch through engageKillSwitch, and X's membership is
   * then deleted as erasure deletes it. The switch keeps X's historical UUID and no membership has it.
   */
  const switchWithGoneEngager = async () => {
    const { organizationId, owner } = ours.tenant;
    const person = await makePerson('halt-engager');
    await inFixtureTenant(su, organizationId, () =>
      su.query(
        `insert into org.memberships (organization_id, user_id, role, status)
         values ($1, $2, 'admin', 'active')`,
        [organizationId, person.userId],
      ),
    );
    const engager = await nativePersonContext(app.db, person, organizationId);
    // A version no run uses, so the switch halts nothing else in this file.
    const target = await seedAgentVersion(app.db, owner);
    const { switchId } = await engageKillSwitch(app.db, engager, {
      scope: 'agent_version',
      target_ref: target.versionId,
      reason_code: 'INCIDENT',
    });
    await inFixtureTenant(su, organizationId, () =>
      su.query('delete from org.memberships where organization_id=$1 and id=$2', [
        organizationId,
        engager.membershipId,
      ]),
    );
    expect(
      (
        await su.query('select 1 from org.memberships where organization_id=$1 and id=$2', [
          organizationId,
          engager.membershipId,
        ])
      ).rowCount,
    ).toBe(0);
    return { switchId, goneId: engager.membershipId };
  };
  const switchState = async (switchId: string) =>
    (
      await su.query(
        `select engaged_by_membership_id::text,released_by_membership_id::text,released_at is not null released
           from governance.kill_switches where organization_id=$1 and id=$2`,
        [ours.tenant.organizationId, switchId],
      )
    ).rows;

  it('[0553] releaseKillSwitch, by another person with halt authority, releases a switch whose engager is gone', async () => {
    const { owner } = ours.tenant;
    const { switchId, goneId } = await switchWithGoneEngager();
    // Y is the owner: a different member, still present, who holds ai.halt. The release goes through the real
    // command as ensemus_app. It sets released_at and released_by_membership_id only, so the change trigger on
    // released_by_membership_id checks Y, and X's gone UUID in engaged_by_membership_id is not checked again.
    expect(owner.membershipId).not.toBe(goneId);
    await expect(releaseKillSwitch(app.db, owner, { switchId })).resolves.toBeUndefined();
    expect(await switchState(switchId)).toEqual([
      {
        engaged_by_membership_id: goneId,
        released_by_membership_id: owner.membershipId,
        released: true,
      },
    ]);
  });

  it('[0553] engaged_by_membership_id, which no runtime role may update, is checked again only when it changes', async () => {
    const { switchId, goneId } = await switchWithGoneEngager();
    // A different column from the release above: 0101 grants ensemus_app UPDATE on released_at and
    // released_by_membership_id only, and the migrator's policies reach no tenant switch, so only a superuser
    // past RLS can write this column. Rolled back, so the switch stays as engaged.
    await su.query('begin');
    try {
      await su.query(
        'update governance.kill_switches set engaged_by_membership_id=engaged_by_membership_id where id=$1',
        [switchId],
      );
      await expect(
        su.query('update governance.kill_switches set engaged_by_membership_id=$2 where id=$1', [
          switchId,
          randomUUID(),
        ]),
      ).rejects.toMatchObject({
        code: 'EN423',
        message: 'RETAINED_REFERENT_MISSING',
        detail: 'governance.kill_switches.engaged_by_membership_id',
      });
    } finally {
      await su.query('rollback');
    }
    expect(await switchState(switchId)).toEqual([
      { engaged_by_membership_id: goneId, released_by_membership_id: null, released: false },
    ]);
  });

  it('[0553] an operator’s switch, which has no tenant, is refused when it names a person', async () => {
    // 0553 (lines 134-142) refuses a row with a NULL organization_id that names a referent, since no tenant
    // row can be named without its tenant. 0553 cannot be edited, so this is said here: it matches every real
    // writer. engageOperatorSwitch (packages/database/src/halt-operator.ts:37-49) writes no membership id;
    // releaseOperatorSwitch (:53-66) sets only released_at; 0508:766 and 0511:152 insert (organization_id,
    // scope, reason_code) only; and engageKillSwitch and releaseKillSwitch (packages/application/src/ai/
    // halt.ts:205-213, 273-276) always carry the tenant's organization_id. No real writer stores a referent
    // with a NULL organization.
    const reasonCode = `TEST_R13_${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      providerKind = `test-provider-${randomUUID()}`;
    const write = (membershipId: string | null) =>
      migrator.query(
        `insert into governance.kill_switches
           (organization_id,scope,target_ref,reason_code,engaged_by_membership_id)
         values (null,'provider',$1,$2,$3::uuid)`,
        [providerKind, reasonCode, membershipId],
      );
    const written = async (client: pg.Client) =>
      (
        await client.query<{ n: number }>(
          'select count(*)::integer n from governance.kill_switches where reason_code=$1',
          [reasonCode],
        )
      ).rows[0]?.n;
    // As the operator's command writes one: the migrator, under kill_switches_operator (0101:186). Always
    // rolled back, so no provider stop is ever left behind.
    await migrator.query('begin');
    try {
      await migrator.query('savepoint operator_switch');
      await expect(write(ours.tenant.owner.membershipId)).rejects.toMatchObject({
        code: 'EN423',
        message: 'RETAINED_REFERENT_MISSING',
        detail: 'governance.kill_switches.engaged_by_membership_id',
      });
      await migrator.query('rollback to savepoint operator_switch');
      // kill_switches_operator shows the migrator every row with no tenant: nothing was written.
      expect(await written(migrator)).toBe(0);
      // The same row naming no person, as engageOperatorSwitch writes it, is admitted: the refusal is the
      // referent's alone.
      await write(null);
      expect(await written(migrator)).toBe(1);
    } finally {
      await migrator.query('rollback');
    }
    expect(await written(su)).toBe(0);
  });

  describe('the probe policies (0553:150-167) admit nothing outside the guard', () => {
    /** The nine tables with the migrator's one-row probe policy, each with the other tenant's existing row. */
    const probedRows = (): readonly (readonly [string, string])[] => [
      ['ai.agent_runs', theirs.run.runId],
      ['ai.execution_steps', theirs.stepId],
      ['ai.model_jobs', theirs.modelJobId],
      ['ai.model_call_attempts', theirs.modelCallId],
      ['ai.agent_versions', theirs.run.version.versionId],
      ['ai.rate_cards', theirs.rateCardId],
      ['ai.model_profiles', theirs.profileId],
      ['work.work_units', theirs.run.workUnitId],
      ['org.memberships', theirs.tenant.owner.membershipId],
    ];
    /** Both selectors, transaction-local, as anyone can set them. */
    const select = (client: pg.Client, organizationId: string, id: string) =>
      client.query(
        `select set_config('lifecycle.retained_referent_org',$1,true),
                set_config('lifecycle.retained_referent_id',$2,true)`,
        [organizationId, id],
      );
    type Outcome = { n: number } | { code: string };
    /** One count on the superuser connection, already in a transaction, in its own savepoint. */
    const attempt = async (text: string, values: unknown[]): Promise<Outcome> => {
      await su.query('savepoint probe');
      try {
        const { rows } = await su.query<{ n: number }>(text, values);
        await su.query('release savepoint probe');
        return { n: rows[0]?.n ?? -1 };
      } catch (error) {
        await su.query('rollback to savepoint probe');
        return { code: String((error as { code?: unknown }).code) };
      }
    };

    it.each(['ensemus_app', 'ensemus_agent', 'ensemus_operator', 'ensemus_support'])(
      '[0553] %s, setting both selectors to another tenant’s row, sees nothing it could not see before',
      async (role) => {
        const present = (
          await su.query<{ present: boolean }>('select to_regrole($1) is not null present', [role])
        ).rows[0]?.present;
        if (!present) {
          // Skipped: only the SaaS desk roles (0501) may be absent from a build, never the two runtime roles.
          expect(['ensemus_operator', 'ensemus_support']).toContain(role);
          return;
        }
        const other = theirs.tenant.organizationId;
        // Each row is there, so a zero below is RLS and not a missing row.
        for (const [table, id] of probedRows())
          expect(
            (
              await su.query(`select 1 from ${table} where organization_id=$1 and id=$2`, [
                other,
                id,
              ])
            ).rowCount,
            table,
          ).toBe(1);
        // Bound to our own tenant, as that role runs (ensemus_app as our owner, ensemus_agent as our run),
        // while naming the other tenant's row in both selectors.
        const bound =
          role === 'ensemus_agent'
            ? ours.run.context
            : role === 'ensemus_app'
              ? ours.tenant.owner
              : null;
        let readable = 0;
        await su.query('begin');
        try {
          await su.query(`set local role ${role}`);
          await su.query(
            `select set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),
                    set_config('app.membership_id',$3,true),set_config('app.actor_type',$4,true),
                    set_config('app.agent_run_id',$5,true)`,
            [
              ours.tenant.organizationId,
              bound?.userId ?? '',
              bound?.membershipId ?? '',
              bound?.actorType ?? '',
              bound?.agentRunId ?? '',
            ],
          );
          for (const [table, id] of probedRows()) {
            const count = `select count(*)::integer n from ${table} where organization_id=$1`;
            await select(su, '', '');
            const before = await attempt(count, [other]);
            await select(su, other, id);
            const after = await attempt(count, [other]);
            // The same answer as without the selectors (a refusal stays the same refusal), and never a row
            // of the other tenant.
            expect(after, `${role} ${table}`).toEqual(before);
            if ('n' in after) {
              expect(after.n, `${role} ${table}`).toBe(0);
              readable += 1;
            }
          }
        } finally {
          await su.query('rollback');
        }
        // Not vacuous: the application role reads these tables at all.
        if (role === 'ensemus_app') expect(readable).toBeGreaterThan(0);
      },
    );

    it('[0553] admit nothing to the migrator outside a trigger, with both selectors naming the row', async () => {
      const other = theirs.tenant.organizationId;
      // Control, past RLS: with these selectors the probe's other two terms name exactly this row, so the
      // zero below comes from pg_trigger_depth()>0 alone.
      await su.query('begin');
      try {
        for (const [table, id] of probedRows()) {
          await select(su, other, id);
          const { rows } = await su.query<{ n: number }>(
            `select count(*)::integer n from ${table}
              where organization_id::text=pg_catalog.current_setting('lifecycle.retained_referent_org',true)
                and id::text=pg_catalog.current_setting('lifecycle.retained_referent_id',true)`,
          );
          expect(rows[0]?.n, table).toBe(1);
        }
      } finally {
        await su.query('rollback');
      }
      await migrator.query('begin');
      try {
        expect(
          (await migrator.query<{ depth: number }>('select pg_trigger_depth() depth')).rows[0]
            ?.depth,
        ).toBe(0);
        for (const [table, id] of probedRows()) {
          await select(migrator, other, id);
          const { rows } = await migrator.query<{ n: number }>(
            `select count(*)::integer n from ${table} where organization_id=$1 and id=$2`,
            [other, id],
          );
          expect(rows[0]?.n, table).toBe(0);
        }
      } finally {
        await migrator.query('rollback');
      }
    });
  });

  it('[0553] the guard is SECURITY DEFINER, pinned, not executable by anyone else, and has no DELETE trigger', async () => {
    const fn = await su.query<{
      owner: string;
      prosecdef: boolean;
      proconfig: string[];
      others: number;
    }>(
      `select r.rolname owner,p.prosecdef,p.proconfig,
         (select count(*)::integer from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
           where a.grantee<>p.proowner) others
         from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`,
      [GUARD],
    );
    expect(fn.rows).toMatchObject([{ owner: 'ensemus_migrator', prosecdef: true, others: 0 }]);
    expect(fn.rows[0]?.proconfig.map((setting) => setting.replace(/ /g, ''))).toEqual([
      'search_path=pg_catalog,pg_temp',
    ]);
    for (const role of ['ensemus_app', 'ensemus_agent', 'ensemus_eraser'])
      expect(
        (
          await su.query<{ can: boolean }>(
            `select has_function_privilege($1::name,$2::text,'EXECUTE') can`,
            [role, GUARD],
          )
        ).rows[0]?.can,
        role,
      ).toBe(false);
    const triggers = await su.query<{ table_ref: string; name: string; events: number }>(
      `select n.nspname||'.'||c.relname table_ref,t.tgname name,(t.tgtype::integer&(4|8|16|32)) events
         from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where t.tgfoid=$1::regprocedure and t.tgenabled in ('O','A') order by 1,2`,
      [GUARD],
    );
    const births = triggers.rows.filter((row) =>
      row.name.startsWith('aa_retained_referent_birth_'),
    );
    expect(births.map((row) => `${row.table_ref}.${row.name.slice(27)}`).sort()).toEqual(
      COLUMNS.map(([table, column]) => `${table}.${column}`).sort(),
    );
    // INSERT (4) for a birth, UPDATE (16) for a change, and never DELETE (8) or TRUNCATE (32): erasing a
    // referenced row fires nothing here.
    expect(births.every((row) => row.events === 4)).toBe(true);
    const changes = triggers.rows.filter(
      (row) => !row.name.startsWith('aa_retained_referent_birth_'),
    );
    expect(changes).toHaveLength(9);
    expect(changes.every((row) => row.events === 16)).toBe(true);
    expect(
      triggers.rows.every((row) =>
        ['platform.', 'governance.'].some((schema) => row.table_ref.startsWith(schema)),
      ),
    ).toBe(true);
  });

  describe("0553's postcondition, run again as the migrator", () => {
    const postcondition = readFileSync(
      join(
        repoRoot,
        'packages/database/migrations/0553_retained_referent_birth_guards_r12erasure.sql',
      ),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .at(-1)!;
    type Refusal = {
      code: string | undefined;
      message: string | undefined;
      detail: string | undefined;
    } | null;
    /** Runs work as the migrator in a transaction that is always rolled back: null, or its refusal. */
    const rolledBack = async (work: () => Promise<unknown>): Promise<Refusal> => {
      await migrator.query('begin');
      try {
        await work();
        return null;
      } catch (error) {
        const { code, message, detail } = error as Exclude<Refusal, null>;
        return { code, message, detail };
      } finally {
        await migrator.query('rollback');
      }
    };
    /** The postcondition holds, the change is made, and the postcondition is run again. */
    const undone = (...changes: string[]) =>
      rolledBack(async () => {
        await migrator.query(postcondition);
        for (const change of changes) await migrator.query(change);
        await migrator.query(postcondition);
      });
    const refused = (detail: string) => ({
      code: 'EN850',
      message: 'RETAINED_REFERENT_BIRTH_POSTCONDITION',
      detail,
    });

    it('[0553] holds on the migrated database', async () => {
      expect(await rolledBack(() => migrator.query(postcondition))).toBeNull();
    });

    it.each([
      [
        'a dropped birth trigger',
        ['drop trigger aa_retained_referent_birth_run_id on platform.usage_ledger'],
        'platform.usage_ledger aa_retained_referent_birth_run_id',
      ],
      [
        'a disabled birth trigger',
        [
          'alter table governance.policy_bundles disable trigger aa_retained_referent_birth_created_by_membership_id',
        ],
        'governance.policy_bundles aa_retained_referent_birth_created_by_membership_id',
      ],
      [
        'a birth trigger under a WHEN clause',
        [
          'drop trigger aa_retained_referent_birth_profile_id on governance.egress_decisions',
          `create trigger aa_retained_referent_birth_profile_id before insert on governance.egress_decisions
             for each row when (false) execute function lifecycle.require_retained_referent('profile_id','ai','model_profiles')`,
        ],
        'governance.egress_decisions aa_retained_referent_birth_profile_id',
      ],
      [
        'a birth trigger aimed at another table',
        [
          'drop trigger aa_retained_referent_birth_agent_version_id on platform.budgets',
          `create trigger aa_retained_referent_birth_agent_version_id before insert on platform.budgets
             for each row execute function lifecycle.require_retained_referent('agent_version_id','ai','agent_definitions')`,
        ],
        'platform.budgets aa_retained_referent_birth_agent_version_id',
      ],
      [
        'a dropped change trigger',
        [
          'drop trigger aa_retained_referent_change_released_by_membership_id on governance.kill_switches',
        ],
        'governance.kill_switches aa_retained_referent_change_released_by_membership_id',
      ],
      [
        'a widened probe policy',
        ['alter policy retained_referent_birth_probe on ai.agent_runs using (true)'],
        'ai.agent_runs retained_referent_birth_probe',
      ],
      [
        'a dropped probe policy',
        ['drop policy retained_referent_birth_probe on org.memberships'],
        'org.memberships retained_referent_birth_probe',
      ],
      ['EXECUTE granted to PUBLIC', [`grant execute on function ${GUARD} to public`], GUARD],
      [
        'EXECUTE granted to a runtime role',
        [`grant execute on function ${GUARD} to ensemus_agent`],
        GUARD,
      ],
      ['a changed search_path', [`alter function ${GUARD} set search_path=public`], GUARD],
      ['SECURITY INVOKER', [`alter function ${GUARD} security invoker`], GUARD],
      [
        'the guard firing on the DELETE of a referenced row',
        [
          `create trigger r12_probe before delete on ai.agent_runs
             for each row execute function lifecycle.require_retained_referent('id','ai','agent_runs')`,
        ],
        `${GUARD} triggers`,
      ],
    ])('[0553] refuses %s', async (_case, changes, detail) => {
      expect(await undone(...changes)).toEqual(refused(detail));
    });
  });
});
