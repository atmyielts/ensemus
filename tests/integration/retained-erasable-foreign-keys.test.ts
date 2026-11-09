// 0552 (CI repair round 11, findings 1 and 10). FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7), not yet
// reviewed by a person. A table lifecycle.retained_table keeps through erasure (LIFE-04) holds no FK into a
// table the eraser empties, read from the catalogue the way listErasableTables reads it; the FKs between
// retained rows and to org.organizations stay; and 0552's postcondition, run again as the migrator in a
// rolled-back transaction, refuses when any of that (or 0550's requalification table, finding 10) is undone.
// The erase itself, with a tenant whose agent reserved and spent budget, is agent-delegated-offboarding's L6.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setBudget } from '@ensemus/application/ai-budget';
import { openAppDatabase } from '@ensemus/database';
import { seedAgentVersion, seedAiTenant, thisPeriod } from '../helpers/ai/fixtures';
import { repoRoot, urls } from '../helpers/stack';

/** The nineteen FKs 0552 dropped, as `table constraint`, with the historical columns they covered. */
const DROPPED = [
  [
    'platform.budget_reservations',
    'budget_reservations_organization_id_run_id_agent_runs_organizat',
    'run_id',
  ],
  [
    'platform.budget_reservations',
    'budget_reservations_organization_id_step_id_execution_steps_org',
    'step_id',
  ],
  ['platform.budget_reservations', 'budget_reservations_model_job_fk', 'model_job_id'],
  ['platform.budget_reservations', 'budget_reservations_model_call_fk', 'model_call_id'],
  [
    'platform.budgets',
    'budgets_organization_id_agent_version_id_agent_versions_organiz',
    'agent_version_id',
  ],
  [
    'platform.budgets',
    'budgets_organization_id_created_by_membership_id_memberships_or',
    'created_by_membership_id',
  ],
  [
    'platform.usage_ledger',
    'usage_ledger_organization_id_rate_card_id_rate_cards_organizati',
    'rate_card_id',
  ],
  [
    'platform.usage_ledger',
    'usage_ledger_organization_id_work_unit_id_work_units_organizati',
    'work_unit_id',
  ],
  [
    'platform.usage_ledger',
    'usage_ledger_organization_id_run_id_agent_runs_organization_id_',
    'run_id',
  ],
  [
    'platform.usage_ledger',
    'usage_ledger_organization_id_step_id_execution_steps_organizati',
    'step_id',
  ],
  [
    'platform.usage_ledger',
    'usage_ledger_organization_id_profile_id_model_profiles_organiza',
    'profile_id',
  ],
  ['platform.usage_ledger', 'usage_ledger_model_job_fk', 'model_job_id'],
  ['platform.usage_ledger', 'usage_ledger_model_call_fk', 'model_call_id'],
  [
    'governance.egress_decisions',
    'egress_decisions_organization_id_run_id_agent_runs_organization',
    'run_id',
  ],
  [
    'governance.egress_decisions',
    'egress_decisions_organization_id_step_id_execution_steps_organi',
    'step_id',
  ],
  [
    'governance.egress_decisions',
    'egress_decisions_organization_id_profile_id_model_profiles_orga',
    'profile_id',
  ],
  [
    'governance.kill_switches',
    'kill_switches_organization_id_engaged_by_membership_id_membersh',
    'engaged_by_membership_id',
  ],
  [
    'governance.kill_switches',
    'kill_switches_organization_id_released_by_membership_id_members',
    'released_by_membership_id',
  ],
  [
    'governance.policy_bundles',
    'policy_bundles_organization_id_created_by_membership_id_members',
    'created_by_membership_id',
  ],
] as const;

/** Retained->retained and retained->organization FKs 0552 must keep, as `table constraint -> target`. */
const KEPT = [
  'governance.egress_decisions egress_decisions_organization_id_organizations_id_fk -> org.organizations',
  'governance.kill_switches kill_switches_organization_id_organizations_id_fk -> org.organizations',
  'governance.policy_bundles policy_bundles_organization_id_organizations_id_fk -> org.organizations',
  'lifecycle.standing_stop_receipts standing_stop_switch -> governance.kill_switches',
  'platform.budget_reservations budget_reservations_organization_id_budget_id_budgets_organizat -> platform.budgets',
  'platform.budget_reservations budget_reservations_organization_id_organizations_id_fk -> org.organizations',
  'platform.budgets budgets_organization_id_organizations_id_fk -> org.organizations',
  'platform.outbox_events outbox_events_organization_id_event_id_domain_events_organizati -> platform.domain_events',
  'platform.usage_ledger usage_ledger_organization_id_corrects_id_usage_ledger_organizat -> platform.usage_ledger',
  'platform.usage_ledger usage_ledger_organization_id_organizations_id_fk -> org.organizations',
  'platform.usage_ledger usage_ledger_organization_id_reservation_id_budget_reservations -> platform.budget_reservations',
];

/**
 * Every FK whose table is retained, as `table constraint -> target`, split by whether the target is a
 * table the eraser empties: the same rule as packages/database/src/eraser.ts listErasableTables.
 */
const RETAINED_FKS = `
  select sn.nspname||'.'||s.relname||' '||c.conname||' -> '||dn.nspname||'.'||d.relname as fk,
         (d.relkind in ('r','p') and not d.relispartition and dn.nspname not like 'pg_%'
          and dn.nspname<>'information_schema'
          and not lifecycle.retained_table(dn.nspname::text,d.relname::text)
          and exists(select 1 from pg_attribute a where a.attrelid=d.oid and a.attname='organization_id'
                     and not a.attisdropped)) as erasable
    from pg_constraint c
    join pg_class s on s.oid=c.conrelid join pg_namespace sn on sn.oid=s.relnamespace
    join pg_class d on d.oid=c.confrelid join pg_namespace dn on dn.oid=d.relnamespace
   where c.contype='f' and sn.nspname not like 'pg_%' and sn.nspname<>'information_schema'
     and lifecycle.retained_table(sn.nspname::text,s.relname::text)
   order by 1`;

describe('retained evidence holds no FK into erasable tables (0552)', () => {
  const app = openAppDatabase(urls.app(), { max: 2 }),
    su = new pg.Client({ connectionString: urls.superuser() }),
    migrator = new pg.Client({ connectionString: urls.migrator() });
  beforeAll(async () => {
    await su.connect();
    await migrator.connect();
  });
  afterAll(async () => {
    await migrator.end();
    await su.end();
    await app.close();
  });

  const retainedFks = async (client: pg.Client) => {
    const rows = (await client.query<{ fk: string; erasable: boolean }>(RETAINED_FKS)).rows;
    return {
      erasable: rows.filter((row) => row.erasable).map((row) => row.fk),
      retained: rows.filter((row) => !row.erasable).map((row) => row.fk),
    };
  };

  it('[0552] no retained table holds an FK into a table the eraser empties', async () => {
    expect((await retainedFks(su)).erasable).toEqual([]);
    const dropped = await su.query<{ conname: string }>(
      `select c.conname from pg_constraint c join pg_class s on s.oid=c.conrelid
         join pg_namespace sn on sn.oid=s.relnamespace
        where (sn.nspname||'.'||s.relname||' '||c.conname)=any($1::text[])`,
      [DROPPED.map(([table, name]) => `${table} ${name}`)],
    );
    expect(dropped.rows).toEqual([]);
  });

  it('[0552] keeps every historical UUID column the dropped FKs covered', async () => {
    for (const [table, name, column] of DROPPED) {
      const kept = await su.query<{ type: string }>(
        `select format_type(a.atttypid,a.atttypmod) as type from pg_attribute a
          where a.attrelid=$1::regclass and a.attname=$2 and not a.attisdropped`,
        [table, column],
      );
      expect(kept.rows, `${table} ${name}`).toEqual([{ type: 'uuid' }]);
    }
  });

  it('[0552] keeps the FKs between retained rows and to the organization', async () => {
    const { retained } = await retainedFks(su);
    expect(retained).toEqual(expect.arrayContaining(KEPT));
    // A lifecycle stop still points at its kill switch, whatever its generated name.
    expect(
      retained.some(
        (fk) =>
          fk.startsWith('lifecycle.offboarding_agent_stops ') &&
          fk.endsWith(' -> governance.kill_switches'),
      ),
    ).toBe(true);
  });

  it('[0552] the catalogue check is not vacuous: one re-added FK is found, and only it', async () => {
    await su.query('begin');
    try {
      await su.query(
        `alter table platform.usage_ledger add constraint usage_ledger_model_call_fk
           foreign key (organization_id,model_call_id) references ai.model_call_attempts(organization_id,id) not valid`,
      );
      expect((await retainedFks(su)).erasable).toEqual([
        'platform.usage_ledger usage_ledger_model_call_fk -> ai.model_call_attempts',
      ]);
    } finally {
      await su.query('rollback');
    }
    expect((await retainedFks(su)).erasable).toEqual([]);
  });

  describe("0552's postcondition, run again as the migrator", () => {
    const postcondition = readFileSync(
      join(
        repoRoot,
        'packages/database/migrations/0552_retained_historical_run_referents_r11erasure.sql',
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
    const undone = (change: string) =>
      rolledBack(async () => {
        await migrator.query(postcondition);
        await migrator.query(change);
        await migrator.query(postcondition);
      });
    const refused = (detail: string) => ({
      code: 'EN850',
      message: 'RETAINED_REFERENT_POSTCONDITION',
      detail,
    });

    it('[0552] holds on the migrated database', async () => {
      expect(await rolledBack(() => migrator.query(postcondition))).toBeNull();
    });

    it('[0552] refuses a re-added retained->erasable FK', async () => {
      expect(
        await undone(
          `alter table platform.usage_ledger add constraint usage_ledger_model_call_fk
             foreign key (organization_id,model_call_id) references ai.model_call_attempts(organization_id,id) not valid`,
        ),
      ).toEqual(refused('platform.usage_ledger usage_ledger_model_call_fk'));
    });

    it('[0552] refuses a lost retained->retained FK', async () => {
      expect(
        await undone(
          'alter table platform.usage_ledger drop constraint usage_ledger_organization_id_reservation_id_budget_reservations',
        ),
      ).toEqual(
        refused(
          'platform.usage_ledger usage_ledger_organization_id_reservation_id_budget_reservations',
        ),
      );
    });

    it('[0552] refuses a lost historical column', async () => {
      expect(
        await undone(
          'alter table governance.egress_decisions rename column profile_id to profile_ref',
        ),
      ).toEqual(
        refused(
          'governance.egress_decisions egress_decisions_organization_id_profile_id_model_profiles_orga',
        ),
      );
    });

    it('[0552] refuses a disabled append-only guard', async () => {
      expect(
        await undone('alter table platform.usage_ledger disable trigger usage_ledger_append_only'),
      ).toEqual(refused('platform.usage_ledger usage_ledger_append_only'));
    });

    // Finding 10: 0551's postcondition stopped re-checking 0550's requalification evidence.
    const requalifications = 'lifecycle.raw_active_source_requalifications';
    it.each([
      ['a runtime table grant', `grant select on ${requalifications} to ensemus_app`],
      [
        'a runtime column grant',
        `grant select(organization_id) on ${requalifications} to ensemus_eraser`,
      ],
      ['a PUBLIC grant', `grant select on ${requalifications} to public`],
      ['RLS no longer forced', `alter table ${requalifications} no force row level security`],
      [
        'a second policy',
        `create policy r11_probe on ${requalifications} for select to ensemus_app using (true)`,
      ],
      [
        'its append-only guard disabled',
        `alter table ${requalifications} disable trigger raw_active_source_requalification_keep`,
      ],
    ])('[0552] refuses the requalification table with %s', async (_case, change) => {
      expect(await undone(change)).toEqual(refused(requalifications));
    });

    it('[0552] the requalification evidence is still append-only for its owner', async () => {
      expect(
        await rolledBack(() =>
          migrator.query(`update ${requalifications} set proven_at=proven_at where false`),
        ),
      ).toEqual({ code: '42501', message: 'APPEND_ONLY_CHANGE_REFUSED', detail: undefined });
    });
  });

  describe('a budget is born only on an agent version of its own tenant (setBudget, 0552)', () => {
    const budgetsFor = async (organizationId: string, versionId: string) =>
      (
        await su.query<{ n: number }>(
          'select count(*)::integer n from platform.budgets where organization_id=$1 and agent_version_id=$2',
          [organizationId, versionId],
        )
      ).rows[0]?.n;
    const versionBudget = (versionId: string) => ({
      scope: 'agent_version' as const,
      agent_version_id: versionId,
      period: thisPeriod(),
      limit_micros: 100,
    });

    it('[0552] sets a budget on its own agent version', async () => {
      const tenant = await seedAiTenant(app.db),
        version = await seedAgentVersion(app.db, tenant.owner);
      await expect(
        setBudget(app.db, tenant.owner, versionBudget(version.versionId)),
      ).resolves.toEqual({ budgetId: expect.any(String) });
      expect(await budgetsFor(tenant.organizationId, version.versionId)).toBe(1);
    });

    it('[0552] refuses another tenant’s agent version and one that never existed, writing nothing', async () => {
      const a = await seedAiTenant(app.db),
        b = await seedAiTenant(app.db),
        theirs = await seedAgentVersion(app.db, a.owner),
        never = randomUUID();
      for (const versionId of [theirs.versionId, never]) {
        await expect(setBudget(app.db, b.owner, versionBudget(versionId))).rejects.toMatchObject({
          code: 'INVALID_INPUT',
          auditAs: 'FOREIGN_REFERENCE',
        });
        expect(await budgetsFor(b.organizationId, versionId)).toBe(0);
      }
      expect(await budgetsFor(a.organizationId, theirs.versionId)).toBe(0);
    });
  });
});
