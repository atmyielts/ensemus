import { randomUUID } from 'node:crypto';
import { SANDBOX_DEFAULT_CEILINGS } from '@ensemus/domain/sandbox';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';
import { signedTrialVersion } from '../helpers/sandbox-trial';

const enabled = process.env.ENSEMUS_SANDBOX_ENABLED === 'true';
const ceilings = SANDBOX_DEFAULT_CEILINGS;
const unknownId = '00000000-0000-4000-8000-000000000001';

describe('Sandbox trial HTTP contract', () => {
  let owner: Person, member: Person, outsider: Person, organizationId: string;
  const path = (suffix: string) => `/api/v1/organizations/${organizationId}/${suffix}`;
  const requestPath = (id: string) => `skill-versions/${id}/sandbox-runs`;
  beforeAll(async () => {
    owner = await signUp('Generated Sandbox owner');
    organizationId = await createOrganization(owner, 'Generated Sandbox company');
    member = await join(owner, organizationId, 'Generated Sandbox member');
    outsider = await signUp('Generated Sandbox outsider');
  });

  async function call(
    person: Person | null,
    method: 'GET' | 'POST',
    suffix: string,
    { body, key, origin = BASE }: { body?: unknown; key?: string; origin?: string } = {},
  ) {
    const response = await fetch(`${BASE}${path(suffix)}`, {
      method,
      headers: {
        ...(person ? { cookie: person.jar.cookie } : {}),
        ...(method === 'POST' ? { origin } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(
      contractProblems({
        method,
        path: path(suffix),
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  }

  it('returns current operator configuration without exposing it to other tenants or members', async () => {
    expect((await call(null, 'GET', 'sandbox/status')).status).toBe(401);
    expect((await call(outsider, 'GET', 'sandbox/status')).status).toBe(404);
    expect((await call(member, 'GET', 'sandbox/status')).status).toBe(403);
    expect((await call(owner, 'GET', 'sandbox/status')).body).toMatchObject({
      enabled,
      isolation_evidence: 'none',
      last_probe_passed_at: null,
      ceilings: { wall_ms: ceilings.wallMs, memory_mb: ceilings.memoryMb },
    });
    expect((await call(owner, 'GET', `sandbox-runs/${unknownId}`)).status).toBe(404);
    expect((await call(owner, 'POST', `sandbox-runs/${unknownId}/cancellation`)).status).toBe(404);
    const body = { classification: 'internal', input: { sample: true } };
    expect(
      (await call(member, 'POST', requestPath(unknownId), { body, key: randomUUID() })).status,
    ).toBe(403);
    expect(
      (
        await call(owner, 'POST', requestPath(unknownId), {
          body,
          key: randomUUID(),
          origin: 'https://outside.example.invalid',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(owner, 'POST', requestPath(unknownId), { body, key: randomUUID() })).status,
    ).toBe(enabled ? 404 : 409);
  });

  it('queues, replays, reads and cancels a generated trial', async () => {
    if (!enabled) return;
    const version = await signedTrialVersion(owner, organizationId);
    const body = { classification: 'internal', input: { marker: 'generated-private-trial' } };
    const key = randomUUID();
    const requested = await call(owner, 'POST', requestPath(version), { key, body });
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({
      status: 'queued',
      output: null,
      isolation_evidence: 'none',
    });
    expect(requested.headers.get('etag')).toBe('"1"');
    expect((await call(owner, 'POST', requestPath(version), { key, body })).body).toEqual(
      requested.body,
    );
    expect(
      (await call(owner, 'POST', requestPath(version), { key, body: { ...body, input: {} } })).body
        .code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    const run = `sandbox-runs/${requested.body.id}`;
    const read = await call(owner, 'GET', run);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain('generated-private-trial');
    expect((await call(member, 'GET', run)).status).toBe(403);
    expect((await call(owner, 'POST', `${run}/cancellation`)).status).toBe(202);
    expect((await call(owner, 'POST', `${run}/cancellation`)).status).toBe(202);
    expect((await call(owner, 'GET', run)).body).toMatchObject({
      status: 'cancelled',
      outcome_code: 'CANCELLED_BY_REQUEST',
      output: null,
    });
  });
});
