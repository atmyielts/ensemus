// WORK-06: at-least-once delivery, through the dispatcher's real database role.
import { randomUUID } from 'node:crypto';
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
  redriveDeadEvents,
  type DispatchableEvent,
} from '@ensemus/database/dispatcher';
import { urls } from '../helpers/stack';

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

  it('delivers again after a crash before commit (WORK-06)', async () => {
    await drain();
    const work = await createWorkUnit(app.db, context, { title: 'Crash' });
    // A failed connection stands in for a crash: the handler ran, but the commit never happened.
    await dispatcher.db
      .transaction(async (tx) => {
        await tx.execute('select 1');
        throw new Error('crash before commit');
      })
      .catch(() => undefined);
    let deliveries = 0;
    await expect(
      dispatcher.db.transaction(async () => {
        await dispatchDueEvents(dispatcher.db, async (event) => {
          if (event.aggregateId === work.id) deliveries += 1;
          throw new Error('crash during delivery');
        });
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    await su.query(
      `update platform.outbox_events set next_attempt_at = now() where state = 'queued'`,
    );
    const { seen } = await collect();
    expect(seen.filter((e) => e.aggregateId === work.id)).toHaveLength(1);
    expect(deliveries).toBe(1);
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
    const isTransient = (error: unknown) => error === OUTAGE;
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
          { isTransient },
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
          { isTransient },
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
        { isTransient },
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
        { isTransient, onEvent: (error) => errors.push(error) },
      );
      expect(errors).toContain(OUTAGE);
    });
  });

  describe('holding no transaction across delivery', () => {
    it('commits each outcome as it goes, so a crash later keeps earlier results', async () => {
      await drain();
      const first = await createWorkUnit(app.db, context, { title: 'First' });
      const second = await createWorkUnit(app.db, context, { title: 'Second' });
      let delivered = 0;
      await expect(
        dispatchDueEvents(dispatcher.db, async (event) => {
          if (event.aggregateId === first.id) {
            delivered += 1;
            return;
          }
          if (event.aggregateId !== second.id) return;
          // Seen from outside, while this delivery is still running.
          expect((await stateOf(first.id)).state).toBe('published');
          // And the row being worked on is not locked against anyone.
          await su.query('set lock_timeout = 1000');
          await su.query(
            `select 1 from platform.outbox_events o
             join platform.domain_events e on e.id = o.event_id
             where e.aggregate_id = $1 for update of o`,
            [second.id],
          );
          throw new Error('process killed here');
        }),
      ).resolves.toBeDefined();
      expect(delivered).toBe(1);
    });

    it('leases what it claimed, and a crash leaves it due again when the lease ends', async () => {
      await drain();
      const work = await createWorkUnit(app.db, context, { title: 'Leased' });
      // Claimed by a dispatcher that then dies: the handler never returns.
      let release = () => undefined as void;
      const stuck = dispatchDueEvents(dispatcher.db, async (event) => {
        if (event.aggregateId === work.id) {
          await new Promise<void>((done) => {
            release = done;
          });
        }
      });
      await expect
        .poll(async () => {
          const { rows } = await su.query(
            `select o.next_attempt_at > now() as leased from platform.outbox_events o
           join platform.domain_events e on e.id = o.event_id where e.aggregate_id = $1`,
            [work.id],
          );
          return rows[0].leased;
        })
        .toBe(true);
      // Another dispatcher does not take it meanwhile.
      const second = openDispatcherDatabase(urls.dispatcher());
      const seen: string[] = [];
      await dispatchDueEvents(second.db, async (event) => {
        seen.push(event.aggregateId);
      });
      await second.close();
      expect(seen).not.toContain(work.id);
      release();
      await stuck;
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
