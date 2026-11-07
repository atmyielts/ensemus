// SOV-06 on real PostgreSQL through the dispatcher's real role, with real content in two tenants. What this
// checks is the thing the unit test cannot: that with a canary truly stored in a work title, a file name, a
// member's email and a tenant's name, none of it comes out. Temporal and the store are answered in the test,
// because whether they respond is all a report says about them.
//
// WRITTEN AND UNVERIFIED: this needs a running stack, which the code-only milestone rules do not start.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addArtifact, createWorkUnit, type ObjectStore } from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import { openDispatcherDatabase } from '@ensemus/database/dispatcher';
import { diagnosticReportSchema } from '@ensemus/sovereign/diagnostics';
import { createLogger } from '@ensemus/telemetry';
import { urls } from '../helpers/stack';
import {
  diagnosticsCommand,
  readDatabaseFacts,
  type DiagnosticSources,
} from '../../workers/workflow/src/diagnostics-command';

const CANARIES = {
  title: 'CANARY-WORK-TITLE-c41d',
  fileName: 'CANARY-FILE-NAME-c41d.pdf',
  email: 'canary-member-c41d@example.invalid',
  tenant: 'CANARY-TENANT-NAME-c41d',
  otherTenant: 'CANARY-OTHER-TENANT-c41d',
  config: 'CANARY-CONFIG-VALUE-c41d',
};

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('missing');
    return body;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async *listPages(prefix: string) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length > 0) yield keys;
  }
}

describe('collecting a report from a real database', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let dispatcher: ReturnType<typeof openDispatcherDatabase>;
  let auth: pg.Client;
  const folder = mkdtempSync(join(tmpdir(), 'diagnostics-'));

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    dispatcher = openDispatcherDatabase(urls.dispatcher());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await app?.close();
    await dispatcher?.close();
    await auth?.end();
  });

  async function newTenant(name: string, email: string): Promise<TenantContext> {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      'canary person',
      email,
    ]);
    const { organizationId } = await createOrganization(app.db, {
      userId: id,
      name,
      commercialMode: 'byom',
    });
    return resolveTenantContext(app.db, id, organizationId);
  }

  async function collect(env: NodeJS.ProcessEnv = {}) {
    const out = join(folder, randomUUID());
    const logged: string[] = [];
    const said: string[] = [];
    const sources: DiagnosticSources = {
      database: () => readDatabaseFacts(dispatcher.db),
      temporalReachable: async () => true,
      objectStoreReachable: async () => true,
      release: async () => ({ version: 'unreleased', images: [] }),
      shippedMigrations: async () => [],
    };
    const status = await diagnosticsCommand(['collect', '--out', out], {
      sources: async () => sources,
      env,
      now: () => new Date(),
      log: createLogger('diagnostics', (line) => logged.push(line)),
      say: (line) => said.push(line),
    });
    const reportText = readFileSync(join(out, 'report.json'), 'utf8');
    return {
      status,
      report: diagnosticReportSchema.parse(JSON.parse(reportText)),
      everything: [
        reportText,
        readFileSync(join(out, 'review.txt'), 'utf8'),
        logged.join('\n'),
        said.join('\n'),
      ].join('\n'),
    };
  }

  it('counts tenants and backlogs, and holds nothing from either tenant', async () => {
    const before = await readDatabaseFacts(dispatcher.db);

    const store = new MemoryStore();
    const first = await newTenant(CANARIES.tenant, CANARIES.email);
    const work = await createWorkUnit(app.db, first, { title: CANARIES.title });
    await addArtifact(app.db, store, first, {
      workUnitId: work.id,
      name: CANARIES.fileName,
      mimeType: 'application/pdf',
      body: Buffer.from(CANARIES.title),
    });
    const second = await newTenant(CANARIES.otherTenant, `other-${randomUUID()}@example.invalid`);
    await createWorkUnit(app.db, second, { title: CANARIES.title });

    const { status, report, everything } = await collect({ TEMPORAL_NAMESPACE: CANARIES.config });
    expect(status).toBe(0);
    expect(report.database.reachable).toBe(true);
    expect(report.database.tenants).toBe(before.tenants + 2);
    expect(report.outbox.queued).toBeGreaterThanOrEqual(1);

    for (const canary of Object.values(CANARIES)) expect(everything).not.toContain(canary);
    for (const id of [first.organizationId, second.organizationId, work.id]) {
      expect(everything).not.toContain(id);
    }
  });

  it('counts a dead event by its type, with nothing else about it', async () => {
    const context = await newTenant(`Dead ${randomUUID()}`, `dead-${randomUUID()}@example.invalid`);
    await createWorkUnit(app.db, context, { title: CANARIES.title });
    const su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    try {
      await su.query(
        `UPDATE platform.outbox_events SET state = 'dead' WHERE organization_id = $1`,
        [context.organizationId],
      );
    } finally {
      await su.end();
    }
    const { report, everything } = await collect();
    expect(report.outbox.dead).toBeGreaterThanOrEqual(1);
    expect(report.error_codes.some(({ code }) => code.startsWith('outbox.dead:'))).toBe(true);
    expect(everything).not.toContain(CANARIES.title);
    expect(everything).not.toContain(context.organizationId);
  });

  it('holds the dispatcher role to what it is meant to see', async () => {
    const role = new pg.Client({ connectionString: urls.dispatcher() });
    await role.connect();
    try {
      // Why a report through this role can hold no content: it cannot read any.
      await expect(role.query('select title from work.work_units limit 1')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(role.query('select email from identity.users limit 1')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await role.end();
    }
  });

  it('answers null for the last migration until that role is granted a look, and does not fail', async () => {
    const facts = await readDatabaseFacts(dispatcher.db);
    // The integrator's grant would change this to a number. Either is an answer, and neither is a failure.
    expect(facts.lastMigrationAt === null || typeof facts.lastMigrationAt === 'number').toBe(true);
  });
});
