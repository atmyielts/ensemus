// The measurements the M2 exit criteria ask for: what tenant isolation costs per transaction, and how
// long the outbox takes to deliver. Needs the running stack, and writes what it saw to
// docs/06-delivery/evidence/M2-measurements.json:
//   pnpm stack:secrets && docker compose ... up -d --build --wait && pnpm measure:m2
// These are numbers from one machine, not a capacity claim. Read the differences, not the absolutes.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createWorkUnit, requestExecution, transitionWorkUnit } from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { repoRoot, urls } from '../helpers/stack';

const ROWS_PER_TENANT = 5_000;
const OTHER_TENANTS = 5;
const SAMPLES = 1_000;
const WARMUP = 100;

function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

function summarize(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    samples: sorted.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

const elapsed = (from: bigint) => Number(process.hrtime.bigint() - from) / 1e6;

/** Runs the cases in turn, one sample each, so drift over the run lands on all of them equally. */
async function compare(cases: Record<string, () => Promise<unknown>>) {
  const names = Object.keys(cases);
  const samples = Object.fromEntries(names.map((name) => [name, [] as number[]]));
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    for (const name of names) {
      const started = process.hrtime.bigint();
      await cases[name]!();
      if (i >= WARMUP) samples[name]!.push(elapsed(started));
    }
  }
  return Object.fromEntries(names.map((name) => [name, summarize(samples[name]!)]));
}

describe('M2 measurements', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let su: pg.Pool;
  let raw: pg.Pool;
  let context: TenantContext;
  let targetId: string;
  const results: Record<string, unknown> = {};

  async function newTenant(name: string) {
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      name,
      `${userId}@example.invalid`,
    ]);
    await auth.end();
    const { organizationId } = await createOrganization(app.db, {
      userId,
      name,
      commercialMode: 'sovereign',
    });
    return resolveTenantContext(app.db, userId, organizationId);
  }

  async function seed(tenant: TenantContext) {
    await su.query(
      `insert into work.work_units (organization_id, owner_membership_id, title, classification)
       select $1, $2, 'seed ' || n, 'internal' from generate_series(1, $3::int) n`,
      [tenant.organizationId, tenant.membershipId, ROWS_PER_TENANT],
    );
  }

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    su = new pg.Pool({ connectionString: urls.superuser(), max: 2 });
    raw = new pg.Pool({ connectionString: urls.app(), max: 2 });
    context = await newTenant('Measured');
    await seed(context);
    for (let i = 0; i < OTHER_TENANTS; i++) await seed(await newTenant(`Other ${i}`));
    await su.query('analyze work.work_units');
    const { rows } = await su.query(
      'select id from work.work_units where organization_id = $1 limit 1',
      [context.organizationId],
    );
    targetId = rows[0].id;
  }, 300_000);

  afterAll(async () => {
    writeFileSync(
      join(repoRoot, 'docs/06-delivery/evidence/M2-measurements.json'),
      `${JSON.stringify(
        {
          note: 'One developer machine, through a port published by Docker Desktop. Compare the cases; do not read the absolute numbers as capacity.',
          cpus: cpus().length,
          platform: process.platform,
          rowsPerTenant: ROWS_PER_TENANT,
          tenants: OTHER_TENANTS + 1,
          ...results,
        },
        null,
        2,
      )}\n`,
    );
    await app?.close();
    await su?.end();
    await raw?.end();
  });

  it('what tenant isolation costs per transaction', async () => {
    const organizationId = context.organizationId;
    const byId = 'select * from work.work_units where organization_id = $1 and id = $2';
    const page =
      'select * from work.work_units where organization_id = $1 order by updated_at desc limit 50';

    /** One transaction on one connection, with or without binding the tenant first. */
    async function inTransaction(
      pool: pg.Pool,
      bind: boolean,
      text: string,
      values: unknown[],
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        if (bind) {
          await client.query(
            `select set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)`,
            [organizationId, context.userId],
          );
        }
        await client.query(text, values);
        await client.query('commit');
      } finally {
        client.release();
      }
    }

    results.readOneRow = await compare({
      // Bypasses row-level security, so the difference from the next case is the isolation itself.
      baselineNoIsolation: () => inTransaction(su, false, byId, [organizationId, targetId]),
      withIsolation: () => inTransaction(raw, true, byId, [organizationId, targetId]),
      withTenantTxAndOrm: () =>
        withTenantTx(app.db, context, (tx) =>
          tx.execute(
            sql`select * from work.work_units where organization_id = ${organizationId} and id = ${targetId}`,
          ),
        ),
    });
    results.readPageOf50 = await compare({
      baselineNoIsolation: () => inTransaction(su, false, page, [organizationId]),
      withIsolation: () => inTransaction(raw, true, page, [organizationId]),
    });
  }, 600_000);

  /** Polls until every event has been delivered, and returns the delay of each from `started`. */
  async function waitForDelivery(ids: string[], started: bigint[]): Promise<number[]> {
    const delays = new Array<number>(ids.length).fill(-1);
    const deadline = Date.now() + 180_000;
    while (delays.includes(-1)) {
      if (Date.now() > deadline) throw new Error('events were not delivered in time');
      const { rows } = await su.query(
        `select e.aggregate_id from platform.outbox_events o
           join platform.domain_events e on e.organization_id = o.organization_id and e.id = o.event_id
          where o.state = 'published' and e.aggregate_id = any($1::uuid[])
            and e.event_type = 'work.execution_requested'`,
        [ids],
      );
      const now = process.hrtime.bigint();
      for (const { aggregate_id: id } of rows) {
        const index = ids.indexOf(id);
        if (delays[index] === -1) delays[index] = Number(now - started[index]!) / 1e6;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    return delays;
  }

  async function readyToRun() {
    const unit = await createWorkUnit(app.db, context, {
      title: 'measured',
      executionPlan: 'checklist',
    });
    await transitionWorkUnit(app.db, context, { id: unit.id, expectedVersion: 1, to: 'ready' });
    return unit.id;
  }

  async function request(id: string) {
    const started = process.hrtime.bigint();
    await requestExecution(app.db, context, id);
    return started;
  }

  it('how long the outbox takes to deliver', async () => {
    const idle: number[] = [];
    for (let i = 0; i < 30; i++) {
      const id = await readyToRun();
      const started = await request(id);
      const [delay] = await waitForDelivery([id], [started]);
      idle.push(delay!);
      // Lands at a different point in the dispatcher's idle wait each time.
      await new Promise((done) => setTimeout(done, 700 + i * 37));
    }
    results.dispatcherDelayIdle = summarize(idle);

    // All at once, so a backlog really forms, and polled from the moment they are all in.
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(await readyToRun());
    const burstStarted = process.hrtime.bigint();
    const started = await Promise.all(ids.map(request));
    const delays = await waitForDelivery(ids, started);
    results.dispatcherDelayBurstOf200 = {
      ...summarize(delays),
      eventsPerSecond: Math.round(ids.length / (elapsed(burstStarted) / 1000)),
    };
  }, 600_000);
});
