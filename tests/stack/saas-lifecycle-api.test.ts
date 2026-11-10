import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';

describe('lifecycle account API', () => {
  let owner: Person, member: Person, outsider: Person, organizationId: string;
  beforeAll(async () => {
    owner = await signUp('Lifecycle API owner');
    outsider = await signUp('Lifecycle API outsider');
    organizationId = await createOrganization(owner, 'Lifecycle API account');
    member = await join(owner, organizationId, 'Lifecycle API member');
  });
  function call(person: Person, path: string, body?: unknown, version?: number) {
    return fetch(`${BASE}/api/v1/organizations/${organizationId}/${path}`, {
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
  it('member and outsider cannot discover rules or holds', async () => {
    for (const person of [member, outsider])
      for (const path of ['retention-rules', 'legal-holds'])
        expect((await call(person, path)).status).toBe(404);
  });
  it('sets a rule with sign-off, and emits only the public contract', async () => {
    const response = await call(owner, 'retention-rules', {
        data_category: 'raw_files',
        classification: 'internal',
        retain_days: null,
        basis_ref: randomUUID(),
      }),
      text = await response.text();
    expect(response.status).toBe(201);
    expect(
      contractProblems({
        method: 'POST',
        path: `/organizations/${organizationId}/retention-rules`,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(text).not.toMatch(/set_by_membership|organization_id|superseded_at/);
  });
  it('places and releases a versioned hold, retaining its record', async () => {
    const response = await call(owner, 'legal-holds', {
        matter_ref: randomUUID(),
        scopes: [{ type: 'organization', id: null }],
      }),
      text = await response.text();
    expect(response.status).toBe(201);
    expect(
      contractProblems({
        method: 'POST',
        path: `/organizations/${organizationId}/legal-holds`,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    const body = JSON.parse(text) as { id: string; version: number };
    expect(
      (await call(owner, `legal-holds/${body.id}/release`, { reason_code: 'TEST_CLOSED' })).status,
    ).toBe(428);
    expect(
      (
        await call(
          owner,
          `legal-holds/${body.id}/release`,
          { reason_code: 'TEST_CLOSED' },
          body.version,
        )
      ).status,
    ).toBe(204);
    expect((await call(owner, 'legal-holds')).status).toBe(200);
  });
});
