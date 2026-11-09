// NEXT-04, WORK-06: real failures during real work. The web tier goes away during a Work Unit's run,
// and the dispatcher process is killed in the middle of a batch.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorkUnit, requestExecution, transitionWorkUnit } from '@ensemus/application';
import {
  createOrganization as createOrganizationRow,
  openAppDatabase,
  resolveTenantContext,
  type TenantContext,
} from '@ensemus/database';
import {
  createOrganization,
  formOn,
  join,
  onReplica,
  type Person,
  post,
  read,
  signUp,
  submit,
  visit,
} from '../helpers/forms';
import { createWork, locationOf, membershipOf, move, statusOn, workPage } from '../helpers/flows';
import { compose, urls } from '../helpers/stack';
import { eventsPath, lastIdOf, openStreams } from '../helpers/streams';

const RUN_TIMEOUT = 60_000;
const POLL = { timeout: 15_000, interval: 100 };
const RECONNECT_SETTLE_MS = 5_000;

describe('the web tier going away during a real run (NEXT-04)', () => {
  let su: pg.Client;
  let owner: Person;
  let reviewer: Person;
  let org: string;
  const streams = openStreams();

  const row = async (id: string) => {
    const { rows } = await su.query(
      'select status, version::int as version from work.work_units where id = $1',
      [id],
    );
    return rows[0] as { status: string; version: number };
  };
  const statusOf = async (id: string) => (await row(id)).status;

  async function answering(service: 'web' | 'web-2') {
    await expect
      .poll(async () => (await onReplica(service, () => visit('/api/health/ready'))).status, {
        timeout: 90_000,
        interval: 500,
      })
      .toBe(200);
  }

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, `Outage ${randomUUID()}`);
    reviewer = await join(owner, org, 'Remy Reviewer');
  });

  afterEach(() => streams.closeAll());
  afterAll(() => su?.end());

  it('carries on without it, and the stream reconnects to the right state', async () => {
    const id = await createWork(owner, org, {
      title: `Through a restart ${randomUUID()}`,
      executionPlan: 'checklist',
      criteria: ['reviewer_approved'],
    });
    const page = workPage(org, id);
    await move(owner, org, id, 'ready');

    const started = await submit(page, owner.jar, /Run the plan/, {
      reviewerMembershipId: await membershipOf(su, reviewer, org),
    });
    expect(locationOf(started)).toBe(page);
    const first = await streams.follow(owner.jar, eventsPath(org, id));
    expect(first.status).toBe(200);
    await expect.poll(() => lastIdOf(first), POLL).toBeDefined();

    // The web replica restarts with the run just started, and with no one to ask it anything.
    compose('restart', 'web');
    await expect.poll(() => first.ended(), POLL).toBe(true);
    const seen = lastIdOf(first) as string;
    await expect
      .poll(() => statusOf(id), { timeout: RUN_TIMEOUT, interval: 300 })
      .toBe('awaiting_approval');

    await answering('web');
    const paused = await row(id);
    expect(Number(seen)).toBeLessThanOrEqual(paused.version);
    const second = await streams.follow(owner.jar, eventsPath(org, id), { lastEventId: seen });
    expect(second.servedBy).toBe('web');
    // Whatever it missed, it says where things stand now, and the page agrees.
    if (Number(seen) < paused.version) {
      await expect.poll(() => lastIdOf(second), POLL).toBe(String(paused.version));
      expect(second.received).toEqual([
        { event: 'status', id: String(paused.version), data: String(paused.version) },
      ]);
    } else {
      // The first stream already had the latest version, so this one has nothing new to say. A second
      // copy would mean it does not hold to Last-Event-ID. Long enough for the stream to poll again.
      await new Promise((done) => setTimeout(done, RECONNECT_SETTLE_MS));
      expect(second.received).toEqual([]);
    }
    expect(statusOn((await read(page, owner.jar)).html)).toBe('Waiting for approval');

    // A real decision on the other replica, and then no web tier at all while the run goes on.
    const approvalId = /\/approvals\/([0-9a-f-]{36})"/.exec(
      (await read(page, owner.jar)).html,
    )?.[1];
    if (!approvalId) throw new Error('No approval link');
    const approval = `/o/${org}/approvals/${approvalId}`;
    const decision = await onReplica('web-2', () =>
      formOn(approval, reviewer.jar, (form) => form.hidden.get('decision') === 'approve'),
    );
    compose('stop', 'web');
    try {
      const decided = await onReplica('web-2', () => post(approval, reviewer.jar, decision));
      expect(decided.status).toBe(303);
      compose('stop', 'web-2');
      try {
        await expect
          .poll(() => statusOf(id), { timeout: RUN_TIMEOUT, interval: 300 })
          .toBe('verifying');
      } finally {
        compose('start', 'web-2');
      }
    } finally {
      compose('start', 'web');
    }
    await answering('web');
    await answering('web-2');

    const checking = await row(id);
    const third = await streams.follow(owner.jar, eventsPath(org, id), {
      lastEventId: String(paused.version),
    });
    await expect.poll(() => lastIdOf(third), POLL).toBe(String(checking.version));
    expect(third.received).toEqual([
      { event: 'status', id: String(checking.version), data: String(checking.version) },
    ]);
    expect(statusOn((await read(page, owner.jar)).html)).toBe('Checking');

    // Still live, and a person can finish what the run left.
    await move(owner, org, id, 'completed');
    const done = await row(id);
    expect(done.status).toBe('completed');
    await expect.poll(() => lastIdOf(third), POLL).toBe(String(done.version));
    expect(statusOn((await read(page, owner.jar)).html)).toBe('Done');
  }, 300_000);
});

describe('the dispatcher killed in the middle of a batch (WORK-06)', () => {
  const COUNT = 150;
  let app: ReturnType<typeof openAppDatabase>;
  let su: pg.Client;
  let context: TenantContext;

  type Delivery = { id: string; state: string; leased: boolean };

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    const auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'Crash Owner',
      `${userId}@example.invalid`,
    ]);
    await auth.end();
    const { organizationId } = await createOrganizationRow(app.db, {
      userId,
      name: 'Crash',
      commercialMode: 'sovereign',
    });
    context = await resolveTenantContext(app.db, userId, organizationId);
  });

  afterAll(async () => {
    await app?.close();
    await su?.end();
  });

  /** Every event of this work, and whether a claim is holding it back right now. */
  async function deliveries(ids: string[]): Promise<Delivery[]> {
    const { rows } = await su.query(
      `select o.event_id as id, o.state, o.next_attempt_at > now() + interval '10 seconds' as leased
       from platform.outbox_events o
       join platform.domain_events e on e.id = o.event_id and e.organization_id = o.organization_id
       where e.aggregate_id = any($1::uuid[])`,
      [ids],
    );
    return rows;
  }

  it('loses no event, and delivers what it held once the lease runs out', async () => {
    // Everything queued first, so that the dispatcher really has a backlog when it comes back.
    compose('stop', 'dispatcher');
    const ids: string[] = [];
    try {
      for (let i = 0; i < COUNT; i++) {
        const work = await createWorkUnit(app.db, context, {
          title: `Crash ${i}`,
          executionPlan: 'checklist',
        });
        await transitionWorkUnit(app.db, context, {
          id: work.id,
          expectedVersion: 1,
          to: 'ready',
        });
        await requestExecution(app.db, context, work.id);
        ids.push(work.id);
      }
    } finally {
      compose('start', 'dispatcher');
    }
    expect((await deliveries(ids)).length).toBeGreaterThanOrEqual(COUNT * 2);

    // As soon as it has delivered a few, in the middle of what it claimed.
    await expect
      .poll(async () => (await deliveries(ids)).filter((e) => e.state === 'published').length, {
        timeout: 90_000,
        interval: 20,
      })
      .toBeGreaterThan(5);
    const container = compose('ps', '-q', 'dispatcher').trim();
    execFileSync('docker', ['kill', container], { encoding: 'utf8' });
    const exit = execFileSync('docker', ['inspect', container, '--format', '{{.State.ExitCode}}'], {
      encoding: 'utf8',
    }).trim();
    expect(exit).toBe('137');

    // Nothing shut down cleanly: what it had claimed is still claimed, by a process that is gone.
    const atKill = await deliveries(ids);
    const held = atKill.filter((event) => event.state === 'queued' && event.leased);
    const published = atKill.filter((event) => event.state === 'published').length;
    expect(held.length, 'the kill landed between batches').toBeGreaterThan(0);
    expect(published).toBeLessThan(atKill.length);
    const heldIds = new Set(held.map((event) => event.id));

    compose('start', 'dispatcher');

    // A new process delivers everything else, and leaves the claim of the dead one alone.
    const others = atKill.filter((event) => !heldIds.has(event.id));
    await expect
      .poll(
        async () => {
          const now = await deliveries(ids);
          return now.filter(
            (event) =>
              !heldIds.has(event.id) &&
              event.state === 'published' &&
              others.some((other) => other.id === event.id),
          ).length;
        },
        { timeout: 90_000, interval: 250 },
      )
      .toBe(others.length);
    const during = await deliveries(ids);
    const stillHeld = during.filter((event) => heldIds.has(event.id));
    expect(stillHeld.every((event) => event.state === 'queued' && event.leased)).toBe(true);
    expect(stillHeld).toHaveLength(held.length);

    // Then the lease ends, and each of them goes out with nothing to clean up.
    await expect
      .poll(
        async () => {
          const now = await deliveries(ids);
          return now.filter((event) => heldIds.has(event.id) && event.state === 'published').length;
        },
        { timeout: 170_000, interval: 1_000 },
      )
      .toBe(held.length);

    // Nothing lost and nothing done twice: every run happened, once. Counted by status, so a run that
    // ended anywhere else (failed, or still running) is named when this does not hold.
    await expect
      .poll(
        async () => {
          const { rows } = await su.query(
            `select status, count(*)::int as n from work.work_units
             where id = any($1::uuid[]) group by status`,
            [ids],
          );
          return Object.fromEntries(rows.map((row) => [row.status as string, row.n as number]));
        },
        { timeout: 90_000, interval: 500 },
      )
      .toEqual({ verifying: COUNT });
    // The runs add events of their own as they go, and all of those get out as well.
    await expect
      .poll(
        async () => {
          const now = await deliveries(ids);
          return {
            dead: now.filter((event) => event.state === 'dead').length,
            unpublished: now.filter((event) => event.state !== 'published').length,
          };
        },
        { timeout: 60_000, interval: 500 },
      )
      .toEqual({ dead: 0, unpublished: 0 });
    const { rows: files } = await su.query(
      `select w.work_unit_id, count(*)::int as n from work.work_artifacts w
       where w.work_unit_id = any($1::uuid[]) group by 1`,
      [ids],
    );
    expect(files).toHaveLength(COUNT);
    expect(files.filter((row) => row.n !== 1)).toEqual([]);
  }, 480_000);
});
