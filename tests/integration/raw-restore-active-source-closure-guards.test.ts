// The refusals 0551 adds for an ACTIVE Knowledge source a restore left in raw debt (check findings
// 2-5 of CI repair round 10), against real RLS and the real fixed functions. FLAGGED FOR HUMAN
// SECURITY REVIEW, not yet reviewed by a person. raw-restore-active-source-closure.test.ts drives the
// positive paths; this file proves each guard answers no, one condition at a time:
//   - finding 2: capture_raw_source_inventory's closed-debt branch (0551 lines 315-348);
//   - finding 3: raw_document_writers_ready through raw_active_closure_document_ready (224-262);
//   - finding 4: record_raw_restore_active_source_closure (355-435);
//   - finding 5: raw_active_source_closable, the revoke transition's question (189-202).
// Every fixture reaches its state through the production path (native upload, ingest, the native
// restore's material rotation, 0545's and 0550's requalifications, revoke). Each negative then
// changes exactly one fact inside ONE superuser transaction that is always rolled back: the
// change is written with triggers off (session_replication_role=replica, the convention of
// raw-restore-requalify.test.ts and restore-reconcile.test.ts) because most of these states are
// ones the guarded writers never produce, and the guard is then asked under the real login it
// serves (SET LOCAL SESSION AUTHORIZATION ensemus_app with a service actor for the SECURITY DEFINER
// entry points, the fixed migrator role inside the raw metadata scope for the predicates). Every
// negative has a baseline asked the same way that answers yes, so each refusal is the guard's own.
// The material restore generation is rotated globally: this file runs serially, as the whole
// integration project does (fileParallelism: false). Storage is an explicit memory test double.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  requalifyRawRestoreActiveSource,
  requalifyRawRestoreOrganization,
  type ObjectStore,
} from '@ensemus/application';
import { ingestDocument, type IngestDeps } from '@ensemus/application/knowledge/ingest';
import { revokeSource } from '@ensemus/application/knowledge/purge';
import { addUploadedSource, getSource } from '@ensemus/application/knowledge/sources';
import { openAppDatabase, type TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { knowledgeObjectKey } from '@ensemus/domain/knowledge';
import { parseDocument } from '@ensemus/knowledge/parsing';
import { seedAiTenant } from '../helpers/ai/fixtures';
import { nativeKnowledgeStore } from '../helpers/knowledge-native';
import { urls } from '../helpers/stack';

/** A memory bucket with the single-attempt and physical-absence capabilities the runtime store has. */
class Bucket implements ObjectStore {
  objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, Buffer.from(body));
  }
  async putSingleAttempt(key: string, body: Buffer): Promise<{ transport: 'written' }> {
    this.objects.set(key, Buffer.from(body));
    return { transport: 'written' };
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('MISSING');
    return Buffer.from(bytes);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deleteForPurge(key: string): Promise<{ transport: 'deleted'; capabilityVerified: true }> {
    this.objects.delete(key);
    return { transport: 'deleted', capabilityVerified: true };
  }
  async isPhysicallyAbsent(key: string) {
    return !this.objects.has(key);
  }
}

type Active = {
  bucket: Bucket;
  owner: TenantContext;
  service: TenantContext;
  organizationId: string;
  sourceId: string;
  documentId: string;
  key: string;
  /** The tenant's current material restore generation, read after the rotation. */
  material: string;
};
type Closed = Active & { purgeJobId: string; version: string };

/** One SQL statement and its parameters. */
type Step = readonly [text: string, values?: unknown[]];
/** What the guard answered: its rows, or the refusal it raised. */
type Outcome =
  { rows: pg.QueryResultRow[] } | { code: string | undefined; reason: string | undefined };

/** 0422's single auth restore control row (identity.auth_restore_control). */
const AUTH_RESTORE_CONTROL = '68766d8e-9f7d-4b87-b881-bb4c3ff1654b';

const ingestDeps: IngestDeps = {
  parse: async (body, type) => parseDocument(body, type),
  contentScan: { scan: () => ({ raiseTo: null, codes: [] }) },
};

describe("0551's closure guards refuse each condition (check findings 2-5)", () => {
  let app: ReturnType<typeof openAppDatabase>, migrator: pg.Client, control: pg.Client;
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    migrator = new pg.Client({ connectionString: urls.migrator() });
    control = new pg.Client({ connectionString: urls.superuser() });
    await migrator.connect();
    await control.connect();
  });
  afterAll(async () => {
    await migrator?.end();
    await control?.end();
    await app?.close();
  });

  /** The native restore's material rotation, exactly as raw-restore-active-source-closure.test.ts drives it. */
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

  /**
   * Changes the given facts with triggers off, then asks the guard as `as` would, all inside one
   * superuser transaction that is always rolled back: nothing a scenario changes is ever kept.
   */
  const scenario = async (
    organizationId: string,
    perturb: Step[],
    as: 'service' | 'migrator',
    statements: Step[],
  ): Promise<Outcome> => {
    await control.query('begin');
    try {
      await control.query("set local session_replication_role='replica'");
      for (const [text, values] of perturb) await control.query(text, values);
      await control.query("set local session_replication_role='origin'");
      if (as === 'service') {
        // The real runtime login, with no person behind it, as withTenantTx binds a service context.
        await control.query('set local session authorization ensemus_app');
        await control.query(
          `select set_config('app.organization_id',$1,true),set_config('app.user_id','',true),
            set_config('app.membership_id','',true),set_config('app.actor_type','service',true),
            set_config('lifecycle.raw_object_org','',true)`,
          [organizationId],
        );
      } else {
        // The fixed functions read these predicates as their migrator owner inside the raw scope.
        await control.query('set local role ensemus_migrator');
        await control.query(
          "select set_config('app.organization_id',$1,true),set_config('lifecycle.raw_object_org',$1,true)",
          [organizationId],
        );
      }
      let rows: pg.QueryResultRow[] = [];
      try {
        for (const [text, values] of statements) rows = (await control.query(text, values)).rows;
      } catch (error) {
        const { code, message } = error as { code?: string; message?: string };
        return { code, reason: message };
      }
      return { rows };
    } finally {
      await control.query('rollback');
    }
  };

  /** A write of `f`'s document, cloned from its generation-0 catalog row with the given facts. */
  const write = (
    f: Active,
    fields: {
      generation: number;
      state: 'intent' | 'unknown' | 'not_dispatched';
      writeId?: string;
      sourceId?: string;
      material?: string;
      auth?: string;
    },
  ): Step => [
    `insert into lifecycle.raw_object_writes(organization_id,source_id,document_id,write_id,generation,object_key,
      content_sha256,size_bytes,material_restore_generation,state,put_token_sha256,put_auth_restore_generation,admitted_at,finished_at)
     select c.organization_id,$3::uuid,c.document_id,$4::uuid,$5::bigint,c.object_key,c.content_sha256,c.size_bytes,$6::uuid,$7::text,
      case when $7::text='unknown' then repeat('a',64) end,$8::uuid,
      case when $7::text='unknown' then now() end,case when $7::text='not_dispatched' then now() end
     from lifecycle.raw_object_writes c where c.organization_id=$1::uuid and c.document_id=$2::uuid and c.generation=0`,
    [
      f.organizationId,
      f.documentId,
      fields.sourceId ?? f.sourceId,
      fields.writeId ?? randomUUID(),
      fields.generation,
      fields.material ?? f.material,
      fields.state,
      fields.auth ?? auth,
    ],
  ];
  /** `f`'s document's one writer header (PK organization, document), replaced by the given one. */
  const header = (
    f: Active,
    fields: { generation: number; writeId: string; state: 'active' | 'settled' },
  ): Step[] => [
    [
      'delete from knowledge.object_writers where organization_id=$1::uuid and document_id=$2::uuid',
      [f.organizationId, f.documentId],
    ],
    [
      `insert into knowledge.object_writers(organization_id,document_id,source_id,generation,write_id,state)
       values($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5::uuid,$6::text)`,
      [f.organizationId, f.documentId, f.sourceId, fields.generation, fields.writeId, fields.state],
    ],
  ];
  const inventoryChange = (f: Active, assignments: string, values: unknown[] = []): Step => [
    `update lifecycle.raw_source_inventories set ${assignments}
     where organization_id=$1::uuid and scope_kind='source' and source_id=$2::uuid`,
    [f.organizationId, f.sourceId, ...values],
  ];

  /** An open source with one raw object, uploaded natively and ingested before the restore. */
  const prepare = async (title: string): Promise<Active> => {
    const tenant = await seedAiTenant(app.db, { commercialMode: 'sovereign' });
    const bucket = new Bucket();
    const store = nativeKnowledgeStore(app.db, bucket);
    const source = await addUploadedSource(app.db, store, tenant.owner, {
      title,
      mediaType: 'text/plain',
      body: Buffer.from(`Generated ${title}.`),
      classification: 'internal',
      grants: [],
    });
    const key = knowledgeObjectKey(tenant.organizationId, source.documentId);
    expect(bucket.objects.has(key)).toBe(true);
    const service = createServiceContext(tenant.organizationId);
    expect(
      await ingestDocument(app.db, store, service, ingestDeps, { documentId: source.documentId }),
    ).toMatchObject({ outcome: 'searchable' });
    return {
      bucket,
      owner: tenant.owner,
      service,
      organizationId: tenant.organizationId,
      sourceId: source.sourceId,
      documentId: source.documentId,
      key,
      material: '',
    };
  };
  const currentMaterial = async (f: Active) =>
    (
      await control.query<{ material: string }>(
        'select material_restore_generation::text material from org.organizations where id=$1',
        [f.organizationId],
      )
    ).rows[0]!.material;

  // A: requalified by 0550, then revoked, so it is closed active-source debt (not yet purged).
  // M: active restore debt whose object is missing, its organization marker requalified (0545).
  // U: active restore debt in a tenant whose organization marker was never requalified.
  let a: Closed, m: Active, u: Active, auth: string;

  it('prepares closed active-source debt, active debt with a missing object and an unmarked tenant', async () => {
    const closing = await prepare('closed active-source debt');
    m = await prepare('missing object');
    u = await prepare('unmarked tenant');
    await rotate();
    auth = (
      await control.query<{ auth: string }>(
        'select app.current_auth_restore_generation()::text auth',
      )
    ).rows[0]!.auth;
    for (const f of [closing, m]) {
      expect(await requalifyRawRestoreOrganization(app.db, f.service)).toEqual({
        state: 'requalified',
      });
      f.material = await currentMaterial(f);
    }
    u.material = await currentMaterial(u);
    expect(
      await requalifyRawRestoreActiveSource(
        app.db,
        closing.bucket,
        closing.service,
        closing.sourceId,
      ),
    ).toEqual({ state: 'requalified', observed: 'present' });
    const { purgeJobId } = await revokeSource(app.db, closing.owner, {
      sourceId: closing.sourceId,
      expectedVersion: (await getSource(app.db, closing.owner, closing.sourceId)).version,
      reason: 'Generated closure after a restore',
    });
    const kept = (
      await control.query<{
        state: string;
        sealed: boolean;
        job: string;
        version: string;
        current: string;
      }>(
        `select i.state,i.sealed_at is not null as sealed,i.purge_job_id::text as job,
          i.source_version::text as version,s.version::text as current
         from lifecycle.raw_source_inventories i join knowledge.sources s
          on s.organization_id=i.organization_id and s.id=i.source_id
         where i.organization_id=$1 and i.scope_kind='source' and i.source_id=$2`,
        [closing.organizationId, closing.sourceId],
      )
    ).rows[0]!;
    // 0551's revoke transition kept the inventory restore debt, at this job and source version.
    expect(kept).toEqual({
      state: 'restore_debt',
      sealed: false,
      job: purgeJobId,
      version: kept.current,
      current: kept.current,
    });
    a = { ...closing, purgeJobId, version: kept.version };
    m.bucket.objects.delete(m.key);
  });

  describe('raw_active_source_closable, the revoke transition (finding 5)', () => {
    /** The moment the purge job is born: the inventory not yet bound to it. */
    const unbound = () => inventoryChange(a, 'purge_job_id=null,source_version=null');
    const closable = (perturb: Step[]) =>
      scenario(a.organizationId, perturb, 'migrator', [
        [
          'select lifecycle.raw_active_source_closable($1::uuid,$2::uuid,$3::uuid) as closable',
          [a.sourceId, a.purgeJobId, a.material],
        ],
      ]);

    it('answers yes for the closed source, its one purge job and a proof of this generation', async () => {
      expect(await closable([unbound()])).toEqual({ rows: [{ closable: true }] });
    });

    it('refuses while another purge job of the source exists', async () => {
      // knowledge_purge_jobs_source (0200) makes a second job unreachable today; the predicate must
      // not rely on it, so the constraint is lifted only inside this rolled-back transaction.
      expect(
        await closable([
          unbound(),
          ['alter table knowledge.purge_jobs drop constraint knowledge_purge_jobs_source'],
          [
            `insert into knowledge.purge_jobs
             select (jsonb_populate_record(j,jsonb_build_object('id',gen_random_uuid()))).*
             from knowledge.purge_jobs j where j.organization_id=$1::uuid and j.id=$2::uuid`,
            [a.organizationId, a.purgeJobId],
          ],
        ]),
      ).toEqual({ rows: [{ closable: false }] });
    });

    it('refuses when the only proof is pinned to another material generation', async () => {
      expect(
        await closable([
          unbound(),
          [
            `update lifecycle.raw_active_source_requalifications set material_restore_generation=gen_random_uuid()
             where organization_id=$1::uuid and source_id=$2::uuid`,
            [a.organizationId, a.sourceId],
          ],
        ]),
      ).toEqual({ rows: [{ closable: false }] });
    });
  });

  describe('raw_document_writers_ready for closed active-source debt (finding 3)', () => {
    const ready = (perturb: Step[]) =>
      scenario(a.organizationId, perturb, 'migrator', [
        [
          `select lifecycle.raw_document_writers_ready($1::uuid,$2::uuid,$3::uuid) as ready,
            lifecycle.raw_active_closure_document_ready($1::uuid,$2::uuid,$3::uuid) as closure,
            lifecycle.raw_document_writers_ready_before_active_closure($1::uuid,$2::uuid,$3::uuid) as earlier`,
          [a.documentId, a.material, auth],
        ],
      ]);
    // 0516's own readiness needs a sealed inventory of this generation, so it never answers here.
    const yes = { rows: [{ ready: true, closure: true, earlier: false }] };
    const no = { rows: [{ ready: false, closure: false, earlier: false }] };

    it('answers yes for the catalogued document, also with a settled writer of this generation', async () => {
      expect(await ready([])).toEqual(yes);
      const writeId = randomUUID();
      expect(
        await ready([
          write(a, { generation: 97, state: 'not_dispatched', writeId }),
          ...header(a, { generation: 97, writeId, state: 'settled' }),
        ]),
      ).toEqual(yes);
    });

    it('refuses a document another source also wrote', async () => {
      expect(
        await ready([
          write(a, { generation: 97, state: 'not_dispatched', sourceId: randomUUID() }),
        ]),
      ).toEqual(no);
    });

    it('refuses an unsettled writer header, and a settled one whose write is not concluded', async () => {
      const active = randomUUID();
      expect(
        await ready([
          write(a, { generation: 97, state: 'not_dispatched', writeId: active }),
          ...header(a, { generation: 97, writeId: active, state: 'active' }),
        ]),
      ).toEqual(no);
      const intent = randomUUID();
      expect(
        await ready([
          write(a, { generation: 97, state: 'intent', writeId: intent }),
          ...header(a, { generation: 97, writeId: intent, state: 'settled' }),
        ]),
      ).toEqual(no);
      // A settled header with no write behind it at all: the header clause alone refuses.
      expect(
        await ready([...header(a, { generation: 97, writeId: randomUUID(), state: 'settled' })]),
      ).toEqual(no);
    });

    it('refuses an unconcluded write of a later generation', async () => {
      for (const state of ['intent', 'unknown'] as const)
        expect(await ready([write(a, { generation: 97, state })])).toEqual(no);
    });

    it('refuses a write of this material generation under another auth generation', async () => {
      expect(
        await ready([write(a, { generation: 97, state: 'not_dispatched', auth: randomUUID() })]),
      ).toEqual(no);
    });
  });

  describe("capture_raw_source_inventory's closed-debt branch (finding 2)", () => {
    const capture = (perturb: Step[]) =>
      scenario(a.organizationId, perturb, 'service', [
        [
          'select more from lifecycle.capture_raw_source_inventory($1::uuid,$2::bigint,$3::uuid)',
          [a.sourceId, a.version, a.purgeJobId],
        ],
      ]);
    const refused = (reason: string) => ({ code: 'EN850', reason });
    /**
     * 0515's hold predicate answering yes. It already requires the source closed at this version
     * and this purge job, so 0551's re-check of those facts after the inventory lock (lines
     * 333-337) is reachable only with it stubbed, inside the rolled-back transaction.
     */
    const holdFree: Step = [
      `create or replace function lifecycle.source_projection_hold_free(p_source uuid,p_version bigint,p_job uuid)
       returns boolean language sql security definer set search_path=pg_catalog as $$ select true $$`,
    ];

    it('captures nothing and answers that nothing more is to be captured', async () => {
      expect(await capture([])).toEqual({ rows: [{ more: false }] });
      // The stub alone changes nothing.
      expect(await capture([holdFree])).toEqual({ rows: [{ more: false }] });
    });

    it('refuses while a hold is active: RAW_SOURCE_HOLD_UNCONFIRMED', async () => {
      expect(
        await capture([
          [
            `insert into lifecycle.legal_holds(organization_id,id,matter_ref,placed_by_membership_id)
             values($1::uuid,gen_random_uuid(),$2,$3::uuid)`,
            [a.organizationId, randomUUID(), a.owner.membershipId],
          ],
        ]),
      ).toEqual(refused('RAW_SOURCE_HOLD_UNCONFIRMED'));
    });

    it('refuses a source version or purge job mismatch: RAW_LEGACY_INVENTORY_UNCONFIRMED', async () => {
      // The inventory bound to another version or job is not closed debt for this call, so 0516's
      // capture answers, and refuses the restore-debt inventory with the same code.
      expect(await capture([inventoryChange(a, 'source_version=source_version+1')])).toEqual(
        refused('RAW_LEGACY_INVENTORY_UNCONFIRMED'),
      );
      expect(await capture([inventoryChange(a, 'purge_job_id=gen_random_uuid()')])).toEqual(
        refused('RAW_LEGACY_INVENTORY_UNCONFIRMED'),
      );
      // The source moved past the inventory's version, or the job is gone: 0515's hold refuses
      // first, and with it answering yes 0551's own re-check refuses.
      const moved: Step = [
        'update knowledge.sources set version=version+1 where organization_id=$1::uuid and id=$2::uuid',
        [a.organizationId, a.sourceId],
      ];
      const gone: Step = [
        'update knowledge.purge_jobs set id=gen_random_uuid() where organization_id=$1::uuid and id=$2::uuid',
        [a.organizationId, a.purgeJobId],
      ];
      for (const change of [moved, gone]) {
        expect(await capture([change])).toEqual(refused('RAW_SOURCE_HOLD_UNCONFIRMED'));
        expect(await capture([holdFree, change])).toEqual(
          refused('RAW_LEGACY_INVENTORY_UNCONFIRMED'),
        );
      }
    });

    it('refuses when the organization admission is not granted: RAW_LEGACY_INVENTORY_UNCONFIRMED', async () => {
      // The proof that makes the debt closed needs the marker requalified at protocol 1, which is
      // itself an admission (0545), so without it the source is not closed debt and 0516 refuses.
      expect(
        await capture([
          [
            'delete from lifecycle.raw_org_restore_requalifications where organization_id=$1::uuid',
            [a.organizationId],
          ],
        ]),
      ).toEqual(refused('RAW_LEGACY_INVENTORY_UNCONFIRMED'));
    });

    it('refuses an uncatalogued document or writer header: RAW_INVENTORY_INCOMPLETE', async () => {
      expect(
        await capture([
          [
            'update knowledge.documents set size_bytes=size_bytes+1 where organization_id=$1::uuid and id=$2::uuid',
            [a.organizationId, a.documentId],
          ],
        ]),
      ).toEqual(refused('RAW_INVENTORY_INCOMPLETE'));
      expect(
        await capture(header(a, { generation: 97, writeId: randomUUID(), state: 'settled' })),
      ).toEqual(refused('RAW_INVENTORY_INCOMPLETE'));
    });
  });

  describe('record_raw_restore_active_source_closure (finding 4)', () => {
    const absent = (f: Active): Step => [
      `select lifecycle.record_raw_restore_active_source_closure($1::uuid,$2::uuid[],$3::text[],$4::bigint[],$5::uuid[])
        as recorded`,
      [f.sourceId, [], [], [], [f.documentId]],
    ];
    const changed = (f: Active): Step => [
      `select lifecycle.record_raw_restore_active_source_closure($1::uuid,$2::uuid[],$3::text[],$4::bigint[],$5::uuid[])
        as recorded`,
      [f.sourceId, [f.documentId], ['b'.repeat(64)], [1], []],
    ];
    const observe = (f: Active, perturb: Step[], statements: Step[] = [absent(f)]) =>
      scenario(f.organizationId, perturb, 'service', statements);
    const recorded = { rows: [{ recorded: 'recorded' }] };
    const refused = (reason: string) => ({ code: 'EN850', reason });
    const claim = (state: 'admitted' | 'proven'): Step => [
      `insert into lifecycle.object_deletion_claims(organization_id,kind,artifact_id,raw_source_id,raw_source_version,
        raw_purge_job_id,raw_document_id,writer_token,generation,object_key,sha256,state,material_restore_generation,
        auth_restore_generation,terminal_at,absent_at)
       select c.organization_id,'raw_source',null,c.source_id,1,gen_random_uuid(),c.document_id,c.write_id,0,c.object_key,
        c.content_sha256,$3::text,$4::uuid,$5::uuid,case when $3::text='proven' then now() end,
        case when $3::text='proven' then now() end
       from lifecycle.raw_object_writes c where c.organization_id=$1::uuid and c.document_id=$2::uuid and c.generation=0`,
      [m.organizationId, m.documentId, state, m.material, auth],
    ];

    it('records the missing object once, and the same observation again', async () => {
      expect(await observe(m, [])).toEqual(recorded);
      expect(await observe(m, [], [absent(m), absent(m)])).toEqual(recorded);
      // A proven deletion claim is resolved, and a concluded writer settled.
      const writeId = randomUUID();
      expect(
        await observe(m, [
          claim('proven'),
          write(m, { generation: 97, state: 'not_dispatched', writeId }),
          ...header(m, { generation: 97, writeId, state: 'settled' }),
        ]),
      ).toEqual(recorded);
    });

    it('refuses before the restore is admitted: RESTORE_PENDING', async () => {
      expect(
        await observe(m, [
          [
            `update identity.verifications set value=jsonb_set(value::jsonb,'{phase}','"pending"')::text
             where id=$1::uuid and identifier='ensemus-auth-restore:v1'`,
            [AUTH_RESTORE_CONTROL],
          ],
        ]),
      ).toEqual({ code: 'EN422', reason: 'RESTORE_PENDING' });
    });

    it('refuses a tenant whose organization marker was not requalified', async () => {
      expect(await observe(u, [])).toEqual(refused('RAW_ORG_RESTORE_REQUALIFICATION_REQUIRED'));
    });

    it('refuses anything but never-sealed, never-closed debt of an earlier generation: RAW_RESTORE_DEBT_REQUIRED', async () => {
      for (const change of [
        inventoryChange(m, 'purge_job_id=gen_random_uuid()'),
        inventoryChange(m, 'sealed_at=clock_timestamp()'),
        inventoryChange(m, 'material_restore_generation=$3::uuid', [m.material]),
      ])
        expect(await observe(m, [change])).toEqual(refused('RAW_RESTORE_DEBT_REQUIRED'));
    });

    it('refuses unconcluded writes, unsettled writers and unresolved deletion claims', async () => {
      const unconfirmed = refused('RAW_ACTIVE_RESTORE_CLOSURE_UNCONFIRMED');
      for (const state of ['intent', 'unknown'] as const)
        expect(await observe(m, [write(m, { generation: 97, state })])).toEqual(unconfirmed);
      const writeId = randomUUID();
      expect(
        await observe(m, [
          write(m, { generation: 97, state: 'not_dispatched', writeId }),
          ...header(m, { generation: 97, writeId, state: 'active' }),
        ]),
      ).toEqual(unconfirmed);
      expect(await observe(m, [claim('admitted')])).toEqual(unconfirmed);
    });

    it('refuses a repeat observation that differs from the recorded one', async () => {
      expect(await observe(m, [], [absent(m), changed(m)])).toEqual(
        refused('RAW_ACTIVE_RESTORE_CLOSURE_UNCONFIRMED'),
      );
      expect(await observe(m, [], [changed(m), absent(m)])).toEqual(
        refused('RAW_ACTIVE_RESTORE_CLOSURE_UNCONFIRMED'),
      );
    });

    it('left nothing recorded behind', async () => {
      const kept = await control.query(
        'select 1 from lifecycle.raw_active_source_closure_observations where organization_id=$1',
        [m.organizationId],
      );
      expect(kept.rows).toEqual([]);
    });
  });
});
