// API-13, SEC-12, NEXT-03: what has to hold across web instances, on two real replicas of the built
// image behind the proxy. Nothing is shared between them but PostgreSQL. Every check here asks the
// replica that did not make the change, with nothing in between to give a cache time to expire.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  createOrganization,
  type Form,
  formOn,
  join,
  onReplica,
  type Person,
  post,
  read,
  signUp,
  submit,
  tokenIn,
  visit,
} from '../helpers/forms';
import { createWork, locationOf, membershipOf, statusOn, workPage } from '../helpers/flows';
import { compose, repoRoot, urls } from '../helpers/stack';
import { eventsPath, lastIdOf, openStreams } from '../helpers/streams';

type Replica = 'web' | 'web-2';

const POLL = { timeout: 15_000, interval: 100 };

/** Waits until a stopped replica answers again, asking only once it is running. */
async function startAgain(service: Replica) {
  compose('start', service);
  await expect
    .poll(
      async () => {
        const response = await onReplica(service, () => visit('/api/health/ready'));
        return response.status;
      },
      { timeout: 90_000, interval: 500 },
    )
    .toBe(200);
}

describe('two web replicas', () => {
  let su: pg.Client;
  let owner: Person;
  let rival: Person;
  let org: string;
  const streams = openStreams();
  const tenantName = `Replicas ${randomUUID()}`;
  const people = () => `/o/${org}/people`;

  /** Changes a title through the public API of one replica, and returns the new version. */
  async function retitle(on: Replica, id: string, version: number) {
    const response = await fetch(`${BASE}/api/v1/organizations/${org}/work-units/${id}`, {
      method: 'PATCH',
      headers: {
        cookie: owner.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        'if-match': `"${version}"`,
        ...(on === 'web-2' ? { 'x-ensemus-test-replica': '2' } : {}),
      },
      body: JSON.stringify({ title: `Changed ${randomUUID()}` }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ensemus-served-by')).toBe(on);
    return version + 1;
  }

  const disabling = (target: string) => (form: Form) =>
    form.hidden.get('membershipId') === target && />Disable</.test(form.html);

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Olive Owner');
    org = await createOrganization(owner, tenantName);
    rival = await signUp('Rita Rival');
    await createOrganization(rival, `Rival ${randomUUID()}`);
  });

  afterEach(() => streams.closeAll());
  afterAll(() => su?.end());

  describe('the test routing itself', () => {
    it('reaches the replica it names, and each answers for itself', async () => {
      for (const replica of ['web', 'web-2'] as const) {
        const response = await onReplica(replica, () => visit('/api/health/ready'));
        expect(response.status).toBe(200);
        expect(response.headers.get('x-ensemus-served-by')).toBe(replica);
      }
      const unnamed = await visit('/api/health/ready');
      expect(unnamed.headers.get('x-ensemus-served-by')).toBe('web');
    });

    it('stays out of the deployed configuration', () => {
      const deployed = JSON.parse(
        execFileSync(
          'docker',
          ['compose', '-f', 'infrastructure/compose/compose.yaml', 'config', '--format', 'json'],
          { cwd: repoRoot, encoding: 'utf8' },
        ),
      ) as { services: Record<string, { volumes?: Array<{ source?: string }> }> };
      expect(Object.keys(deployed.services)).not.toContain('web-2');
      const mounted = deployed.services.proxy?.volumes?.map((volume) => volume.source ?? '') ?? [];
      expect(mounted.some((source) => source.endsWith('Caddyfile'))).toBe(true);
      expect(mounted.some((source) => source.endsWith('Caddyfile.test'))).toBe(false);
    });

    it('publishes nothing from the second replica, even in the test overlay', () => {
      const id = compose('ps', '-q', 'web-2').trim();
      const ports = execFileSync(
        'docker',
        ['inspect', id, '--format', '{{json .NetworkSettings.Ports}}'],
        { encoding: 'utf8' },
      );
      const published = Object.values(JSON.parse(ports) as Record<string, unknown[] | null>);
      expect(published.filter(Boolean)).toEqual([]);
    });
  });

  describe('a status stream (API-13)', () => {
    it('hears about a change made on the other replica', async () => {
      const id = await createWork(owner, org, { title: `Heard ${randomUUID()}` });
      const stream = await streams.follow(owner.jar, eventsPath(org, id));
      expect(stream.servedBy).toBe('web');
      await expect.poll(() => lastIdOf(stream), POLL).toBe('1');
      await retitle('web-2', id, 1);
      await expect.poll(() => lastIdOf(stream), POLL).toBe('2');
    });

    it('reconnects on the other replica from its last version, and misses nothing', async () => {
      const id = await createWork(owner, org, { title: `Reconnect ${randomUUID()}` });
      const first = await streams.follow(owner.jar, eventsPath(org, id));
      await expect.poll(() => lastIdOf(first), POLL).toBe('1');
      let version = await retitle('web', id, 1);
      await expect.poll(() => lastIdOf(first), POLL).toBe('2');
      const seen = lastIdOf(first) as string;

      // Its replica dies, so nothing can have been handed over, and the work moves on without it.
      compose('kill', 'web');
      try {
        await expect.poll(() => first.ended(), POLL).toBe(true);
        version = await retitle('web-2', id, version);
        version = await retitle('web-2', id, version);
        expect(lastIdOf(first)).toBe(seen);

        const second = await streams.follow(owner.jar, eventsPath(org, id), {
          replica: 'web-2',
          lastEventId: seen,
        });
        expect(second.status).toBe(200);
        expect(second.servedBy).toBe('web-2');
        await expect.poll(() => lastIdOf(second), POLL).toBe(String(version));
        // The latest state, once, and live from then on.
        expect(second.received).toEqual([
          { event: 'status', id: String(version), data: String(version) },
        ]);
        version = await retitle('web-2', id, version);
        await expect.poll(() => lastIdOf(second), POLL).toBe(String(version));
        const { rows } = await su.query(
          'select version::int as version from work.work_units where id = $1',
          [id],
        );
        expect(rows[0].version).toBe(version);

        // Already up to date on this replica: nothing to say until something changes.
        const current = await streams.follow(owner.jar, eventsPath(org, id), {
          replica: 'web-2',
          lastEventId: String(version),
        });
        await new Promise((done) => setTimeout(done, 2_500));
        expect(current.received).toEqual([]);
        expect(current.ended()).toBe(false);
      } finally {
        await startAgain('web');
      }
    });

    it('stays scoped to the tenant on the other replica', async () => {
      const id = await createWork(owner, org, { title: `Scoped ${randomUUID()}` });
      const first = await streams.follow(owner.jar, eventsPath(org, id));
      await expect.poll(() => lastIdOf(first), POLL).toBe('1');

      // Someone else, holding the same last version, reconnecting to the same replica.
      const outsider = await streams.follow(rival.jar, eventsPath(org, id), {
        replica: 'web-2',
        lastEventId: '1',
      });
      expect(outsider.status).toBe(404);
      expect(outsider.servedBy).toBe('web-2');
      expect(outsider.contentType).not.toContain('text/event-stream');
      await expect.poll(() => outsider.ended(), POLL).toBe(true);
      expect(outsider.received).toEqual([]);
      expect(outsider.raw()).not.toContain(tenantName);
    });

    it('is not disturbed when the other replica restarts', async () => {
      const id = await createWork(owner, org, { title: `Other restart ${randomUUID()}` });
      const stream = await streams.follow(owner.jar, eventsPath(org, id), { replica: 'web-2' });
      await expect.poll(() => lastIdOf(stream), POLL).toBe('1');
      compose('restart', 'web');
      await startAgain('web');
      expect(stream.ended()).toBe(false);
      await retitle('web', id, 1);
      await expect.poll(() => lastIdOf(stream), POLL).toBe('2');
    });
  });

  describe.each([
    ['web', 'web-2'],
    ['web-2', 'web'],
  ] as const)('access changed on %s, asked of %s (SEC-12, NEXT-03)', (changedOn, askedOf) => {
    const here = <T>(work: () => Promise<T>) => onReplica(changedOn, work);
    const there = <T>(work: () => Promise<T>) => onReplica(askedOf, work);

    it('refuses a disabled member at once, while everything is warm', async () => {
      const leaver = await join(owner, org, `Leah ${randomUUID()}`);
      const id = await createWork(leaver, org, { title: `Theirs ${randomUUID()}` });
      const page = workPage(org, id);
      const api = `/api/v1/organizations/${org}/work-units/${id}`;
      const warm = [`/o/${org}`, `/o/${org}/work`, page, `/o/${org}/approvals`, api];

      // Warm on both replicas, with a form already in hand and a stream open on the other one.
      for (const path of warm) {
        expect((await here(() => read(path, leaver.jar))).status, path).toBe(200);
        expect((await there(() => read(path, leaver.jar))).status, path).toBe(200);
      }
      const form = await there(() =>
        formOn(page, leaver.jar, (f) => f.hidden.get('to') === 'ready'),
      );
      const stream = await streams.follow(leaver.jar, eventsPath(org, id), { replica: askedOf });
      await expect.poll(() => lastIdOf(stream), POLL).toBe('1');
      expect(stream.servedBy).toBe(askedOf);

      const target = await membershipOf(su, leaver, org);
      const disabled = await here(() =>
        submit(people(), owner.jar, disabling(target), { confirm: 'yes' }),
      );
      expect(locationOf(disabled)).toBe(people());

      // No waiting of any kind: the very next request to the other replica is refused.
      const after = await Promise.all(
        warm.map((path) =>
          there(async () => {
            const { status, html } = await read(path, leaver.jar);
            return { path, status, leaked: html.includes(tenantName) };
          }),
        ),
      );
      expect(after).toEqual(warm.map((path) => ({ path, status: 404, leaked: false })));
      const late = await there(() => post(page, leaver.jar, form));
      expect(late.status).toBe(404);
      const { rows } = await su.query('select status from work.work_units where id = $1', [id]);
      expect(rows[0].status).toBe('queued');
      await expect.poll(() => stream.ended(), POLL).toBe(true);
      expect((await there(() => visit('/', leaver.jar))).headers.get('location')).not.toBe(
        `/o/${org}`,
      );
    });

    it('takes a role away at once', async () => {
      const name = `Ada ${randomUUID()}`;
      const admin = await join(owner, org, name);
      const target = await membershipOf(su, admin, org);
      const setRole = (role: string) =>
        here(() =>
          submit(
            people(),
            owner.jar,
            (f) =>
              f.hidden.get('membershipId') === target && f.html.includes(`Save access for ${name}`),
            { role },
          ),
        );
      expect(locationOf(await setRole('admin'))).toBe(people());

      // Being an admin is seen at once as well, so no replica remembers the old answer either way.
      const invite = await there(() => formOn(people(), admin.jar, /name="email"/));
      const invited = await there(() =>
        post(people(), admin.jar, invite, {
          email: `first-${randomUUID()}@example.invalid`,
          role: 'member',
        }),
      );
      expect(invited.status).toBe(200);
      expect(tokenIn(await invited.text())).toBeDefined();

      expect(locationOf(await setRole('member'))).toBe(people());

      const email = `second-${randomUUID()}@example.invalid`;
      const refused = await there(() =>
        post(people(), admin.jar, invite, { email, role: 'member' }),
      );
      expect(tokenIn(await refused.text())).toBeUndefined();
      const { rows } = await su.query(
        'select count(*)::int as n from org.invitations where email = $1',
        [email],
      );
      expect(rows[0].n).toBe(0);
      const page = await there(() => read(people(), admin.jar));
      expect(page.html).not.toContain('name="email"');
    });

    it('opens and closes restricted work at once, whichever replica made the change', async () => {
      const title = `Restricted ${randomUUID()}`;
      const id = await createWork(owner, org, { title, classification: 'restricted' });
      const page = workPage(org, id);
      const delegate = await join(owner, org, `Dana ${randomUUID()}`);
      const seen = () => there(() => read(page, delegate.jar));
      expect((await seen()).status).toBe(404);

      const membershipId = await membershipOf(su, delegate, org);
      const added = await here(() => submit(page, owner.jar, /Add someone/, { membershipId }));
      expect(locationOf(added)).toBe(page);
      const open = await seen();
      expect(open.status).toBe(200);
      expect(open.html).toContain(title);

      const removed = await here(() =>
        submit(page, owner.jar, (f) => f.html.includes(`Remove ${delegate.name} from this work`)),
      );
      expect(locationOf(removed)).toBe(page);
      const closed = await seen();
      expect(closed.status).toBe(404);
      expect(closed.html).not.toContain(title);
    });

    it('ends a session at once when the person signs out', async () => {
      const person = await join(owner, org, `Sam ${randomUUID()}`);
      const cookie = person.jar.cookie;
      expect((await there(() => read(`/o/${org}`, person.jar))).status).toBe(200);
      const out = await here(() => submit(`/o/${org}`, person.jar, />Sign out</));
      expect(out.status).toBe(303);
      const stale = await there(() => read(`/o/${org}`, { cookie }));
      expect(stale.status).not.toBe(200);
      expect(stale.html).not.toContain(tenantName);
    });

    it('shows the same state on both sides of a change', async () => {
      const id = await createWork(owner, org, { title: `Same ${randomUUID()}` });
      const page = workPage(org, id);
      expect(statusOn((await there(() => read(page, owner.jar))).html)).toBe('Waiting to start');
      await here(() => submit(page, owner.jar, (f) => f.hidden.get('to') === 'ready'));
      expect(statusOn((await there(() => read(page, owner.jar))).html)).toBe('Ready');
    });
  });

  it('keeps names and invitation links out of the second replica’s logs as well', async () => {
    const title = `Logged ${randomUUID()}`;
    const email = `logged-${randomUUID()}@example.invalid`;
    const token = await onReplica('web-2', async () => {
      await createWork(owner, org, { title });
      const response = await submit(people(), owner.jar, /name="email"/, { email, role: 'member' });
      expect(response.headers.get('x-ensemus-served-by')).toBe('web-2');
      return tokenIn(await response.text());
    });
    expect(token).toBeDefined();
    const logs = compose('logs', '--no-log-prefix', 'web-2');
    for (const value of [title, email, token as string, tenantName]) {
      expect(logs.includes(value), value).toBe(false);
    }
  });
});
