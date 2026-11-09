// Actual proxy/database/Temporal acceptance source. All runtime cases remain unrun at authorship.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, signUp, type Person } from '../helpers/forms';
import { publishGeneratedProcess } from '../helpers/process-run';
import { contractProblems, operations, operationName } from '../helpers/openapi';
describe('actual workflow execution HTTP contracts', () => {
  let owner: Person, outsider: Person, organization: string, specId: string, runId: string;
  const validated = new Set<string>();
  beforeAll(async () => {
    owner = await signUp('Generated workflow owner');
    organization = await createOrganization(owner, 'Generated workflow company');
    outsider = await signUp('Generated other owner');
    await createOrganization(outsider, 'Generated other workflow company');
    specId = (await publishGeneratedProcess(owner, organization)).specId;
  }, 180000);
  async function call(
    person: Person | undefined,
    method: string,
    suffix: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const path = `/api/v1/organizations/${organization}/${suffix}`,
      response = await fetch(BASE + path, {
        method,
        headers: {
          ...(person ? { cookie: person.jar.cookie } : {}),
          ...(method === 'GET' ? {} : { origin: BASE }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
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
  it('refuses missing identity, foreign tenant, malformed body/filter and cross-origin start', async () => {
    expect((await call(undefined, 'GET', 'process-specs')).status).toBe(401);
    expect((await call(outsider, 'GET', 'process-runs')).status).toBe(404);
    // A malformed filter or body is INVALID_INPUT, which the public API answers as 400 (readQuery and
    // readJson in apps/web/src/server/api.ts, HTTP_STATUS, the BadRequest response). Nothing answers 422.
    const filter = await call(owner, 'GET', 'process-runs?status=not-real');
    expect(filter.status).toBe(400);
    expect(filter.body?.code).toBe('INVALID_INPUT');
    const extra = await call(
      owner,
      'POST',
      'process-runs',
      { spec_id: specId, title: 'Generated work', private_transcript: 'not accepted' },
      { 'idempotency-key': randomUUID() },
    );
    expect(extra.status).toBe(400);
    expect(extra.body?.code).toBe('INVALID_INPUT');
    expect(
      (
        await call(
          owner,
          'POST',
          'process-runs',
          { spec_id: specId, title: 'Generated work' },
          { origin: 'https://example.invalid', 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(403);
  });
  it('starts once through actual native authority, returns complete references and replays only the same body', async () => {
    const specs = await call(owner, 'GET', 'process-specs');
    expect(specs.status).toBe(200);
    expect(specs.body?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: specId })]),
    );
    const input = { spec_id: specId, title: 'Generated actual workflow work' },
      key = randomUUID(),
      [one, two] = await Promise.all([
        call(owner, 'POST', 'process-runs', input, { 'idempotency-key': key }),
        call(owner, 'POST', 'process-runs', input, { 'idempotency-key': key }),
      ]);
    expect(one.status).toBe(202);
    expect(two.status).toBe(202);
    expect(one.body?.id).toBe(two.body?.id);
    if (typeof one.body?.id !== 'string') throw new Error('TEST_RUN_MISSING');
    runId = one.body.id;
    expect(one.body.title).toBe(input.title);
    expect(one.body.steps).toHaveLength(1);
    expect(
      (
        await call(
          owner,
          'POST',
          'process-runs',
          { ...input, title: 'Changed request' },
          { 'idempotency-key': key },
        )
      ).status,
    ).toBe(409);
    const page = await call(owner, 'GET', 'process-runs');
    expect(page.status).toBe(200);
    expect(page.body?.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: runId })]),
    );
    const current = await call(owner, 'GET', `process-runs/${runId}`);
    expect(current.status).toBe(200);
    expect(current.headers.get('etag')).toMatch(/^"[1-9]\d*"$/);
    expect((await call(outsider, 'GET', `process-runs/${runId}`)).status).toBe(404);
  });
  it('requires version and idempotent exact native stop, without claiming the worker is already finished', async () => {
    expect(runId).toBeTruthy();
    expect(
      (
        await call(
          owner,
          'POST',
          `process-runs/${runId}/stop`,
          {},
          { 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(428);
    const current = await call(owner, 'GET', `process-runs/${runId}`),
      version = current.headers.get('etag');
    if (!version) throw new Error('TEST_VERSION_MISSING');
    const forged = await call(
      owner,
      'POST',
      `process-runs/${runId}/stop`,
      { status: 'completed' },
      { 'if-match': version, 'idempotency-key': randomUUID() },
    );
    expect(forged.status).toBe(400);
    expect(forged.body?.code).toBe('INVALID_INPUT');
    const key = randomUUID(),
      one = await call(
        owner,
        'POST',
        `process-runs/${runId}/stop`,
        {},
        { 'if-match': version, 'idempotency-key': key },
      );
    expect(one.status).toBe(202);
    expect(one.body?.stop_code).toBe('STOP_REQUESTED');
    const replay = await call(
      owner,
      'POST',
      `process-runs/${runId}/stop`,
      {},
      { 'if-match': version, 'idempotency-key': key },
    );
    expect(replay.status).toBe(202);
    expect(replay.body?.id).toBe(runId);
  });
  it('has validated one successful actual response from each of the five owned operations', () => {
    const owned = operations()
      .filter((o) => o.status === undefined && /\/(process-specs|process-runs)(\/|$)/.test(o.path))
      .map((o) => operationName(o.method, o.path));
    expect(owned).toHaveLength(5);
    expect([...validated].filter((name) => /process-specs|process-runs/.test(name)).sort()).toEqual(
      owned.sort(),
    );
  });
});
