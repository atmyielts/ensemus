// 0553 (CI repair round 12, check finding 1). FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet
// reviewed by a person. 0552 dropped nineteen FKs from retained evidence into tables the eraser empties, so
// erasure can finish; 0553 puts back the birth half of each one as a BEFORE INSERT trigger (and BEFORE
// UPDATE OF where the table can be updated at all). Each case below runs as the role that really holds
// INSERT on the table (ensemus_agent for reservations, usage and egress; ensemus_app for budgets, kill
// switches and policy bundles) in its own tenant: a UUID that names no row, and a UUID that names another
// tenant's row, are both refused with EN423 RETAINED_REFERENT_MISSING and nothing is written. The real
// writers (setBudget, the run's reservation, usage and egress, the knowledge model-job principal,
// engageKillSwitch and releaseKillSwitch, an owner's policy bundle) still write; a retained row whose
// referent is gone stays updatable in its other columns; and 0553's postcondition, run again as the
// migrator in a rolled-back transaction, refuses each way the guard could be undone. That erasure still
// finishes with these triggers in place is agent-delegated-offboarding's L6 (leftOver []).
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
import { seedQualifiedKnowledgeRoute } from '../helpers/knowledge-models';
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

  it('[0553] a retained row whose referent is gone stays updatable, and only a changed referent is checked again', async () => {
    const planted = randomUUID(),
      gone = randomUUID();
    await su.query('begin');
    try {
      // The state erasure leaves (0552): a retained row naming a person whose membership no longer exists,
      // planted with triggers off as pg_restore --disable-triggers would, then triggers back on.
      await su.query("set local session_replication_role='replica'");
      await su.query(
        `insert into governance.kill_switches(id,organization_id,scope,reason_code,engaged_by_membership_id)
         values ($1,$2,'organization','TEST',$3)`,
        [planted, ours.tenant.organizationId, gone],
      );
      await su.query("set local session_replication_role='origin'");
      await su.query(
        'update governance.kill_switches set engaged_by_membership_id=engaged_by_membership_id where id=$1',
        [planted],
      );
      await expect(
        su.query('update governance.kill_switches set engaged_by_membership_id=$2 where id=$1', [
          planted,
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
