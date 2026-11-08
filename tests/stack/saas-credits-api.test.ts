import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';

describe('credit API refuses implicit or unauthorized purchases', () => {
  let owner: Person;
  let member: Person;
  let outsider: Person;
  let org: string;
  beforeAll(async () => {
    owner = await signUp('Credit API owner');
    outsider = await signUp('Credit API outsider');
    org = await createOrganization(owner, 'Credit API tenant');
    member = await join(owner, org, 'Credit API member');
  });
  const call = (person: Person, path: string) =>
    fetch(`${BASE}/api/v1/organizations/${org}/billing/${path}`, {
      headers: { cookie: person.jar.cookie },
    });
  it('ordinary members and outsiders see neither balances nor offers', async () => {
    for (const person of [member, outsider])
      for (const path of ['credits', 'top-ups'])
        expect((await call(person, path)).status).toBe(404);
  });
  it('an unsubscribed account has no offer and reads only the documented credit fields', async () => {
    const response = await call(owner, 'credits');
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(
      contractProblems({
        method: 'GET',
        path: `/organizations/${org}/billing/credits`,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(await (await call(owner, 'top-ups')).json()).toEqual({ offers: [] });
  });
  it('a forged quote and wrong origin never place an order', async () => {
    const response = await fetch(`${BASE}/api/v1/organizations/${org}/billing/top-ups`, {
      method: 'POST',
      headers: {
        cookie: owner.jar.cookie,
        origin: 'https://outside.example.invalid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        offer_id: randomUUID(),
        quote_hash: '0'.repeat(64),
        request_key: randomUUID(),
      }),
    });
    expect(response.status).toBe(403);
    expect(await (await call(owner, 'top-ups')).json()).toEqual({ offers: [] });
  });
});
