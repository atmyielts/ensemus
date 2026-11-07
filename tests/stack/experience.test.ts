// Actual proxy/SQL contracts, authored for the joined runtime gate; no provider qualification.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
import { BASE, signUp, createOrganization, type Person } from '../helpers/forms';
import { contractProblems, operationName, operations } from '../helpers/openapi';
describe('private outcome and company setup HTTP contracts', () => {
  let owner: Person, outsider: Person, organization: string;
  const validated = new Set<string>();
  beforeAll(async () => {
    owner = await signUp('Generated composer owner');
    organization = await createOrganization(owner, 'Generated composer company');
    outsider = await signUp('Other composer owner');
    await createOrganization(outsider, 'Other generated composer company');
  });
  async function call(
    person: Person | undefined,
    method: string,
    suffix: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const path = `/api/v1/organizations/${organization}/${suffix}`,
      response = await fetch(BASE + path, {
        method,
        headers: {
          ...(person ? { cookie: person.jar.cookie } : {}),
          ...(method === 'GET' ? {} : { origin: BASE }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
      }),
      text = await response.text(),
      contract = contractProblems({
        method,
        path,
        status: response.status,
        headers: response.headers,
        text,
      });
    expect(contract.problems, text).toEqual([]);
    if (contract.operation && response.status < 400) validated.add(contract.operation);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
      headers: response.headers,
    };
  }
  it('refuses absent/foreign people and cross-origin mutations', async () => {
    expect((await call(undefined, 'GET', 'outcome-drafts')).status).toBe(401);
    expect((await call(outsider, 'GET', 'onboarding')).status).toBe(404);
    expect(
      (
        await call(
          owner,
          'POST',
          'outcome-drafts',
          { objective: 'Prepare report', today: '2026-11-06' },
          { origin: 'https://example.invalid', 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(403);
  });
  it('replays identity only, binds saved preview hash/version, creates once, and serves no foreign private body', async () => {
    const body = { objective: 'Prepare a report by Friday', today: '2026-11-06' },
      key = randomUUID(),
      [one, two] = await Promise.all([
        call(owner, 'POST', 'outcome-drafts', body, { 'idempotency-key': key }),
        call(owner, 'POST', 'outcome-drafts', body, { 'idempotency-key': key }),
      ]);
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body?.id).toBe(one.body?.id);
    const id = String(one.body?.id),
      path = `outcome-drafts/${id}`;
    expect(
      (
        await call(
          owner,
          'POST',
          'outcome-drafts',
          { ...body, objective: 'Changed request' },
          { 'idempotency-key': key },
        )
      ).status,
    ).toBe(409);
    expect((await call(owner, 'GET', path)).status).toBe(200);
    expect((await call(outsider, 'GET', path)).status).toBe(404);
    expect((await call(owner, 'GET', 'outcome-drafts')).body?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
    const preview = one.body?.preview as Record<string, unknown>;
    expect((await call(owner, 'PATCH', path, preview)).status).toBe(428);
    const changed = await call(
      owner,
      'PATCH',
      path,
      { ...preview, title: 'Reviewed report' },
      { 'if-match': one.headers.get('etag') ?? '' },
    );
    expect(changed.status).toBe(200);
    expect(
      (
        await call(
          owner,
          'POST',
          `${path}/authorization`,
          { preview_sha256: one.body?.preview_sha256 },
          { 'if-match': one.headers.get('etag') ?? '' },
        )
      ).body?.code,
    ).toBe('OUTCOME_CHANGED');
    const confirmation = { preview_sha256: changed.body?.preview_sha256 },
      headers = { 'if-match': changed.headers.get('etag') ?? '' },
      [a, b] = await Promise.all([
        call(owner, 'POST', `${path}/authorization`, confirmation, headers),
        call(owner, 'POST', `${path}/authorization`, confirmation, headers),
      ]);
    expect(a.status).toBe(201);
    expect(b.body?.work_unit_id).toBe(a.body?.work_unit_id);
    expect(a.body?.status).toBe('authorized');
    expect(
      (await call(owner, 'PATCH', path, preview, { 'if-match': a.headers.get('etag') ?? '' }))
        .status,
    ).toBe(409);
  });
  it('discards inert drafts, derives setup from real records, and rejects fake record acknowledgements', async () => {
    const draft = await call(
      owner,
      'POST',
      'outcome-drafts',
      { objective: 'Discard this private preview', today: '2026-11-06' },
      { 'idempotency-key': randomUUID() },
    );
    expect(
      (
        await call(owner, 'DELETE', `outcome-drafts/${String(draft.body?.id)}`, undefined, {
          'if-match': draft.headers.get('etag') ?? '',
        })
      ).status,
    ).toBe(204);
    const setup = await call(owner, 'GET', 'onboarding');
    expect(setup.status).toBe(200);
    expect(setup.body?.completion_recorded).toBe(false);
    expect(
      (await call(owner, 'POST', 'onboarding/steps/first_work_unit', { decision: 'acknowledged' }))
        .status,
    ).toBe(422);
    const choice = await call(owner, 'POST', 'onboarding/steps/responsibility_statement', {
      decision: 'acknowledged',
    });
    expect(choice.status).toBe(200);
    expect(choice.body?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'responsibility_statement', state: 'done' }),
      ]),
    );
  });
  it('validates a successful response from every owned operation', () => {
    const owned = operations()
      .filter((o) => o.status === undefined && /\/(outcome-drafts|onboarding)(\/|$)/.test(o.path))
      .map((o) => operationName(o.method, o.path));
    expect(owned).toHaveLength(8);
    expect([...validated].sort()).toEqual(owned.sort());
  });
});
