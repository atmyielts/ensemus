// QA-003: one person in two tenants, streaming. Switching tenant emits nothing from the previous
// tenant, and a stream never crosses tenants, even though this person may read both.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  bringIn,
  createOrganization,
  type Form,
  join,
  type Person,
  read,
  signUp,
  submit,
} from '../helpers/forms';
import { createWork, membershipOf, workPage } from '../helpers/flows';
import { urls } from '../helpers/stack';
import { eventsPath, lastIdOf, openStreams, type Stream } from '../helpers/streams';

const POLL = { timeout: 15_000, interval: 100 };

/** Longer than a poll and a reconnect, so a frame that was going to arrive has arrived. */
const settle = () => new Promise((done) => setTimeout(done, 2_500));

describe('one person in two tenants, streaming (QA-003)', () => {
  let su: pg.Client;
  let ownerA: Person;
  let ownerB: Person;
  let both: Person;
  let orgA: string;
  let orgB: string;
  const nameA = `Tenant A ${randomUUID()}`;
  const nameB = `Tenant B ${randomUUID()}`;
  const streams = openStreams();

  /** Work in a tenant, whose title can be told apart, moved to a version of its own. */
  async function workAt(owner: Person, org: string, title: string, version: number) {
    const id = await createWork(owner, org, { title });
    let at = 1;
    while (at < version) at = await edit(owner, org, id, at);
    return id;
  }

  async function edit(owner: Person, org: string, id: string, version: number) {
    const response = await fetch(`${BASE}/api/v1/organizations/${org}/work-units/${id}`, {
      method: 'PATCH',
      headers: {
        cookie: owner.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        'if-match': `"${version}"`,
      },
      body: JSON.stringify({ objective: `Edited ${randomUUID()}` }),
    });
    expect(response.status).toBe(200);
    return version + 1;
  }

  /** Only ever this work's own versions, in order, and nothing that could carry content. */
  function expectOnly(stream: Stream, versions: number[]) {
    expect(stream.received).toEqual(
      versions.map((version) => ({
        event: 'status',
        id: String(version),
        data: String(version),
      })),
    );
    const frames = stream.raw().replace(/^retry: \d+\n\n/, '');
    expect(frames.replaceAll(/(id: \d+\nevent: status\ndata: \d+\n\n|: keep-alive\n\n)/g, '')).toBe(
      '',
    );
  }

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    ownerA = await signUp('Ann Owner');
    ownerB = await signUp('Bea Owner');
    orgA = await createOrganization(ownerA, nameA);
    orgB = await createOrganization(ownerB, nameB);
    both = await join(ownerA, orgA, 'Pat Twoplaces');
    // The same account, invited to the second tenant through its people page as well.
    await bringIn(ownerB, orgB, both);
  });

  afterEach(() => streams.closeAll());
  afterAll(() => su?.end());

  it('really is one person who can read both', async () => {
    const a = await createWork(ownerA, orgA, { title: `Visible in A ${randomUUID()}` });
    const b = await createWork(ownerB, orgB, { title: `Visible in B ${randomUUID()}` });
    expect((await read(workPage(orgA, a), both.jar)).status).toBe(200);
    expect((await read(workPage(orgB, b), both.jar)).status).toBe(200);
    const { html } = await read('/', both.jar);
    expect(html).toContain(nameA);
    expect(html).toContain(nameB);
    expect((await read(`/o/${orgA}`, both.jar)).html).toContain('Switch organization');
  });

  it('points each tenant’s page at its own stream, and only that one', async () => {
    const a = await createWork(ownerA, orgA, { title: `Page A ${randomUUID()}` });
    const b = await createWork(ownerB, orgB, { title: `Page B ${randomUUID()}` });
    const pageA = (await read(workPage(orgA, a), both.jar)).html;
    const pageB = (await read(workPage(orgB, b), both.jar)).html;
    expect(pageA).toContain(eventsPath(orgA, a));
    expect(pageA).not.toContain(orgB);
    expect(pageB).toContain(eventsPath(orgB, b));
    expect(pageB).not.toContain(orgA);
  });

  it('hears nothing from one tenant on a stream open in the other', async () => {
    const a = await workAt(ownerA, orgA, `Quiet A ${randomUUID()}`, 2);
    const b = await workAt(ownerB, orgB, `Busy B ${randomUUID()}`, 5);
    const inA = await streams.follow(both.jar, eventsPath(orgA, a));
    const inB = await streams.follow(both.jar, eventsPath(orgB, b));
    await expect.poll(() => lastIdOf(inA), POLL).toBe('2');
    await expect.poll(() => lastIdOf(inB), POLL).toBe('5');

    let versionB = 5;
    for (let i = 0; i < 3; i++) {
      versionB = await edit(ownerB, orgB, b, versionB);
      await expect.poll(() => lastIdOf(inB), POLL).toBe(String(versionB));
    }
    await settle();
    expectOnly(inA, [2]);
    expectOnly(inB, [5, 6, 7, 8]);

    // And the other way round, so silence was not just a stream that had stopped.
    await edit(ownerA, orgA, a, 2);
    await expect.poll(() => lastIdOf(inA), POLL).toBe('3');
    await settle();
    expectOnly(inA, [2, 3]);
    expectOnly(inB, [5, 6, 7, 8]);
  });

  it('switching tenant emits only the new tenant, even carrying the old stream’s position', async () => {
    const a = await workAt(ownerA, orgA, `Left A ${randomUUID()}`, 2);
    const b = await workAt(ownerB, orgB, `Entered B ${randomUUID()}`, 6);

    const inA = await streams.follow(both.jar, eventsPath(orgA, a));
    await expect.poll(() => lastIdOf(inA), POLL).toBe('2');
    inA.close();

    // The browser would not carry this over to another URL. A buggy or hand-made client could.
    const inB = await streams.follow(both.jar, eventsPath(orgB, b), {
      lastEventId: lastIdOf(inA) as string,
    });
    await expect.poll(() => lastIdOf(inB), POLL).toBe('6');

    // The tenant they left keeps changing, and the stream they are on stays silent.
    let versionA = 2;
    for (let i = 0; i < 6; i++) versionA = await edit(ownerA, orgA, a, versionA);
    await settle();
    expectOnly(inB, [6]);
    expect(inA.received).toEqual([{ event: 'status', id: '2', data: '2' }]);

    await edit(ownerB, orgB, b, 6);
    await expect.poll(() => lastIdOf(inB), POLL).toBe('7');
    expectOnly(inB, [6, 7]);
  });

  it('resuming in the new tenant at the same number stays silent, and never shows the old tenant', async () => {
    const a = await workAt(ownerA, orgA, `Same number A ${randomUUID()}`, 3);
    const b = await workAt(ownerB, orgB, `Same number B ${randomUUID()}`, 3);
    const inB = await streams.follow(both.jar, eventsPath(orgB, b), { lastEventId: '3' });
    await edit(ownerA, orgA, a, 3);
    await settle();
    expectOnly(inB, []);
  });

  it('never opens across tenants, for someone who can read both', async () => {
    const a = await createWork(ownerA, orgA, { title: `Crossing A ${randomUUID()}` });
    const b = await createWork(ownerB, orgB, { title: `Crossing B ${randomUUID()}` });
    for (const path of [eventsPath(orgA, b), eventsPath(orgB, a)]) {
      const crossing = await streams.follow(both.jar, path);
      expect(crossing.status, path).toBe(404);
      expect(crossing.contentType, path).not.toContain('text/event-stream');
      await expect.poll(() => crossing.ended(), POLL).toBe(true);
      expect(crossing.received, path).toEqual([]);
    }
    // A control: the same person, the same work, each under its own tenant.
    expect((await streams.follow(both.jar, eventsPath(orgA, a))).status).toBe(200);
    expect((await streams.follow(both.jar, eventsPath(orgB, b))).status).toBe(200);
  });

  it('leaving one tenant ends only that tenant’s stream', async () => {
    const twoPlaces = await join(ownerA, orgA, 'Lee Leaving');
    await bringIn(ownerB, orgB, twoPlaces);

    const a = await createWork(ownerA, orgA, { title: `Stays A ${randomUUID()}` });
    const b = await createWork(ownerB, orgB, { title: `Goes B ${randomUUID()}` });
    const inA = await streams.follow(twoPlaces.jar, eventsPath(orgA, a));
    const inB = await streams.follow(twoPlaces.jar, eventsPath(orgB, b));
    await expect.poll(() => lastIdOf(inA), POLL).toBe('1');
    await expect.poll(() => lastIdOf(inB), POLL).toBe('1');

    const target = await membershipOf(su, twoPlaces, orgB);
    await submit(
      `/o/${orgB}/people`,
      ownerB.jar,
      (form: Form) => form.hidden.get('membershipId') === target && />Disable</.test(form.html),
      { confirm: 'yes' },
    );
    await expect.poll(() => inB.ended(), POLL).toBe(true);
    expect(inA.ended()).toBe(false);
    await edit(ownerA, orgA, a, 1);
    await expect.poll(() => lastIdOf(inA), POLL).toBe('2');

    const again = await streams.follow(twoPlaces.jar, eventsPath(orgB, b));
    expect(again.status).toBe(404);
  });
});
