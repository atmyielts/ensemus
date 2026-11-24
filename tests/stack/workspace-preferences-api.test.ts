// API-12: real HTTP reads and writes for a person's notifications and a workspace's residency rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearDeploymentProfile, setDeploymentProfile } from '../helpers/federation';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';

describe('workspace preferences and deployment posture (API-12)', () => {
  let owner: Person, admin: Person, member: Person, outsider: Person;
  let organization: string;

  beforeAll(async () => {
    owner = await signUp('Preferences owner');
    organization = await createOrganization(owner, 'Generated preferences workspace');
    admin = await join(owner, organization, 'Preferences admin', 'admin');
    member = await join(owner, organization, 'Preferences member');
    outsider = await signUp('Preferences outsider');
  });

  async function call(
    person: Person | null,
    method: 'GET' | 'PUT',
    suffix: string,
    body?: unknown,
    origin = BASE,
  ) {
    const path = `/api/v1/organizations/${organization}/${suffix}`;
    const response = await fetch(BASE + path, {
      method,
      headers: {
        ...(person ? { cookie: person.jar.cookie } : {}),
        ...(method === 'PUT' ? { origin, 'content-type': 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(
      contractProblems({ method, path, status: response.status, headers: response.headers, text })
        .problems,
      `${method} ${suffix}`,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return { status: response.status, body: JSON.parse(text) };
  }

  it('changes and resets only the signed-in member’s notification preferences', async () => {
    const path = 'notification-preferences';
    expect((await call(null, 'GET', path)).status).toBe(401);
    expect((await call(outsider, 'PUT', path, { approvals: 'off' })).status).toBe(404);
    expect(
      (await call(member, 'PUT', path, { approvals: 'off' }, 'https://other.example.invalid'))
        .status,
    ).toBe(403);

    const defaults = await call(member, 'GET', path);
    expect(defaults.status).toBe(200);
    expect(defaults.body.preferences).toContainEqual({
      topic: 'approvals',
      delivery: 'immediate',
      isDefault: true,
    });
    const changed = await call(member, 'PUT', path, { approvals: 'off' });
    expect(changed.status).toBe(200);
    expect(changed.body.preferences).toEqual(
      defaults.body.preferences.map((item: { topic: string }) =>
        item.topic === 'approvals'
          ? { topic: 'approvals', delivery: 'off', isDefault: false }
          : item,
      ),
    );
    expect((await call(member, 'GET', path)).body).toEqual(changed.body);
    expect((await call(owner, 'GET', path)).body).toEqual(defaults.body);
    expect((await call(member, 'PUT', path, { approvals: 'immediate' })).body).toEqual(
      defaults.body,
    );
  });

  it('shows deployment posture to admins and withholds unchecked claims', async () => {
    const path = 'tenancy/posture';
    expect((await call(outsider, 'GET', path)).status).toBe(404);
    expect((await call(member, 'GET', path)).status).toBe(404);
    const answer = await call(admin, 'GET', path);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      tier: 'shared',
      home_region: null,
      isolated: false,
      all_in_region: false,
      aspects: expect.arrayContaining([
        expect.objectContaining({ aspect: 'database', state: 'unchecked', checked_at: null }),
      ]),
    });
  });

  describe('residency requirements on a deployment with a declared region', () => {
    const home = 'generated-test-home';
    const path = 'tenancy/residency-requirements';
    afterAll(clearDeploymentProfile);

    it('lets an owner set and remove a versioned rule, and gives admins read access', async () => {
      await setDeploymentProfile({ homeRegion: home });
      const request = { scope: 'confidential', region: home, expected_version: 0 };
      expect(await call(owner, 'GET', path)).toEqual({ status: 200, body: { items: [] } });
      expect((await call(member, 'GET', path)).status).toBe(404);
      expect((await call(admin, 'PUT', path, request)).status).toBe(403);
      expect((await call(outsider, 'PUT', path, request)).status).toBe(404);
      const elsewhere = await call(owner, 'PUT', path, { ...request, region: 'somewhere-else' });
      expect(elsewhere.status).toBe(409);
      expect(elsewhere.body.code).toBe('RESIDENCY_REGION_NOT_OFFERED');

      const saved = await call(owner, 'PUT', path, request);
      expect(saved.status).toBe(200);
      expect(saved.body.items).toMatchObject([{ scope: request.scope, region: home, version: 1 }]);
      expect(await call(admin, 'GET', path)).toEqual(saved);
      const stale = await call(owner, 'PUT', path, { ...request, region: null });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('VERSION_CONFLICT');
      expect(
        await call(owner, 'PUT', path, { ...request, region: null, expected_version: 1 }),
      ).toEqual({
        status: 200,
        body: { items: [] },
      });
    });
  });
});
