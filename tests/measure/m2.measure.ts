// The measurements the M2 exit criteria ask for: what tenant isolation costs per transaction, how long
// the outbox takes to deliver, and what status streams cost (ADR-024). Needs the running stack, and
// writes what it saw to
// docs/06-delivery/evidence/M2-measurements.json:
//   pnpm stack:secrets && docker compose ... up -d --build --wait && pnpm measure:m2
// These are numbers from one machine, not a capacity claim. Read the differences, not the absolutes.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  createWorkUnit,
  requestExecution,
  transitionWorkUnit,
  updateWorkUnit,
} from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createOrganization as createOrganizationPage, signUp, visit } from '../helpers/forms';
import { compose, repoRoot, urls } from '../helpers/stack';
import { eventsPath, openStreams, type Stream } from '../helpers/streams';

const ROWS_PER_TENANT = 5_000;
const OTHER_TENANTS = 5;
const SAMPLES = 1_000;
const WARMUP = 100;
const STREAM_COUNTS = [50, 200];
/** How long each size runs with nothing changing, to see what simply keeping streams open costs. */
const IDLE_SAMPLE_MS = 30_000;
const CHANGE_ROUNDS = 15;
const CHANGES_PER_ROUND = 20;
const PAGE_SAMPLES = 30;

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

  /** Database work by the roles a status stream uses, counted by PostgreSQL itself. */
  async function databaseWork() {
    const statements = await su.query(
      `select coalesce(sum(s.calls), 0)::bigint as calls from pg_stat_statements s
       join pg_roles r on r.oid = s.userid
       where r.rolname in ('ensemus_app', 'ensemus_auth')`,
    );
    const transactions = await su.query(
      `select xact_commit + xact_rollback as count from pg_stat_database where datname = 'ensemus'`,
    );
    return {
      statements: Number(statements.rows[0].calls),
      transactions: Number(transactions.rows[0].count),
    };
  }

  /** What Docker says each container is using right now. */
  function containerUse(service: string) {
    const output = execFileSync(
      'docker',
      [
        'stats',
        '--no-stream',
        '--format',
        '{{.CPUPerc}}|{{.MemUsage}}',
        compose('ps', '-q', service).trim(),
      ],
      { encoding: 'utf8' },
    ).trim();
    const [cpu, memory] = output.split('|');
    return { cpuPercent: Number.parseFloat(cpu ?? '0'), memory: memory?.split(' / ')[0] };
  }

  /** What the same stack does over a stretch of time, per second and per stream. */
  async function idleCost(streamCount: number) {
    const started = await databaseWork();
    const from = Date.now();
    await new Promise((done) => setTimeout(done, IDLE_SAMPLE_MS));
    const ended = await databaseWork();
    const seconds = (Date.now() - from) / 1000;
    const statementsPerSecond = (ended.statements - started.statements) / seconds;
    const transactionsPerSecond = (ended.transactions - started.transactions) / seconds;
    return {
      streams: streamCount,
      statementsPerSecond: Math.round(statementsPerSecond),
      transactionsPerSecond: Math.round(transactionsPerSecond),
    };
  }

  /** How long someone else's page takes while the streams run. */
  async function pageTimes(path: string, jar: { cookie: string }) {
    const samples: number[] = [];
    for (let i = 0; i < PAGE_SAMPLES; i++) {
      const started = process.hrtime.bigint();
      const response = await visit(path, jar);
      await response.text();
      samples.push(elapsed(started));
    }
    return summarize(samples);
  }

  async function measureStreams(count: number, baseline: { statementsPerSecond: number }) {
    const person = await signUp(`Streams ${count}`);
    const organizationId = await createOrganizationPage(person, `Streams ${randomUUID()}`);
    const { rows } = await su.query('select id from identity.users where email = $1', [
      person.email,
    ]);
    const tenant = await resolveTenantContext(app.db, rows[0].id, organizationId);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push((await createWorkUnit(app.db, tenant, { title: `Stream ${i}` })).id);
    }

    const { follow, closeAll } = openStreams();
    try {
      // Opened in small groups, as people arriving do, and each stream is heard from before counting.
      const streams: Stream[] = [];
      for (let at = 0; at < count; at += 10) {
        streams.push(
          ...(await Promise.all(
            ids.slice(at, at + 10).map((id) => follow(person.jar, eventsPath(organizationId, id))),
          )),
        );
      }
      const refused = streams.filter((stream) => stream.status !== 200).length;
      if (refused > 0) throw new Error(`${refused} of ${count} streams were refused`);
      const openBy = Date.now() + 60_000;
      while (streams.some((stream) => !stream.arrivals.has('1'))) {
        if (Date.now() > openBy) throw new Error('streams did not all start');
        await new Promise((done) => setTimeout(done, 100));
      }

      const idle = await idleCost(count);
      const netStatements = idle.statementsPerSecond - baseline.statementsPerSecond;
      const use = {
        web: containerUse('web'),
        postgres: containerUse('postgres'),
      };

      // Changes made through the services, so the delay is the stream's and not a web request's.
      const delays: number[] = [];
      const versions = new Map(ids.map((id) => [id, 1]));
      let missed = 0;
      for (let round = 0; round < CHANGE_ROUNDS; round++) {
        const chosen = Array.from(
          { length: Math.min(CHANGES_PER_ROUND, count) },
          (_, i) => (round * CHANGES_PER_ROUND + i) % count,
        );
        const pending: Array<{ stream: Stream; version: string; at: number }> = [];
        for (const index of chosen) {
          const id = ids[index]!;
          const version = versions.get(id)!;
          await updateWorkUnit(app.db, tenant, id, version, { title: `Changed ${version}` });
          versions.set(id, version + 1);
          pending.push({ stream: streams[index]!, version: String(version + 1), at: Date.now() });
        }
        const deadline = Date.now() + 30_000;
        while (
          Date.now() < deadline &&
          pending.some(({ stream, version }) => !stream.arrivals.has(version))
        ) {
          await new Promise((done) => setTimeout(done, 20));
        }
        for (const { stream, version, at } of pending) {
          const arrived = stream.arrivals.get(version);
          if (arrived === undefined) missed += 1;
          else delays.push(Math.max(0, arrived - at));
        }
      }

      const pages = await pageTimes(`/o/${organizationId}/work`, person.jar);
      return {
        streams: count,
        statementsPerSecond: idle.statementsPerSecond,
        statementsPerSecondPerStream: Math.round((netStatements / count) * 100) / 100,
        transactionsPerSecond: idle.transactionsPerSecond,
        delivery: { ...summarize(delays), missed },
        workPageWhileStreaming: pages,
        containers: use,
      };
    } finally {
      closeAll();
    }
  }

  it('what status streams cost', async () => {
    // Off by default, and only the test overlay loads the library this needs.
    await su.query('create extension if not exists pg_stat_statements');
    const baseline = await idleCost(0);
    const quiet = { web: containerUse('web'), postgres: containerUse('postgres') };
    const person = await signUp('No streams');
    const organizationId = await createOrganizationPage(person, `No streams ${randomUUID()}`);
    const measured = [];
    for (const count of STREAM_COUNTS) {
      measured.push(await measureStreams(count, baseline));
      // Long enough for the closed streams to stop polling before the next size starts.
      await new Promise((done) => setTimeout(done, 5_000));
    }
    results.statusStreams = {
      note: 'One web replica behind the proxy, with one stream per Work Unit, each polling once a second. Delivery delay runs from the committed change to the event arriving here.',
      pollIntervalMs: 1_000,
      idle: {
        ...baseline,
        containers: quiet,
        workPage: await pageTimes(`/o/${organizationId}/work`, person.jar),
      },
      withStreams: measured,
    };
  }, 900_000);
});
