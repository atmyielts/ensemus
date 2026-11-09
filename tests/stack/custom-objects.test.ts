// Built proxy + actual SQL/worker contract. This file is authored, not runtime qualification.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
import { BASE, signUp, createOrganization, type Person } from '../helpers/forms';
import { contractProblems, operationName, operations } from '../helpers/openapi';

/**
 * Bounds the resend of a request the API refused as TENANT_BUSY (503, retryable, with Retry-After;
 * packages/application/src/errors.ts). Deleting a record starts its typed-record purge in the stack's
 * workers (ADR-028 lifecycle item 8a), which holds this tenant's organization row FOR NO KEY UPDATE
 * NOWAIT (0514 lifecycle.record_purge_hold_free). Every objects.* insert passes the erasure birth fence
 * (0508), which takes the same row FOR SHARE NOWAIT (0533), so a write made while that purge runs is
 * refused at once and did nothing. CI run 42706818569: such a refusal, then reported as a 409, left a
 * record uncreated, and the relation to it was refused as malformed (400).
 */
const BUSY_ATTEMPTS = 20;
const MAX_RETRY_AFTER_SECONDS = 5;

describe('custom object HTTP contracts through the proxy', () => {
  let owner: Person, outsider: Person, organization: string;
  const validated = new Set<string>();
  beforeAll(async () => {
    owner = await signUp('Object API owner');
    organization = await createOrganization(owner, 'Generated object API');
    outsider = await signUp('Object API outsider');
    await createOrganization(outsider, 'Other generated object tenant');
  });
  /**
   * One request, checked against the spec. A TENANT_BUSY refusal is itself checked (503, retryable,
   * Retry-After) and the identical request, with the same Idempotency-Key and If-Match, is sent again
   * after the wait it names, as the API documents. No other answer is ever resent: a 409, a VERSION_
   * CONFLICT among them, is returned at once, so every assertion below still sees it.
   */
  async function call(
    person: Person | undefined,
    method: string,
    suffix: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const path = `/api/v1/organizations/${organization}/${suffix}`;
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(BASE + path, {
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
        text = await response.text();
      const contract = contractProblems({
        method,
        path,
        status: response.status,
        headers: response.headers,
        text,
      });
      expect(contract.problems, text).toEqual([]);
      if (contract.operation && response.status < 400) validated.add(contract.operation);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const answer = {
        status: response.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        headers: response.headers,
        text,
      };
      if (answer.status !== 503 || answer.body?.code !== 'TENANT_BUSY' || attempt >= BUSY_ATTEMPTS)
        return answer;
      expect(answer.body.retryable, text).toBe(true);
      const wait = Number(response.headers.get('retry-after'));
      expect(Number.isInteger(wait) && wait > 0, text).toBe(true);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(wait, MAX_RETRY_AFTER_SECONDS) * 1000),
      );
    }
  }
  /** The owner's write with If-Match: what the API answers, with nothing resent but a busy refusal. */
  const preconditioned = (
    method: string,
    suffix: string,
    body: unknown,
    ifMatch: string,
    extra: Record<string, string> = {},
  ) => call(owner, method, suffix, body, { ...extra, 'if-match': ifMatch });
  const typeInput = () => {
    const slug = `kind_${randomUUID().replaceAll('-', '')}`;
    return {
      slug,
      display_name: 'Generated items',
      classification: 'internal',
      fields: [],
      relations: [{ key: 'related', label: 'Related', toTypeSlug: slug, cardinality: 'many' }],
    };
  };
  it('authenticates and denies foreign and cross-origin access before a mutation', async () => {
    expect((await call(undefined, 'GET', 'object-types')).status).toBe(401);
    expect((await call(outsider, 'GET', 'object-types')).status).toBe(404);
    expect(
      (
        await call(owner, 'POST', 'object-types', typeInput(), {
          origin: 'https://example.invalid',
          'idempotency-key': randomUUID(),
        })
      ).status,
    ).toBe(403);
  });
  it('replays concurrent creation once, rejects changed intent and reauthorizes replayed identity', async () => {
    const key = randomUUID(),
      body = typeInput(),
      [a, b] = await Promise.all([
        call(owner, 'POST', 'object-types', body, { 'idempotency-key': key }),
        call(owner, 'POST', 'object-types', body, { 'idempotency-key': key }),
      ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body?.id).toBe(b.body?.id);
    const changed = await call(
      owner,
      'POST',
      'object-types',
      { ...body, display_name: 'Changed body' },
      { 'idempotency-key': key },
    );
    expect(changed.status).toBe(409);
    expect(changed.body?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const typeId = String(a.body?.id),
      recordKey = randomUUID(),
      input = {
        display_name: 'Private generated record',
        attributes: {},
        classification: 'restricted',
      },
      first = await call(owner, 'POST', `object-types/${typeId}/records`, input, {
        'idempotency-key': recordKey,
      }),
      id = String(first.body?.id);
    expect(first.status).toBe(201);
    expect((await call(outsider, 'GET', `object-records/${id}`)).status).toBe(404);
    expect(
      (
        await preconditioned(
          'DELETE',
          `object-records/${id}`,
          undefined,
          first.headers.get('etag') ?? '',
        )
      ).status,
    ).toBe(204);
    const replay = await call(owner, 'POST', `object-types/${typeId}/records`, input, {
      'idempotency-key': recordKey,
    });
    expect(replay.status).toBe(404);
    expect(replay.text).not.toContain('Private generated record');
  });
  it('validates every implemented successful response, optimistic edits, relations and safe schema queueing', async () => {
    const definition = typeInput(),
      created = await call(owner, 'POST', 'object-types', definition, {
        'idempotency-key': randomUUID(),
      }),
      typeId = String(created.body?.id),
      tpath = `object-types/${typeId}`;
    expect(created.status).toBe(201);
    expect((await call(owner, 'GET', 'object-types')).status).toBe(200);
    expect((await call(owner, 'GET', tpath)).status).toBe(200);
    const first = await call(
        owner,
        'POST',
        `${tpath}/records`,
        { display_name: 'One', attributes: {}, classification: 'internal' },
        { 'idempotency-key': randomUUID() },
      ),
      second = await call(
        owner,
        'POST',
        `${tpath}/records`,
        { display_name: 'Two', attributes: {}, classification: 'internal' },
        { 'idempotency-key': randomUUID() },
      ),
      a = String(first.body?.id),
      b = String(second.body?.id),
      apath = `object-records/${a}`;
    // Both records have to exist before anything relates them: an unchecked refusal here once reached
    // the relation below as to_record_id "undefined" (CI run 42706818569, 400 INVALID_INPUT).
    expect(first.status, first.text).toBe(201);
    expect(second.status, second.text).toBe(201);
    expect((await call(owner, 'GET', `${tpath}/records?limit=1`)).status).toBe(200);
    expect((await call(owner, 'GET', apath)).status).toBe(200);
    expect((await call(owner, 'PATCH', apath, { display_name: 'Missing version' })).status).toBe(
      428,
    );
    const edited = await preconditioned(
      'PATCH',
      apath,
      { display_name: 'Edited One' },
      first.headers.get('etag') ?? '',
    );
    expect(edited.status, edited.text).toBe(200);
    expect(
      (
        await call(
          owner,
          'PATCH',
          apath,
          { display_name: 'Stale' },
          { 'if-match': first.headers.get('etag') ?? '' },
        )
      ).status,
    ).toBe(409);
    const relation = await call(owner, 'POST', `${apath}/relations`, {
      relation_key: 'related',
      to_record_id: b,
    });
    expect(relation.status, relation.text).toBe(201);
    expect((await call(owner, 'GET', `${apath}/relations`)).status).toBe(200);
    expect(
      (await call(owner, 'DELETE', `${apath}/relations/${String(relation.body?.id)}`)).status,
    ).toBe(204);
    expect(
      (await preconditioned('DELETE', apath, undefined, edited.headers.get('etag') ?? '')).status,
    ).toBe(204);
    expect(
      (
        await preconditioned(
          'DELETE',
          `object-records/${b}`,
          undefined,
          second.headers.get('etag') ?? '',
        )
      ).status,
    ).toBe(204);
    const raised = await preconditioned(
      'PATCH',
      tpath,
      { classification: 'confidential' },
      created.headers.get('etag') ?? '',
    );
    expect(raised.status, raised.text).toBe(200);
    const queued = await preconditioned(
      'POST',
      `${tpath}/versions`,
      {
        fields: [
          { key: 'reference', label: 'Reference', kind: 'text', required: false, indexed: true },
        ],
        relations: definition.relations,
      },
      raised.headers.get('etag') ?? '',
    );
    expect(queued.status, queued.text).toBe(202);
    expect(queued.body?.migration_id).toEqual(expect.any(String));
  });
  it('keeps failed row receipts and retries corrected records through a new durable intent', async () => {
    const fields = [{ key: 'name', label: 'Name', kind: 'text', required: true, indexed: false }],
      definition = { ...typeInput(), fields, relations: [] },
      created = await call(owner, 'POST', 'object-types', definition, {
        'idempotency-key': randomUUID(),
      }),
      typeId = String(created.body?.id),
      tpath = `object-types/${typeId}`;
    const record = await call(
        owner,
        'POST',
        `${tpath}/records`,
        {
          display_name: 'Wide generated value',
          attributes: { name: 'Ж'.repeat(1500) },
          classification: 'internal',
        },
        { 'idempotency-key': randomUUID() },
      ),
      queued = await preconditioned(
        'POST',
        `${tpath}/versions`,
        { fields: [{ ...fields[0], indexed: true }], relations: [] },
        created.headers.get('etag') ?? '',
      );
    expect(record.status, record.text).toBe(201);
    expect(queued.status, queued.text).toBe(202);
    const migrationPath = `${tpath}/migrations/${String(queued.body?.migration_id)}`;
    async function settled(path: string, expected: string) {
      for (let n = 0; n < 60; n++) {
        const current = await call(owner, 'GET', path);
        expect(current.status).toBe(200);
        if (current.body?.status === expected) return current;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('MIGRATION_DID_NOT_SETTLE');
    }
    const failed = await settled(migrationPath, 'failed');
    expect(failed.body?.failed_count).toBe(1);
    const recordPath = `object-records/${String(record.body?.id)}`;
    expect(
      (
        await preconditioned(
          'PATCH',
          recordPath,
          { attributes: { name: 'corrected' } },
          record.headers.get('etag') ?? '',
        )
      ).status,
    ).toBe(200);
    // One idempotency key for every send: a refused send stored nothing under it.
    const current = await call(owner, 'GET', tpath),
      retry = await preconditioned(
        'POST',
        `${migrationPath}/retry`,
        undefined,
        current.headers.get('etag') ?? '',
        { 'idempotency-key': randomUUID() },
      );
    expect(retry.status, retry.text).toBe(202);
    expect(retry.body?.migration_id).not.toBe(queued.body?.migration_id);
    expect(
      (await settled(`${tpath}/migrations/${String(retry.body?.migration_id)}`, 'completed')).body
        ?.migrated_count,
    ).toBe(1);
    expect((await call(owner, 'GET', migrationPath)).body?.failed_count).toBe(1);
  });
  it('has validated a successful real response from every custom object operation', () => {
    const implemented = operations()
      .filter(
        (op) => op.status === undefined && /\/(object-types|object-records)(\/|$)/.test(op.path),
      )
      .map(({ method, path }) => operationName(method, path));
    expect(implemented.length).toBeGreaterThan(0);
    expect([...validated].sort()).toEqual(implemented.sort());
  });
});
