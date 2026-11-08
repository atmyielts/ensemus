import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';
describe('offboarding account API with the real scoped runtime binding', () => {
  let owner: Person, member: Person, other: Person, organizationId: string;
  const name = `Offboarding account ${randomUUID()}`;
  beforeAll(async () => {
    owner = await signUp('Offboarding API owner');
    other = await signUp('Offboarding API other');
    organizationId = await createOrganization(owner, name);
    member = await join(owner, organizationId, 'Offboarding API member');
  });
  function call(person: Person, path = '', body?: unknown, version?: number) {
    return fetch(`${BASE}/api/v1/organizations/${organizationId}/offboarding${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie: person.jar.cookie,
        origin: BASE,
        'content-type': 'application/json',
        ...(version ? { 'if-match': `"${version}"` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  it('members and outsiders cannot read, request or cancel', async () => {
    for (const person of [member, other]) {
      expect((await call(person)).status).toBe(404);
      expect((await call(person, '', { confirm_name: name })).status).toBe(404);
      expect((await call(person, '/cancellation', { reason_code: 'TEST_CANCEL' }, 1)).status).toBe(
        404,
      );
    }
  });
  it('requires the exact name, starts once and can cancel before erasure', async () => {
    expect((await call(owner, '', { confirm_name: name.toLowerCase() })).status).toBe(400);
    const response = await call(owner, '', { confirm_name: name }),
      text = await response.text();
    expect(response.status).toBe(202);
    expect(
      contractProblems({
        method: 'POST',
        path: `/organizations/${organizationId}/offboarding`,
        status: 202,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    const again = await call(owner, '', { confirm_name: name });
    expect(await again.text()).toBe(text);
    const read = await call(owner),
      body = (await read.json()) as { offboarding: { id: string; version: number } };
    expect(read.status).toBe(200);
    expect((await call(owner, '/cancellation', { reason_code: 'TEST_STAY' })).status).toBe(428);
    expect(
      (await call(owner, '/cancellation', { reason_code: 'TEST_STAY' }, body.offboarding.version))
        .status,
    ).toBe(204);
  });
});
