// Built proxy/API contract gate. Generated private data only; no provider or model credentials.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
import { BASE, createOrganization, signUp, type Person } from '../helpers/forms';
import { contractProblems } from '../helpers/openapi';

describe('knowledge HTTP authorization, uploads and async questions', () => {
  let owner: Person, outsider: Person, organization: string;
  const path = (suffix: string) => `/api/v1/organizations/${organization}/${suffix}`;
  async function call(
    person: Person | undefined,
    method: string,
    suffix: string,
    body?: RequestInit['body'],
    headers: Record<string, string> = {},
  ) {
    const target = path(suffix),
      response = await fetch(BASE + target, {
        method,
        headers: {
          ...(person ? { cookie: person.jar.cookie } : {}),
          ...(method === 'GET' ? {} : { origin: BASE }),
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
      });
    const text = await response.text();
    expect(
      contractProblems({
        method,
        path: target,
        status: response.status,
        headers: response.headers,
        text,
      }).problems,
      text,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    return { response, body: JSON.parse(text) as Record<string, unknown>, text };
  }
  const upload = (title: string, words = 'Generated source words.') => {
    const body = new FormData();
    body.set('metadata', JSON.stringify({ title, classification: 'restricted', grants: [] }));
    body.set('file', new File([words], 'source.txt', { type: 'text/plain' }));
    return body;
  };
  beforeAll(async () => {
    owner = await signUp('Knowledge API owner');
    organization = await createOrganization(owner, 'Generated knowledge API');
    outsider = await signUp('Knowledge API outsider');
    await createOrganization(outsider, 'Other generated tenant');
  });
  it('authenticates and rejects cross-origin mutations before parsing upload data', async () => {
    expect((await call(undefined, 'GET', 'knowledge/sources')).response.status).toBe(401);
    const denied = await call(owner, 'POST', 'knowledge/sources', 'not multipart', {
      origin: 'https://example.invalid',
    });
    expect(denied.response.status).toBe(403);
    expect(denied.body.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await call(outsider, 'GET', 'knowledge/sources')).response.status).toBe(404);
  });
  it('replays one durable source, refuses changed bytes and hides its words from another tenant', async () => {
    const key = randomUUID(),
      title = `Generated source ${randomUUID()}`;
    const first = await call(owner, 'POST', 'knowledge/sources', upload(title), {
      'idempotency-key': key,
    });
    expect(first.response.status, first.text).toBe(201);
    expect(first.body.title).toBe(title);
    expect(first.body.scan_state).toBe('not_scanned');
    const repeated = await call(owner, 'POST', 'knowledge/sources', upload(title), {
      'idempotency-key': key,
    });
    expect(repeated.response.status, repeated.text).toBe(201);
    expect(repeated.body.id).toBe(first.body.id);
    const changed = await call(
      owner,
      'POST',
      'knowledge/sources',
      upload(title, 'Different bytes.'),
      { 'idempotency-key': key },
    );
    expect(changed.response.status).toBe(409);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const denied = await call(outsider, 'GET', `knowledge/sources/${String(first.body.id)}`);
    expect(denied.response.status).toBe(404);
    expect(denied.text).not.toContain(title);
    const listed = await call(owner, 'GET', 'knowledge/sources');
    expect(
      (listed.body.items as { id: string }[]).filter((s) => s.id === first.body.id),
    ).toHaveLength(1);
  });
  it('queues a private question with conservative sensitivity and binds its key to exact input', async () => {
    const key = randomUUID(),
      question = `Generated private question ${randomUUID()}`;
    const body = JSON.stringify({ question }),
      headers = { 'content-type': 'application/json', 'idempotency-key': key };
    const first = await call(owner, 'POST', 'knowledge/answers', body, headers);
    expect(first.response.status, first.text).toBe(202);
    expect(first.body.question_classification).toBe('restricted');
    // The key's stored response is the service transaction's own result (API-12); a replay returns
    // the same accepted answer rather than a second row.
    const repeated = await call(owner, 'POST', 'knowledge/answers', body, headers);
    expect(repeated.response.status, repeated.text).toBe(202);
    expect(repeated.body.id).toBe(first.body.id);
    const changed = await call(
      owner,
      'POST',
      'knowledge/answers',
      JSON.stringify({ question, classification: 'public' }),
      headers,
    );
    expect(changed.response.status).toBe(409);
    const denied = await call(outsider, 'GET', `knowledge/answers/${String(first.body.id)}`);
    expect(denied.response.status).toBe(404);
    expect(denied.text).not.toContain(question);
  });
  it('requires the exact source version before closure, then reports removal separately', async () => {
    const source = await call(
        owner,
        'POST',
        'knowledge/sources',
        upload('Generated closure source'),
        { 'idempotency-key': randomUUID() },
      ),
      id = String(source.body.id),
      body = JSON.stringify({ reason: 'Generated removal request' }),
      headers = { 'content-type': 'application/json' };
    expect(
      (await call(owner, 'DELETE', `knowledge/sources/${id}`, body, headers)).response.status,
    ).toBe(428);
    expect(
      (
        await call(owner, 'DELETE', `knowledge/sources/${id}`, body, {
          ...headers,
          'if-match': '"2147483647"',
        })
      ).response.status,
    ).toBe(409);
    const closed = await call(owner, 'DELETE', `knowledge/sources/${id}`, body, {
      ...headers,
      'if-match': `"${String(source.body.version)}"`,
    });
    expect(closed.response.status, closed.text).toBe(202);
    expect(closed.body.source_id).toBe(id);
    expect(closed.body).toHaveProperty('retry_requests');
    expect(closed.body.counts).toHaveProperty('artifacts');
    const status = await call(owner, 'GET', `knowledge/sources/${id}/purge`);
    expect(status.response.status).toBe(200);
    if (source.body.document_id)
      expect(
        (await call(owner, 'GET', `knowledge/documents/${String(source.body.document_id)}/content`))
          .response.status,
      ).toBe(404);
  });
});
