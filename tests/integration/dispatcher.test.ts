// WORK-06: at-least-once delivery, through the dispatcher's real database role.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkUnit } from '@ensemus/application';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import {
  dispatchDueEvents,
  listOrganizationIds,
  nextAttemptDelayMs,
  openDispatcherDatabase,
  outboxBacklog,
  redriveDeadEvents,
  type DeliveryFailure,
  type DispatchableEvent,
} from '@ensemus/database/dispatcher';
import { repoRoot, urls } from '../helpers/stack';

/**
 * Runs the real dispatcher in its own process, which kills itself without warning while delivering
 * one event. Nothing gets to clean up, so what is left behind is exactly what a crash leaves.
 */
function crashingDispatcher(killOn: string) {
  const fixtures = join(repoRoot, 'tests/helpers/fixtures');
  return new Promise<{ delivered: string[] }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(fixtures, 'resolve-ts.mjs')).href,
        join(fixtures, 'crashing-dispatcher.ts'),
      ],
      {
        env: { ...process.env, DISPATCH_URL: urls.dispatcher(), KILL_ON: killOn },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (err += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      // On Windows a killed process reports exit code 1 and no signal.
      if (signal === 'SIGKILL' || (signal === null && code === 1 && !err.includes('Error'))) {
        resolve({ delivered: out.split('\n').filter(Boolean) });
      } else {
        reject(
          new Error(
            `The dispatcher did not crash as planned, which also happens if the stack's own dispatcher is up and took the event: ${code} ${signal} ${err}`,
          ),
        );
      }
    });
  });
}

describe('outbox dispatch', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let dispatcher: ReturnType<typeof openDispatcherDatabase>;
  let su: pg.Client;
  let context: TenantContext;

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    dispatcher = openDispatcherDatabase(urls.dispatcher());
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'dispatcher test',
      `${userId}@example.invalid`,
    ]);
    await auth.end();
    const { organizationId } = await createOrganization(app.db, {
      userId,
      name: 'Dispatch',
      commercialMode: 'byom',
    });
    context = await resolveTenantContext(app.db, userId, organizationId);
  });

  afterAll(async () => {
    await app?.close();
    await dispatcher?.close();
    await su?.end();
  });

  /** Clears everything else that is due, so each test sees only its own events. */
  async function drain() {
    await su.query(`update platform.outbox_events set state = 'published' where state = 'queued'`);
  }

  const stateOf = async (aggregateId: string) => {
    const { rows } = await su.query(
      `select o.state, o.attempts from platform.outbox_events o
       join platform.domain_events e on e.id = o.event_id and e.organization_id = o.organization_id
       where e.aggregate_id = $1`,
      [aggregateId],
    );
    return rows[0] as { state: string; attempts: number };
  };

  const collect = async () => {
    const seen: DispatchableEvent[] = [];
    const result = await dispatchDueEvents(dispatcher.db, async (event) => {
      seen.push(event);
    });
    return { seen, result };
  };

  it('delivers once, with metadata only', async () => {
    await drain();
    const work = await createWorkUnit(app.db, context, { title: 'CANARY title' });
    const { seen } = await collect();
    const event = seen.find((e) => e.aggregateId === work.id);
    expect(event?.eventType).toBe('work.created');
    expect(event?.organizationId).toBe(context.organizationId);
    expect(JSON.stringify(event)).not.toContain('CANARY');
    expect((await stateOf(work.id)).state).toBe('published');
    expect((await collect()).seen.find((e) => e.aggregateId === work.id)).toBeUndefined();
  });

  it('crosses tenants, as only this role may', async () => {
    await drain();
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'second tenant',
      `${userId}@example.invalid`,
    ]);
    await auth.end();
    const { organizationId } = await createOrganization(app.db, {
      userId,
      name: 'Second',
      commercialMode: 'byom',
    });
    const other = await resolveTenantContext(app.db, userId, organizationId);
    await createWorkUnit(app.db, context, { title: 'A' });
    await createWorkUnit(app.db, other, { title: 'B' });
    const { seen } = await collect();
    const tenants = new Set(seen.map((e) => e.organizationId));
    expect(tenants.has(context.organizationId)).toBe(true);
    expect(tenants.has(organizationId)).toBe(true);
  });

  it('retries a failed delivery later, and keeps it due', async () => {
    await drain();
    const work = await createWorkUnit(app.db, context, { title: 'Retry' });
    const result = await dispatchDueEvents(dispatcher.db, async () => {
      throw new Error('Temporal is down');
    });
    expect(result.failed).toBeGreaterThan(0);
    const after = await stateOf(work.id);
    expect(after).toEqual({ state: 'queued', attempts: 1 });
    // Backoff means it is not due again immediately.
    expect((await collect()).seen.find((e) => e.aggregateId === work.id)).toBeUndefined();
    await su.query(
      `update platform.outbox_events set next_attempt_at = now() where state = 'queued'`,
    );
    expect((await collect()).seen.find((e) => e.aggregateId === work.id)).toBeDefined();
  });

  it('marks a poison event dead after repeated failures, visibly', async () => {
    await drain();
    const work = await createWorkUnit(app.db, context, { title: 'Poison' });
    for (let i = 0; i < 12; i++) {
      await su.query(
        `update platform.outbox_events set next_attempt_at = now() where state = 'queued'`,
      );
      await dispatchDueEvents(dispatcher.db, async () => {
        throw new Error('always fails');
      });
    }
    expect((await stateOf(work.id)).state).toBe('dead');
  });

  it('delivers again after a real crash between delivering and recording it (WORK-06)', async () => {
    await drain();
    const work = await createWorkUnit(app.db, context, { title: 'Crash' });
    const crash = await crashingDispatcher(work.id);
    // It was handed over, and the process died before the outcome could be written down.
    expect(crash.delivered).toEqual([work.id]);
    expect(await stateOf(work.id)).toEqual({ state: 'queued', attempts: 0 });

    await expect
      .poll(async () => (await collect()).seen.map((e) => e.aggregateId), {
        timeout: 15_000,
        interval: 250,
      })
      .toContain(work.id);
    expect((await stateOf(work.id)).state).toBe('published');
    // Delivered once more, and that is the end of it.
    expect((await collect()).seen.map((e) => e.aggregateId)).not.toContain(work.id);
  });

  it('does not hand the same event to two dispatchers at once', async () => {
    await drain();
    const work = await createWorkUnit(app.db, context, { title: 'Concurrent' });
    const second = openDispatcherDatabase(urls.dispatcher());
    let deliveries = 0;
    const slow = async (event: DispatchableEvent) => {
      if (event.aggregateId === work.id) deliveries += 1;
      await new Promise((done) => setTimeout(done, 100));
    };
    await Promise.all([dispatchDueEvents(dispatcher.db, slow), dispatchDueEvents(second.db, slow)]);
    await second.close();
    expect(deliveries).toBe(1);
  });

  describe('an outage', () => {
    const OUTAGE = Object.assign(new Error('unavailable'), { code: 14 });
    const classify = (error: unknown) => (error === OUTAGE ? 'outage' : 'fault') as DeliveryFailure;
    const rush = () =>
      su.query(`update platform.outbox_events set next_attempt_at = now() where state = 'queued'`);

    it('never kills an event, however long it lasts', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Through an outage' });
      for (let i = 0; i < 30; i++) {
        await rush();
        const result = await dispatchDueEvents(
          dispatcher.db,
          async () => {
            throw OUTAGE;
          },
          { classify },
        );
        expect(result.deferred).toBeGreaterThan(0);
        expect(result.dead).toBe(0);
      }
      expect(await stateOf(work.id)).toEqual({ state: 'queued', attempts: 0 });

      // Back up: it is delivered, as if nothing had happened.
      await rush();
      expect((await collect()).seen.find((e) => e.aggregateId === work.id)).toBeDefined();
      expect((await stateOf(work.id)).state).toBe('published');
    });

    it('still kills an event that is itself at fault', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Poison' });
      for (let i = 0; i < 12; i++) {
        await rush();
        await dispatchDueEvents(
          dispatcher.db,
          async () => {
            throw new Error('cannot parse this');
          },
          { classify },
        );
      }
      expect((await stateOf(work.id)).state).toBe('dead');
    });

    it('stops at the first sign of one, instead of waiting a timeout per event', async () => {
      await drain();
      for (let i = 0; i < 5; i++) await createWorkUnit(app.db, context, { title: `Batch ${i}` });
      let calls = 0;
      const result = await dispatchDueEvents(
        dispatcher.db,
        async () => {
          calls += 1;
          throw OUTAGE;
        },
        { classify },
      );
      expect(calls).toBe(1);
      expect(result.deferred).toBeGreaterThanOrEqual(5);
    });

    it('reports what went wrong with each event', async () => {
      await drain();
      await createWorkUnit(app.db, context, { title: 'Report' });
      const errors: unknown[] = [];
      await dispatchDueEvents(
        dispatcher.db,
        async () => {
          throw OUTAGE;
        },
        { classify, onEvent: (error) => errors.push(error) },
      );
      expect(errors).toContain(OUTAGE);
    });
  });

  describe('a failure that could be either an outage or the event', () => {
    const AMBIGUOUS = Object.assign(new Error('internal'), { code: 13 });
    const classify = (error: unknown) =>
      (error === AMBIGUOUS ? 'ambiguous' : 'fault') as DeliveryFailure;
    const rush = () =>
      su.query(`update platform.outbox_events set next_attempt_at = now() where state = 'queued'`);
    const fail = () =>
      dispatchDueEvents(
        dispatcher.db,
        async () => {
          throw AMBIGUOUS;
        },
        { classify },
      );

    it('counts, but outlasts what would kill an event at fault', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Ambiguous' });
      for (let i = 0; i < 30; i++) {
        await rush();
        await fail();
      }
      expect(await stateOf(work.id)).toEqual({ state: 'queued', attempts: 30 });
    });

    it('holds up nothing behind it', async () => {
      await drain();
      for (let i = 0; i < 3; i++) await createWorkUnit(app.db, context, { title: `A${i}` });
      let calls = 0;
      const result = await dispatchDueEvents(
        dispatcher.db,
        async () => {
          calls += 1;
          throw AMBIGUOUS;
        },
        { classify },
      );
      expect(calls).toBe(3);
      expect(result.failed).toBe(3);
      expect(result.deferred).toBe(0);
    });

    it('does not go on for ever: it ends dead, where operators can see it', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Always internal' });
      await su.query(
        `update platform.outbox_events o set attempts = 287
         from platform.domain_events e
         where e.id = o.event_id and e.organization_id = o.organization_id and e.aggregate_id = $1`,
        [work.id],
      );
      const before = await outboxBacklog(dispatcher.db);
      await rush();
      const result = await fail();
      expect(result.dead).toBe(1);
      expect(await stateOf(work.id)).toEqual({ state: 'dead', attempts: 288 });
      expect((await outboxBacklog(dispatcher.db)).dead).toBe(before.dead + 1);
    });
  });

  describe('holding no transaction across delivery', () => {
    it('keeps the result of events before a real crash, and hands back only the one after', async () => {
      await drain();
      const first = await createWorkUnit(app.db, context, { title: 'First' });
      const second = await createWorkUnit(app.db, context, { title: 'Second' });
      const crash = await crashingDispatcher(second.id);
      expect(crash.delivered).toEqual([first.id, second.id]);

      // Written when it happened, so the crash took nothing with it.
      expect(await stateOf(first.id)).toEqual({ state: 'published', attempts: 1 });
      expect(await stateOf(second.id)).toEqual({ state: 'queued', attempts: 0 });
      await expect
        .poll(async () => (await collect()).seen.map((e) => e.aggregateId), {
          timeout: 15_000,
          interval: 250,
        })
        .toEqual([second.id]);
    });

    it('holds a row lock on nothing while a delivery is running', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Unlocked' });
      let outcome: unknown;
      await dispatchDueEvents(dispatcher.db, async (event) => {
        if (event.aggregateId !== work.id) return;
        await su.query('begin');
        await su.query('set local lock_timeout = 1000');
        outcome = await su
          .query(
            `select 1 from platform.outbox_events o
             join platform.domain_events e on e.id = o.event_id
             where e.aggregate_id = $1 for update of o`,
            [work.id],
          )
          .then(
            () => 'free',
            (error: unknown) => error,
          );
        await su.query('rollback');
      });
      expect(outcome).toBe('free');
    });

    it('leases what it claimed, and a crash leaves it due again when the lease ends', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Leased' });
      await crashingDispatcher(work.id);

      // The lease is still running, so nothing else takes it, and nothing was counted against it.
      const leased = await su.query(
        `select o.next_attempt_at > now() as leased, o.attempts from platform.outbox_events o
         join platform.domain_events e on e.id = o.event_id where e.aggregate_id = $1`,
        [work.id],
      );
      expect(leased.rows[0]).toEqual({ leased: true, attempts: 0 });
      const second = openDispatcherDatabase(urls.dispatcher());
      const seen: string[] = [];
      const take = () =>
        dispatchDueEvents(second.db, async (event) => {
          seen.push(event.aggregateId);
        });
      await take();
      expect(seen).not.toContain(work.id);

      // Nothing cleans up after the crash. Time alone makes it due.
      await expect
        .poll(
          async () => {
            await take();
            return seen;
          },
          { timeout: 15_000, interval: 250 },
        )
        .toContain(work.id);
      await second.close();
      expect((await stateOf(work.id)).state).toBe('published');
    });

    it('stops between events when asked to, and hands the rest back at once', async () => {
      await drain();
      for (let i = 0; i < 4; i++) await createWorkUnit(app.db, context, { title: `Stop ${i}` });
      let calls = 0;
      let stopping = false;
      const result = await dispatchDueEvents(
        dispatcher.db,
        async () => {
          calls += 1;
          stopping = true;
        },
        { shouldStop: () => stopping },
      );
      expect(calls).toBe(1);
      expect(result.handled).toBe(1);
      const { seen } = await collect();
      expect(seen.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('operators', () => {
    it('can put dead events back in the queue, for one tenant or all', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Redrive' });
      await su.query(
        `update platform.outbox_events o set state = 'dead', attempts = 12
         from platform.domain_events e
         where e.id = o.event_id and e.organization_id = o.organization_id and e.aggregate_id = $1`,
        [work.id],
      );
      expect(await redriveDeadEvents(dispatcher.db, { organizationId: randomUUID() })).toBe(0);
      expect((await stateOf(work.id)).state).toBe('dead');
      expect(
        await redriveDeadEvents(dispatcher.db, { organizationId: context.organizationId }),
      ).toBeGreaterThanOrEqual(1);
      expect(await stateOf(work.id)).toEqual({ state: 'queued', attempts: 0 });
      expect((await collect()).seen.find((e) => e.aggregateId === work.id)).toBeDefined();
    });

    it('can list every tenant from event metadata, to check their schedules', async () => {
      expect(await listOrganizationIds(dispatcher.db)).toContain(context.organizationId);
    });
  });

  it('backs off exponentially, with a cap', () => {
    expect(nextAttemptDelayMs(1, 1)).toBe(2_000);
    expect(nextAttemptDelayMs(3, 1)).toBe(8_000);
    expect(nextAttemptDelayMs(30, 1)).toBe(300_000);
    expect(nextAttemptDelayMs(3, 0)).toBe(4_000);
  });
});
