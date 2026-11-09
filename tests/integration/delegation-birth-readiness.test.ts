// ADR-028 open question 12 (decided by the project owner on 2026-11-09), part 2: the per-birth check
// ai.delegation_influence_ready, and part 1's capability ledger, both from 0548_deleg. Actual app, agent,
// dispatcher, migrator and superuser logins; genuine parents through the real admission services
// (tests/helpers/delegated-child.ts). The capability is qualified for this file through the migrator and
// the prior state is appended back afterwards. SQL first runs in the CI run after 0548 was journaled.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createChildRun } from '@ensemus/application/ai-delegation';
import { finishRun, setRunStatus } from '@ensemus/application/ai-runs';
import {
  agentRuns,
  auditEvents,
  delegatedInputReceipts,
  delegatedWorkBirths,
  openAppDatabase,
  runInputCheckpoints,
  withTenantTx,
  workUnits,
  type AgentContext,
  type Tx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { loadAgentReadScopeInTx } from '../../packages/application/src/ai/read-scope';
import { pgCode } from '../../packages/application/src/errors';
import {
  openAgentTestDatabase,
  seedActiveProfile,
  seedAiTenant,
  seedOrganizationBudget,
  seedRateCard,
  type AiTenant,
} from '../helpers/ai/fixtures';
import { urls } from '../helpers/stack';
import { delegatedChildHarness } from '../helpers/delegated-child';
import {
  appendDelegationCapability,
  DELEGATION_QUALIFICATION_TAGS,
  qualifyDelegationForSuite,
} from '../helpers/delegation-capability';

const readyIn = async (tx: Tx, parent: string | null, child: string | null) =>
  (
    await tx.execute<{ ready: boolean | null }>(
      sql`select ai.delegation_influence_ready(${parent}::uuid,${child}::uuid) ready`,
    )
  ).rows[0]?.ready;

/** The text PostgreSQL raised, whether the driver error is the pg error itself or wraps it as cause. */
const raisedMessage = (error: unknown) => {
  const outer = error as { message?: unknown; cause?: { message?: unknown } };
  return typeof outer.cause?.message === 'string' ? outer.cause.message : outer.message;
};

async function client(url: string) {
  const connection = new pg.Client({ connectionString: url });
  await connection.connect();
  return connection;
}
/** The SQLSTATE of a refused statement, or 'ok' (with the row count) when it ran. */
async function outcome(connection: pg.Client, text: string, values: unknown[] = []) {
  try {
    const result = await connection.query(text, values);
    return `ok:${result.rowCount ?? 0}`;
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
}

describe('ADR-028 delegated child birth readiness (0548_deleg)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4);
  let a: AiTenant, b: AiTenant;
  let profileA: string, rateCardA: string, profileB: string, rateCardB: string;
  let capability: Awaited<ReturnType<typeof qualifyDelegationForSuite>> | undefined;
  beforeAll(async () => {
    capability = await qualifyDelegationForSuite('delegation-birth-readiness');
    a = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    b = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    profileA = await seedActiveProfile(app.db, agent.db, a.owner);
    rateCardA = await seedRateCard(app.db, a.owner, profileA);
    await seedOrganizationBudget(app.db, a.owner, 1_000_000);
    profileB = await seedActiveProfile(app.db, agent.db, b.owner);
    rateCardB = await seedRateCard(app.db, b.owner, profileB);
    await seedOrganizationBudget(app.db, b.owner, 1_000_000);
  });
  afterAll(async () => {
    await capability?.restore();
    await agent.close();
    await app.close();
  });
  const tenantA = delegatedChildHarness({
    app: app.db,
    agent: agent.db,
    tenant: () => a,
    profileId: () => profileA,
    rateCardId: () => rateCardA,
  });
  const tenantB = delegatedChildHarness({
    app: app.db,
    agent: agent.db,
    tenant: () => b,
    profileId: () => profileB,
    rateCardId: () => rateCardB,
  });

  /** The predicate as the run's own birth transaction reads it: after its scope load. */
  const readyInScope = (context: AgentContext, parent: string | null, child: string | null) =>
    withTenantTx(agent.db, context, async (tx) => {
      await loadAgentReadScopeInTx(tx, context);
      return readyIn(tx, parent, child);
    });
  /**
   * createChildRun refused, either as a denied result or a refused call, by whatever gate comes first.
   * For a fenced, verifying or ended parent an application gate may refuse before the 0548 predicate
   * runs, so this leg shows only that no child is born end to end (with nothingBorn). That the predicate
   * itself refuses is shown by the direct readyIn checks in the same case, never by this helper.
   */
  const refusedBirth = async (attempt: Promise<{ kind: string }>) => {
    const result = await attempt.then(
      (value) => value.kind,
      (error: unknown) => `refused:${String((error as { code?: unknown }).code)}`,
    );
    expect(result).not.toBe('created');
    return result;
  };
  /** Nothing of a child exists: no copied Work, witness, receipt or run. */
  const nothingBorn = async (owner: AiTenant, f: { childRunId: string; childWorkId: string }) => {
    await withTenantTx(app.db, owner.owner, async (tx) => {
      expect(
        await tx
          .select({ id: workUnits.id })
          .from(workUnits)
          .where(eq(workUnits.id, f.childWorkId)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(delegatedWorkBirths)
          .where(eq(delegatedWorkBirths.workUnitId, f.childWorkId)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(delegatedInputReceipts)
          .where(eq(delegatedInputReceipts.childRunId, f.childRunId)),
      ).toEqual([]);
      expect(
        await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, f.childRunId)),
      ).toEqual([]);
    });
  };
  const receiptsOf = (owner: AiTenant, childRunId: string) =>
    withTenantTx(app.db, owner.owner, (tx) =>
      tx
        .select()
        .from(delegatedInputReceipts)
        .where(eq(delegatedInputReceipts.childRunId, childRunId)),
    );

  it('[ADR028-Q12-P2] admits the parent in its own scoped transaction, and still needs the real witness', async () => {
    const f = await tenantA.fixture();
    expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(true);
    // validate_delegation_birth stays a separate condition: the predicate alone never births a child.
    await expect(
      withTenantTx(agent.db, f.context, async (tx) => {
        await loadAgentReadScopeInTx(tx, f.context);
        expect(await readyIn(tx, f.runId, f.childRunId)).toBe(true);
        const [parent] = await tx
          .select({
            agentVersionId: agentRuns.agentVersionId,
            serviceIdentityId: agentRuns.serviceIdentityId,
          })
          .from(agentRuns)
          .where(eq(agentRuns.id, f.runId));
        if (!parent) throw new Error('TEST_PARENT_MISSING');
        await tx.insert(agentRuns).values({
          organizationId: a.organizationId,
          id: f.childRunId,
          workUnitId: f.childWorkId,
          agentVersionId: parent.agentVersionId,
          parentRunId: f.runId,
          depth: 1,
          initiatorMembershipId: a.owner.membershipId,
          serviceIdentityId: parent.serviceIdentityId,
          effectiveClassification: 'internal',
          maxModelTurns: 5,
          maxToolCalls: 5,
          maxTotalTokens: 10_000,
          maxCostMicros: 10_000,
          timeoutSeconds: 60,
          maxDelegationDepth: 0,
          delegatedScopes: { tools: ['work.read'] },
        });
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        pgCode(error) === 'EN119' && raisedMessage(error) === 'DELEGATION_INPUT_PROOF_UNAVAILABLE',
    );
    await nothingBorn(a, f);
    const created = await tenantA.underDelegationPolicy(() =>
      createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 2 }),
    );
    if (created.kind !== 'created') {
      const why = await tenantA.birthDiagnostic(f);
      throw new Error(`TEST_GENUINE_CHILD_NOT_ADMITTED:${created.code}:${JSON.stringify(why)}`);
    }
    expect(created).toMatchObject({ childRunId: f.childRunId, childWorkUnitId: f.childWorkId });
    expect(await receiptsOf(a, f.childRunId)).toHaveLength(1);
  });

  it('[ADR028-Q12-P2] refuses a sibling run of the same initiator acting for another parent', async () => {
    const fa = await tenantA.fixture(),
      fb = await tenantA.fixture();
    expect(await readyInScope(fb.context, fa.runId, fa.childRunId)).toBe(false);
    expect(await readyInScope(fb.context, fb.runId, fb.childRunId)).toBe(true);
    expect(
      await refusedBirth(
        tenantA.underDelegationPolicy(() =>
          createChildRun(agent.db, fb.context, { parentRunId: fa.runId, stepNumber: 2 }),
        ),
      ),
    ).toBe('refused:NOT_FOUND');
    await nothingBorn(a, fa);
  });

  it('[ADR028-Q12-P2] refuses a live parent whose input checkpoint is fenced, and the fence cannot be undone', async () => {
    const f = await tenantA.fixture(),
      service = createServiceContext(a.organizationId);
    await withTenantTx(agent.db, service, (tx) =>
      tx.execute(sql`select ai.fence_run_inputs(${f.runId}::uuid)`),
    );
    await expect(
      withTenantTx(agent.db, f.context, (tx) => loadAgentReadScopeInTx(tx, f.context)),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Even with the scope marker forged, the fenced checkpoint refuses.
    expect(
      await withTenantTx(agent.db, f.context, async (tx) => {
        await tx.execute(
          sql`select set_config('app.agent_scope_protocol',${`scoped-v1:${f.runId}`},true)`,
        );
        return readyIn(tx, f.runId, f.childRunId);
      }),
    ).toBe(false);
    await refusedBirth(
      tenantA.underDelegationPolicy(() =>
        createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 2 }),
      ),
    );
    await nothingBorn(a, f);
    await expect(
      withTenantTx(agent.db, service, (tx) =>
        tx
          .update(runInputCheckpoints)
          .set({ fencedAt: null, fenceGeneration: 0 })
          .where(eq(runInputCheckpoints.runId, f.runId)),
      ),
    ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
  });

  it('[ADR028-Q12-P2] refuses a parent that is verifying or has ended', async () => {
    const f = await tenantA.fixture();
    await setRunStatus(agent.db, f.context, { agentRunId: f.runId, status: 'verifying' });
    const [checkpoint] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select({ fencedAt: runInputCheckpoints.fencedAt })
        .from(runInputCheckpoints)
        .where(eq(runInputCheckpoints.runId, f.runId)),
    );
    expect(checkpoint?.fencedAt).toBeNull();
    expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(false);
    await finishRun(agent.db, f.context, {
      agentRunId: f.runId,
      status: 'cancelled',
      stopCode: 'STOPPED_BY_PERSON',
    });
    expect(
      await withTenantTx(agent.db, f.context, async (tx) => {
        await tx.execute(
          sql`select set_config('app.agent_scope_protocol',${`scoped-v1:${f.runId}`},true)`,
        );
        return readyIn(tx, f.runId, f.childRunId);
      }),
    ).toBe(false);
    await refusedBirth(
      tenantA.underDelegationPolicy(() =>
        createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 2 }),
      ),
    );
    await nothingBorn(a, f);
  });

  it('[ADR028-Q12-P2] refuses missing, equal and existing child IDs, and a retry finds the one child', async () => {
    const f = await tenantA.fixture(),
      other = await tenantA.fixture();
    await withTenantTx(agent.db, f.context, async (tx) => {
      await loadAgentReadScopeInTx(tx, f.context);
      expect(await readyIn(tx, f.runId, f.childRunId)).toBe(true);
      expect(await readyIn(tx, f.runId, f.runId)).toBe(false);
      expect(await readyIn(tx, f.runId, other.runId)).toBe(false);
      expect(await readyIn(tx, null, f.childRunId)).toBe(false);
      expect(await readyIn(tx, f.runId, null)).toBe(false);
    });
    const created = await tenantA.underDelegationPolicy(() =>
      createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 2 }),
    );
    expect(created).toMatchObject({ kind: 'created', childRunId: f.childRunId });
    expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(false);
    expect(
      await tenantA.underDelegationPolicy(() =>
        createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 2 }),
      ),
    ).toEqual(created);
    expect(await receiptsOf(a, f.childRunId)).toHaveLength(1);
  });

  it('[ADR028-Q12-P2] refuses a parent whose Work is in the 0414 unproven inventory (rolled back)', async () => {
    const f = await tenantA.fixture();
    const [parent] = await withTenantTx(app.db, a.owner, (tx) =>
      tx
        .select({ workUnitId: agentRuns.workUnitId })
        .from(agentRuns)
        .where(eq(agentRuns.id, f.runId)),
    );
    if (!parent) throw new Error('TEST_PARENT_MISSING');
    const su = await client(urls.superuser());
    // SET SESSION AUTHORIZATION, not SET ROLE: the predicate requires session_user to be the agent.
    const asAgent = async () => {
      await su.query('set local session authorization ensemus_agent');
      await su.query(
        `select set_config('app.organization_id',$1,true),set_config('app.membership_id',$2,true),
          set_config('app.user_id',$3,true),set_config('app.actor_type','agent',true),
          set_config('app.agent_run_id',$4,true),set_config('app.agent_input_protocol','v1',true),
          set_config('app.agent_scope_protocol',$5,true)`,
        [
          a.organizationId,
          f.context.membershipId,
          f.context.userId,
          f.runId,
          `scoped-v1:${f.runId}`,
        ],
      );
      const { rows } = await su.query<{ ready: boolean }>(
        'select ai.delegation_influence_ready($1,$2) ready',
        [f.runId, f.childRunId],
      );
      return rows[0]?.ready;
    };
    try {
      await su.query('begin');
      try {
        expect(await asAgent()).toBe(true);
        await su.query('reset session authorization');
        await su.query(
          `insert into ai.unproven_child_work_inputs(organization_id,work_unit_id,child_run_id,parent_run_id)
           values($1,$2,$3,$4)`,
          [a.organizationId, parent.workUnitId, randomUUID(), randomUUID()],
        );
        expect(await asAgent()).toBe(false);
      } finally {
        await su.query('rollback');
      }
      const { rows } = await su.query<{ n: number }>(
        'select count(*)::integer n from ai.unproven_child_work_inputs where organization_id=$1',
        [a.organizationId],
      );
      expect(rows).toEqual([{ n: 0 }]);
    } finally {
      await su.end();
    }
  });

  it('[ADR028-Q12-P2] follows the latest capability row, and only the migrator login can append one', async () => {
    const f = await tenantA.fixture();
    await appendDelegationCapability('revoked', 'readiness-revoked');
    try {
      expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(false);
      expect(
        await tenantA.underDelegationPolicy(() =>
          createChildRun(agent.db, f.context, { parentRunId: f.runId, stepNumber: 2 }),
        ),
      ).toMatchObject({ kind: 'denied', code: 'DELEGATION_WIDENED' });
      const reasons = await withTenantTx(app.db, a.owner, (tx) =>
        tx
          .select({ reason: auditEvents.safeReason })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.targetRef, `agent_run:${f.runId}`),
              eq(auditEvents.action, 'agent_run.delegation_denied'),
            ),
          ),
      );
      expect(reasons.map((row) => row.reason)).toContain('DELEGATION_INPUT_PROOF_UNAVAILABLE');
      await nothingBorn(a, f);
    } finally {
      await appendDelegationCapability('qualified', 'readiness-requalified');
    }
    expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(true);

    const ledger = 'ai.delegation_birth_capabilities';
    const insert = `insert into ${ledger}(state,evidence_kind,ci_run_id,source_commit,qualification_tests,review_ref)
      values('qualified','qualification_fixture','fixture:forged','${'0'.repeat(40)}',$1::text[],'forged')`;
    const tags = [...DELEGATION_QUALIFICATION_TAGS];
    for (const url of [urls.app(), urls.agent(), urls.dispatcher()]) {
      const runtime = await client(url);
      try {
        expect(await outcome(runtime, insert, [tags])).toBe('42501');
        expect(await outcome(runtime, `select * from ${ledger}`)).toBe('42501');
        expect(await outcome(runtime, `update ${ledger} set review_ref='x'`)).toBe('42501');
        expect(await outcome(runtime, `delete from ${ledger}`)).toBe('42501');
        expect(await outcome(runtime, `truncate ${ledger}`)).toBe('42501');
      } finally {
        await runtime.end();
      }
    }
    const app2 = await client(urls.app());
    try {
      expect(await outcome(app2, 'select ai.delegation_birth_capability_on()')).toBe('42501');
      expect(
        await outcome(app2, 'select ai.delegation_influence_ready($1,$2)', [f.runId, f.childRunId]),
      ).toBe('42501');
    } finally {
      await app2.end();
    }

    const migrator = await client(urls.migrator());
    try {
      const before = await migrator.query(`select * from ${ledger} order by seq`);
      // No UPDATE or DELETE policy exists: under FORCE RLS such a statement matches no row at all.
      expect(await outcome(migrator, `update ${ledger} set review_ref='rewritten'`)).toBe('ok:0');
      expect(await outcome(migrator, `delete from ${ledger}`)).toBe('ok:0');
      // TRUNCATE is outside RLS, so the append-only trigger refuses it.
      await expect(migrator.query(`truncate ${ledger}`)).rejects.toMatchObject({
        code: 'EN119',
        message: 'DELEGATION_CAPABILITY_APPEND_ONLY',
      });
      expect((await migrator.query(`select * from ${ledger} order by seq`)).rows).toEqual(
        before.rows,
      );
      await migrator.query('begin');
      try {
        const stamped = await migrator.query<{ recorded_by: string }>(
          `insert into ${ledger}(state,evidence_kind,ci_run_id,source_commit,qualification_tests,review_ref,recorded_by)
           values('qualified','qualification_fixture','fixture:stamp','${'0'.repeat(40)}',$1::text[],'stamp','ensemus_app')
           returning recorded_by`,
          [tags],
        );
        expect(stamped.rows).toEqual([{ recorded_by: 'ensemus_migrator' }]);
      } finally {
        await migrator.query('rollback');
      }
      const refusal = async (text: string, values: unknown[]) => {
        await migrator.query('begin');
        try {
          return await outcome(migrator, text, values);
        } finally {
          await migrator.query('rollback');
        }
      };
      expect(await refusal(insert, [tags.filter((tag) => tag !== 'ADR028-Q12-L8b')])).toBe('23514');
      expect(
        await refusal(
          `insert into ${ledger}(state,evidence_kind,ci_run_id,source_commit,qualification_tests,review_ref)
           values('qualified','deployment_migration','github-actions:12345678','${'0'.repeat(40)}',$1::text[],'x')`,
          [tags],
        ),
      ).toBe('23514');
      expect(
        await refusal(
          `insert into ${ledger}(state,evidence_kind,migration_tag,ci_run_id,source_commit,qualification_tests,review_ref)
           values('qualified','deployment_migration','0591_delegation_birth_capability_record_deleg','fixture:x','${'0'.repeat(40)}',$1::text[],'x')`,
          [tags],
        ),
      ).toBe('23514');
      // A deployment row must cite a real commit: every other field valid, the all-zero commit refused,
      // and the same row with a non-zero commit accepted (rolled back).
      const deployment = (commit: string) =>
        `insert into ${ledger}(state,evidence_kind,migration_tag,ci_run_id,source_commit,qualification_tests,review_ref)
         values('qualified','deployment_migration','0591_delegation_birth_capability_record_deleg','github-actions:12345678','${commit}',$1::text[],'x')`;
      expect(await refusal(deployment('0'.repeat(40)), [tags])).toBe('23514');
      expect(await refusal(deployment('0123456789abcdef'.repeat(3).slice(0, 40)), [tags])).toBe(
        'ok:1',
      );
    } finally {
      await migrator.end();
    }

    const su = await client(urls.superuser());
    try {
      await su.query('begin');
      try {
        // A session that bypasses RLS reaches the append-only trigger.
        await expect(su.query(`update ${ledger} set review_ref='rewritten'`)).rejects.toMatchObject(
          { code: 'EN119' },
        );
      } finally {
        await su.query('rollback');
      }
      await su.query('begin');
      try {
        await expect(su.query(`delete from ${ledger}`)).rejects.toMatchObject({ code: 'EN119' });
      } finally {
        await su.query('rollback');
      }
      await su.query('begin');
      try {
        await su.query('set local role ensemus_migrator');
        expect(await outcome(su, insert, [tags])).toBe('42501');
      } finally {
        await su.query('rollback');
      }
    } finally {
      await su.end();
    }
  });

  it('[ADR028-Q12-P2] a fixture row opens nothing outside a qualification database; a deployment row does', async () => {
    const f = await tenantA.fixture();
    const ledger = 'ai.delegation_birth_capabilities',
      tags = [...DELEGATION_QUALIFICATION_TAGS],
      marker = 'ensemus_delegation_qualification_ci';
    const deployment = (state: 'qualified' | 'revoked') =>
      `insert into ${ledger}(state,evidence_kind,migration_tag,ci_run_id,source_commit,qualification_tests,review_ref)
       values('${state}','deployment_migration','0591_delegation_birth_capability_record_deleg','github-actions:12345678',
         '${'0123456789abcdef'.repeat(3).slice(0, 40)}',$1::text[],'P2 deployment evidence case')`;
    // Positive control: in this CI cluster the suite's fixture row is the latest, and it counts.
    expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(true);
    const su = await client(urls.superuser()),
      migrator = await client(urls.migrator());
    try {
      // Without the installation-time marker, the same fixture row is ignored...
      await su.query(`drop role ${marker}`);
      expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(false);
      // ...and no new fixture row can be appended at all, even by the migrator login.
      await expect(
        migrator.query(
          `insert into ${ledger}(state,evidence_kind,ci_run_id,source_commit,qualification_tests,review_ref)
           values('qualified','qualification_fixture','fixture:no-marker','${'0'.repeat(40)}',$1::text[],'no marker')`,
          [tags],
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: 'DELEGATION_CAPABILITY_FIXTURE_OUTSIDE_QUALIFICATION',
      });
      expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(false);
      // A deployment row counts in any database, and a later deployment 'revoked' row closes again.
      expect(await outcome(migrator, deployment('qualified'), [tags])).toBe('ok:1');
      expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(true);
      expect(await outcome(migrator, deployment('revoked'), [[]])).toBe('ok:1');
      expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(false);
    } finally {
      await su.query(`do $$ begin
        if not exists(select 1 from pg_roles where rolname='${marker}') then
          create role ${marker} nologin nosuperuser nocreaterole nobypassrls noinherit;
        end if;
      end $$`);
      await migrator.end();
      await su.end();
    }
    // With the marker back, the suite's fixture capability is appended again and counts.
    await appendDelegationCapability('qualified', 'readiness-marker-restored');
    expect(await readyInScope(f.context, f.runId, f.childRunId)).toBe(true);
  });

  it('[ADR028-Q12-P2] needs the exact scoped-v1 marker for this parent and an agent actor', async () => {
    const f = await tenantA.fixture(),
      other = await tenantA.fixture();
    await withTenantTx(agent.db, f.context, async (tx) => {
      await loadAgentReadScopeInTx(tx, f.context);
      for (const marker of [
        '',
        `scoped-v1:${other.runId}`,
        `scoped-v1:${f.runId.toUpperCase()}`,
        `scoped-v2:${f.runId}`,
      ]) {
        await tx.execute(sql`select set_config('app.agent_scope_protocol',${marker},true)`);
        expect(await readyIn(tx, f.runId, f.childRunId)).toBe(false);
      }
      await tx.execute(
        sql`select set_config('app.agent_scope_protocol',${`scoped-v1:${f.runId}`},true)`,
      );
      expect(await readyIn(tx, f.runId, f.childRunId)).toBe(true);
    });
    expect(
      await withTenantTx(agent.db, createServiceContext(a.organizationId), async (tx) => {
        await tx.execute(sql`select set_config('app.agent_run_id',${f.runId},true),
          set_config('app.membership_id',${f.context.membershipId},true),
          set_config('app.agent_scope_protocol',${`scoped-v1:${f.runId}`},true)`);
        return readyIn(tx, f.runId, f.childRunId);
      }),
    ).toBe(false);
  });

  it('[ADR028-Q12-P2] refuses another tenant forging this parent', async () => {
    const fa = await tenantA.fixture(),
      fb = await tenantB.fixture();
    expect(
      await withTenantTx(agent.db, fb.context, async (tx) => {
        await loadAgentReadScopeInTx(tx, fb.context);
        await tx.execute(sql`select set_config('app.agent_run_id',${fa.runId},true),
          set_config('app.agent_scope_protocol',${`scoped-v1:${fa.runId}`},true)`);
        return readyIn(tx, fa.runId, fa.childRunId);
      }),
    ).toBe(false);
    expect(
      await refusedBirth(
        tenantB.underDelegationPolicy(() =>
          createChildRun(agent.db, fb.context, { parentRunId: fa.runId, stepNumber: 2 }),
        ),
      ),
    ).toBe('refused:NOT_FOUND');
    await nothingBorn(a, fa);
  });
});
