// 0555 (CI repair round 13, check findings 1, 2 and 3). FLAGGED FOR HUMAN SECURITY REVIEW (ADR-032 D7),
// not yet reviewed by a person. 0554 gave ensemus_app one way to write a typed-record purge completion
// (ai.record_purge_jobs.completed_restore_generation): the UPDATE policy record_purge_completion_attest and
// one column privilege, with 0419's guard replacing whatever is sent by PostgreSQL's own proof.
//   * Finding 1: 0554's postcondition checks that policy only by name, command, roles and permissiveness,
//     and its grants only through has_column_privilege (which ensemus_agent always passes, being IN ROLE
//     ensemus_app). 0555's postcondition pins the policy expressions, the other UPDATE paths and the direct
//     grants. Here both postconditions run again as the superuser in a rolled-back transaction: each holds
//     on the migrated database, and 0555's refuses every widening, including the ones 0554's lets through.
//   * Finding 2: ensemus_agent holds UPDATE(completed_restore_generation) through ensemus_app, so it may send
//     a value. 0419's guard sends every agent write to 0419's checks, which clear the completion: the
//     forged value is never stored, and only the sweep's proof writes a completion again.
//   * Finding 3: a completion stops attesting when the record changes, by the paths that really change it:
//     sovereign.rotate_material_restore_generation (a restore), a changed catalog row (the project's client,
//     knowledge.structured_record_catalog.parent_record_id) and an added tombstone (platform.tombstones,
//     through the archive import's recordImportedTombstone). 0554 adds no reopen trigger: its
//     ai.record_purge_completed recomputes 0419's snapshot from those two tables and compares the restore
//     generation, so the record is listed and proved again, and an agent pass plus the sweep complete it.
// Real app, agent, migrator and superuser roles; each case has a tenant of its own, so the sweep lists only
// that case's records.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkUnit, pgCode } from '@ensemus/application';
import { createHaltCheck } from '@ensemus/application/ai-halt';
import { createRunTranscriptPurge } from '@ensemus/application/ai-input-ledger';
import { createKnowledgeCallStore } from '@ensemus/application/ai-knowledge-call-store';
import {
  confirmRecordWorkPurgeInTx,
  createDelegatedRecordPurge,
} from '@ensemus/application/knowledge/delegated-record-purge';
import { listRecordPurgeCandidates } from '@ensemus/application/knowledge/record-closure';
import { createKnowledgePurgeActivities } from '@ensemus/workflows/knowledge-purge-activities';
import {
  clients,
  openAppDatabase,
  projects,
  tombstones,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { recordImportedTombstone } from '../../packages/application/src/portability-sections-import';
import { openAgentTestDatabase, seedAiTenant, type AiTenant } from '../helpers/ai/fixtures';
import { noObjects } from '../helpers/delegated-child';
import { repoRoot, urls } from '../helpers/stack';

type Kind = 'work_unit' | 'project';

/** The last statement of a migration file: its postcondition DO block, exactly as migrated. */
const postconditionOf = (file: string) =>
  readFileSync(join(repoRoot, 'packages/database/migrations', file), 'utf8')
    .split('--> statement-breakpoint')
    .at(-1)!;
const POSTCONDITION_0554 = postconditionOf('0554_record_purge_completion_r12purge.sql');
const POSTCONDITION_0555 = postconditionOf('0555_record_purge_completion_attest_r13purge.sql');

/** 0554:85-86 and 0419:2028-2029, as PostgreSQL 17 deparses them with search_path=pg_catalog. */
const deparsed = (role: 'ensemus_app' | 'ensemus_agent') =>
  `((organization_id = app.current_organization_id()) AND (CURRENT_USER = '${role}'::name) AND (SESSION_USER = '${role}'::name) AND (app.current_actor_type() = 'service'::text))`;

describe('a typed-record purge completion is written only by PostgreSQL proof (0554, 0555)', () => {
  const app = openAppDatabase(urls.app(), { max: 4 }),
    agent = openAgentTestDatabase(4),
    su = new pg.Client({ connectionString: urls.superuser() }),
    migrator = new pg.Client({ connectionString: urls.migrator() });
  beforeAll(async () => {
    await su.connect();
    await migrator.connect();
  });
  afterAll(async () => {
    await migrator.end();
    await su.end();
    await agent.close();
    await app.close();
  });

  /** The agent worker's copied-Work pass (0419's guard checks the job on the agent role). */
  const records = () =>
    createDelegatedRecordPurge({
      database: agent.db,
      accounting: createKnowledgeCallStore(agent.db, { halt: createHaltCheck() }),
      transcripts: createRunTranscriptPurge(),
    });
  /** Each record the sweep's copied-Work proof (the first step of every composite proof) was asked about. */
  const proved: string[] = [];
  /** The knowledge worker's sweep. Its file proof is fixed at zero (nothing here writes a file); the
   * completion is still written only by 0554's attestation, which proves generated files, archive files
   * and object deletions again itself, so this stub cannot make PostgreSQL record anything. */
  const knowledge = () =>
    createKnowledgePurgeActivities({
      database: app.db,
      store: noObjects,
      ingest: {} as never,
      recordWorks: {
        confirmRecordInTx: (tx, context, input) => {
          proved.push(`${input.kind}:${input.id}`);
          return confirmRecordWorkPurgeInTx(tx, context, input);
        },
      },
      derivedArtifacts: {
        purgeSource: async () => {
          throw new Error('TEST_UNUSED');
        },
        confirmInTx: async () => {
          throw new Error('TEST_UNUSED');
        },
        confirmRecordInTx: async () => ({ remaining: 0 }),
      },
    });
  const keyOf = (kind: Kind, id: string) => `${kind}:${id}`;
  const sweep = async (tenant: AiTenant) => {
    proved.length = 0;
    const claim = await knowledge().claimRecordPurgeRestarts({
      organizationId: tenant.organizationId,
    });
    return { due: claim.due.map((row) => `${row.kind}:${row.id}`), failed: claim.failed };
  };
  const listed = async (tenant: AiTenant) =>
    (
      await listRecordPurgeCandidates(app.db, createServiceContext(tenant.organizationId), {
        limit: 50,
      })
    ).map((row) => `${row.kind}:${row.id}`);
  /** Every completion stored on the record's jobs, the current restore generation, and whether
   * ai.record_purge_completed (what the sweep's candidate list uses) says the record is completed. */
  const completion = (tenant: AiTenant, kind: Kind, id: string) =>
    withTenantTx(app.db, createServiceContext(tenant.organizationId), async (tx) => {
      const result = await tx.execute<{
        stored: string[];
        generation: string;
        current: boolean;
      }>(sql`
        select coalesce(array_agg(job.completed_restore_generation::text order by job.completed_restore_generation)
            filter (where job.completed_restore_generation is not null),'{}') stored,
          ai.current_material_restore_generation()::text generation,
          ai.record_purge_completed(${kind},${id}::uuid,ai.current_material_restore_generation()) current
        from ai.record_purge_jobs job where job.record_kind=${kind} and job.record_id=${id}::uuid`);
      return result.rows[0]!;
    });
  /** The production path to a completion: the agent's pass checks the job, then the sweep's proof reads
   * completed and PostgreSQL attests it. */
  const complete = async (tenant: AiTenant, kind: Kind, id: string) => {
    const service = createServiceContext(tenant.organizationId);
    expect(await records().purgeRecord(service, { kind, id, limit: 25 })).toMatchObject({
      confirmed: true,
    });
    const claim = await sweep(tenant);
    expect(proved).toContain(keyOf(kind, id));
    expect(claim).toEqual({ due: [], failed: 0 });
    const done = await completion(tenant, kind, id);
    // An older snapshot's job may keep its own (stale) completion; the current one is at this generation.
    expect(done.current).toBe(true);
    expect(done.stored).toContain(done.generation);
    expect(await listed(tenant)).not.toContain(keyOf(kind, id));
    return done.generation;
  };
  /** The record no longer attests, is listed, and the sweep proves it again (unconfirmed, so it is due);
   * then the agent's pass and the next sweep complete it at the record's current snapshot and generation. */
  const reopenedAndReproved = async (tenant: AiTenant, kind: Kind, id: string) => {
    const key = keyOf(kind, id);
    expect((await completion(tenant, kind, id)).current).toBe(false);
    expect(await listed(tenant)).toContain(key);
    const claim = await sweep(tenant);
    expect(proved).toContain(key);
    expect(claim).toEqual({ due: [key], failed: 0 });
    await complete(tenant, kind, id);
  };
  const refusal = (attempt: Promise<unknown>) =>
    attempt.then(
      () => 'written',
      (error: unknown) => pgCode(error) ?? (error as { code?: string }).code,
    );
  /** A live Work Unit with a tombstone: a candidate (0419's snapshot reads it), as tests elsewhere seed it. */
  const tombstonedWork = async (tenant: AiTenant) => {
    const work = await createWorkUnit(app.db, tenant.owner, { title: 'Purged record' });
    await withTenantTx(app.db, tenant.owner, (tx) =>
      tx.insert(tombstones).values({
        organizationId: tenant.organizationId,
        targetType: 'work_unit',
        targetId: work.id,
        reasonCode: 'USER_DELETED',
      }),
    );
    return work.id;
  };
  const project = async (service: TenantContext) => {
    const id = randomUUID();
    await withTenantTx(app.db, service, (tx) =>
      tx.insert(projects).values({
        organizationId: service.organizationId,
        id,
        clientId: null,
        name: 'Purged project',
      }),
    );
    return id;
  };
  /** The archive import's tombstone (portability-sections-import), which also writes the closure event. */
  const importTombstone = (service: TenantContext, kind: Kind, id: string) =>
    withTenantTx(app.db, service, (tx) =>
      recordImportedTombstone(tx, service, {
        targetType: kind,
        targetId: id,
        deletedAt: new Date(),
      }),
    );
  /** The native restore's material rotation, as raw-restore-active-source-closure-completion.test.ts:150
   * and agent-material-generation.test.ts:175 drive it. Every tenant moves to a new generation. */
  const rotate = async () => {
    const prior = {
      'app.organization_id': randomUUID(),
      'app.actor_type': 'user',
      'app.membership_id': randomUUID(),
      'app.user_id': randomUUID(),
      'sovereign.material_restore_mode': 'previous',
      'sovereign.material_restore_org': randomUUID(),
      'sovereign.material_restore_generation': randomUUID(),
    };
    await migrator.query('begin');
    try {
      for (const [key, value] of Object.entries(prior))
        await migrator.query('select set_config($1,$2,true)', [key, value]);
      const rotation = await migrator.query<{ tenants: number }>(
        'select sovereign.rotate_material_restore_generation() tenants',
      );
      expect(rotation.rows[0]?.tenants).toBeGreaterThan(0);
      await migrator.query('commit');
    } catch (error) {
      await migrator.query('rollback');
      throw error;
    }
  };

  describe("0554's and 0555's postconditions, run again as the superuser (finding 1)", () => {
    type Refusal = {
      code: string | undefined;
      message: string | undefined;
      detail: string | undefined;
    } | null;
    /** Runs work as the superuser in a transaction that is always rolled back: null, or its refusal. */
    const rolledBack = async (work: () => Promise<unknown>): Promise<Refusal> => {
      await su.query('begin');
      try {
        await work();
        return null;
      } catch (error) {
        const { code, message, detail } = error as Exclude<Refusal, null>;
        return { code, message, detail };
      } finally {
        await su.query('rollback');
      }
    };
    const refused = (detail: string) => ({
      code: 'EN850',
      message: 'RECORD_PURGE_COMPLETION_ATTEST_POSTCONDITION',
      detail,
    });

    it('[0555] both hold on the migrated database, and the policies read exactly as 0554 and 0419 wrote them', async () => {
      expect(
        await rolledBack(async () => {
          await su.query(POSTCONDITION_0554);
          await su.query(POSTCONDITION_0555);
          // The postcondition puts the caller's search_path back.
          expect(
            (await su.query<{ path: string }>('select current_setting($1) path', ['search_path']))
              .rows[0]?.path,
          ).not.toBe('pg_catalog');
        }),
      ).toBeNull();
      await su.query('begin');
      try {
        await su.query("set local search_path='pg_catalog'");
        const policies = await su.query<{ name: string; qual: string; checked: string }>(
          `select p.polname::text name,pg_get_expr(p.polqual,p.polrelid) qual,pg_get_expr(p.polwithcheck,p.polrelid) checked
             from pg_policy p where p.polrelid='ai.record_purge_jobs'::regclass
              and p.polname in('record_purge_completion_attest','record_purge_worker') order by 1`,
        );
        expect(policies.rows).toEqual([
          {
            name: 'record_purge_completion_attest',
            qual: deparsed('ensemus_app'),
            checked: deparsed('ensemus_app'),
          },
          {
            name: 'record_purge_worker',
            qual: deparsed('ensemus_agent'),
            checked: deparsed('ensemus_agent'),
          },
        ]);
      } finally {
        await su.query('rollback');
      }
    });

    // [what, change, refusal DETAIL, whether 0554's postcondition still passes after it]
    it.each<[string, string, string, boolean]>([
      [
        'the attestation policy USING(true)',
        'alter policy record_purge_completion_attest on ai.record_purge_jobs using (true)',
        'ai.record_purge_jobs record_purge_completion_attest',
        true,
      ],
      [
        'the attestation policy WITH CHECK(true)',
        'alter policy record_purge_completion_attest on ai.record_purge_jobs with check (true)',
        'ai.record_purge_jobs record_purge_completion_attest',
        true,
      ],
      [
        'the attestation policy for any login (session_user dropped)',
        `alter policy record_purge_completion_attest on ai.record_purge_jobs
           using (organization_id=app.current_organization_id() and current_user='ensemus_app' and app.current_actor_type()='service')`,
        'ai.record_purge_jobs record_purge_completion_attest',
        true,
      ],
      [
        "0419's agent policy USING(true)",
        'alter policy record_purge_worker on ai.record_purge_jobs using (true)',
        'ai.record_purge_jobs record_purge_worker',
        true,
      ],
      [
        'a second permissive UPDATE policy for ensemus_app',
        'create policy r13_tamper on ai.record_purge_jobs for update to ensemus_app using (true) with check (true)',
        'ai.record_purge_jobs update policies',
        true,
      ],
      [
        'a permissive ALL policy for PUBLIC',
        'create policy r13_tamper on ai.record_purge_jobs to public using (true) with check (true)',
        'ai.record_purge_jobs update policies',
        true,
      ],
      [
        'the column grant made grantable',
        'grant update(completed_restore_generation) on ai.record_purge_jobs to ensemus_app with grant option',
        'ai.record_purge_jobs completion grants',
        true,
      ],
      [
        'a direct column grant to ensemus_agent',
        'grant update(completed_restore_generation) on ai.record_purge_jobs to ensemus_agent',
        'ai.record_purge_jobs completion grants',
        false,
      ],
      [
        'a table-level UPDATE grant to ensemus_agent',
        'grant update on ai.record_purge_jobs to ensemus_agent',
        'ai.record_purge_jobs completion grants',
        false,
      ],
    ])('[0555] refuses %s', async (_what, change, detail, passes0554) => {
      expect(
        await rolledBack(async () => {
          await su.query(POSTCONDITION_0554);
          await su.query(POSTCONDITION_0555);
          await su.query(change);
          // Where 0554's own postcondition still passes, this is exactly the gap 0555 closes.
          if (passes0554) await su.query(POSTCONDITION_0554);
          await su.query(POSTCONDITION_0555);
        }),
      ).toEqual(refused(detail));
    });
  });

  it('[0555] the agent role cannot store a completion it sends; only the proof writes one again (finding 2)', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      service = createServiceContext(tenant.organizationId);
    const id = await tombstonedWork(tenant);
    const generation = await complete(tenant, 'work_unit', id);
    const forged = randomUUID();
    // ensemus_agent holds UPDATE(completed_restore_generation) through ensemus_app (0554:87), and 0419's
    // agent policy lets it reach its tenant's job. 0554's opening branch is for ensemus_app only, so the
    // agent's write reaches 0419's own checks. Nothing else changed, so they pass, and 0554's closing
    // rewrite clears the completion: the write lands, but never with the forged value.
    expect(
      await refusal(
        withTenantTx(agent.db, service, (tx) =>
          tx.execute(sql`update ai.record_purge_jobs set completed_restore_generation=${forged}::uuid
            where record_kind='work_unit' and record_id=${id}::uuid`),
        ),
      ),
    ).toBe('written');
    expect(await completion(tenant, 'work_unit', id)).toMatchObject({ stored: [], current: false });
    // completed_at has no runtime privilege at all, on either role.
    for (const database of [agent.db, app.db])
      expect(
        await refusal(
          withTenantTx(database, service, (tx) =>
            tx.execute(sql`update ai.record_purge_jobs set completed_at=now()
              where record_kind='work_unit' and record_id=${id}::uuid`),
          ),
        ),
      ).toBe('42501');
    // The knowledge worker's own UPDATE carries a value too. 0554's attestation ignores it: the snapshot,
    // checked generation and composite proof still hold, so PostgreSQL stores its own proof's generation.
    expect(
      await refusal(
        withTenantTx(app.db, service, (tx) =>
          tx.execute(sql`update ai.record_purge_jobs set completed_restore_generation=${forged}::uuid
            where record_kind='work_unit' and record_id=${id}::uuid`),
        ),
      ),
    ).toBe('written');
    expect(await completion(tenant, 'work_unit', id)).toEqual({
      stored: [generation],
      generation,
      current: true,
    });
    // The sweep's proof completes it again, at the current generation.
    await sweep(tenant);
    expect(await completion(tenant, 'work_unit', id)).toEqual({
      stored: [generation],
      generation,
      current: true,
    });
  });

  it('[0555] a restore (a new material restore generation) reopens a completion, and the sweep proves it again (finding 3)', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const id = await tombstonedWork(tenant);
    const before = await complete(tenant, 'work_unit', id);
    await rotate();
    const after = await completion(tenant, 'work_unit', id);
    expect(after.generation).not.toBe(before);
    // The stored completion is the old generation's, so it no longer attests anything.
    expect(after).toMatchObject({ stored: [before], current: false });
    await reopenedAndReproved(tenant, 'work_unit', id);
    expect((await completion(tenant, 'work_unit', id)).stored).toEqual([after.generation]);
  });

  it("[0555] a changed record snapshot (the project's client, in the catalog) reopens a completion (finding 3)", async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      service = createServiceContext(tenant.organizationId);
    const id = await project(service);
    expect(await importTombstone(service, 'project', id)).toBe(true);
    await complete(tenant, 'project', id);
    // 0211's catalog trigger copies work.projects.client_id into the catalog row's parent_record_id, one
    // of the fields 0419's snapshot hashes. The old job keeps its completion, for a snapshot that is gone.
    const clientId = randomUUID();
    await withTenantTx(app.db, service, async (tx) => {
      await tx.insert(clients).values({
        organizationId: tenant.organizationId,
        id: clientId,
        displayName: 'New parent client',
        classification: 'internal',
        ownerMembershipId: tenant.owner.membershipId,
      });
      await tx.update(projects).set({ clientId }).where(eq(projects.id, id));
    });
    expect((await completion(tenant, 'project', id)).stored).toHaveLength(1);
    await reopenedAndReproved(tenant, 'project', id);
    // Two jobs now: the old snapshot's completion, and the current one's.
    expect((await completion(tenant, 'project', id)).stored).toHaveLength(2);
  });

  it('[0555] an added tombstone reopens a completion of a deleted record (finding 3)', async () => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' }),
      service = createServiceContext(tenant.organizationId);
    // A deleted project is dead in the catalog (0211) and has no tombstone: a candidate already.
    const id = await project(service);
    await withTenantTx(app.db, service, (tx) => tx.delete(projects).where(eq(projects.id, id)));
    expect(await listed(tenant)).toContain(keyOf('project', id));
    await complete(tenant, 'project', id);
    // An archive import then records its tombstone: 0419's snapshot hashes the tombstone too.
    expect(await importTombstone(service, 'project', id)).toBe(true);
    await reopenedAndReproved(tenant, 'project', id);
    expect((await completion(tenant, 'project', id)).stored).toHaveLength(2);
  });
});
