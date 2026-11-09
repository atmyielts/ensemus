// API-12 coverage: a running test that sees a documented answer under 400, through the proxy, for knowledge,
// model-workload and artifact-verification operations no other stack suite tests. Every answer is matched
// against docs/specifications/openapi.yaml by contractProblems before a test reads it, and each operation is
// also refused to someone outside the tenant. Generated data only; the one model endpoint named is the stack's
// own in-subnet fake, so nothing here has a way out of the air gap.
import { createHash, randomUUID } from 'node:crypto';
import { addArtifact } from '@ensemus/application';
import {
  openAppDatabase,
  resolveTenantContext,
  type AppDatabase,
  type TenantContext,
} from '@ensemus/database';
import { S3ObjectStore } from '@ensemus/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { knowledgeCanary, seedSearchableSource } from '../helpers/knowledge';
import { GENERATED_MODEL_BOUNDS, seedQualifiedKnowledgeRoute } from '../helpers/knowledge-models';
import { contractProblems } from '../helpers/openapi';
import { proveSecondFactor } from '../helpers/product';
import { secret, urls } from '../helpers/stack';

type Answer = {
  status: number;
  text: string;
  json: Record<string, unknown>;
  headers: Headers;
};

/** The in-subnet fake model (compose.test.yaml), which the stack's workers may reach. */
const FAKE_MODEL_ENDPOINT = 'http://fake-model:8000/v1';

async function sessionOf(person: Person) {
  const response = await fetch(`${BASE}/api/auth/get-session`, {
    headers: { cookie: person.jar.cookie },
  });
  const body = (await response.json()) as { user?: { id?: unknown }; session?: { id?: unknown } };
  if (typeof body.user?.id !== 'string' || typeof body.session?.id !== 'string')
    throw new Error('TEST_SESSION_MISSING');
  return { userId: body.user.id, sessionId: body.session.id };
}

const bounds = {
  max_calls: GENERATED_MODEL_BOUNDS.maxCalls,
  max_input_tokens: GENERATED_MODEL_BOUNDS.maxInputTokens,
  max_output_tokens: GENERATED_MODEL_BOUNDS.maxOutputTokens,
  max_total_tokens: GENERATED_MODEL_BOUNDS.maxTotalTokens,
  max_cost_micros: GENERATED_MODEL_BOUNDS.maxCostMicros,
  timeout_seconds: GENERATED_MODEL_BOUNDS.timeoutSeconds,
};

describe('operations a running test had not reached (API-12)', () => {
  let owner: Person, member: Person, outsider: Person, organization: string;
  let ownerContext: TenantContext;
  let app: { db: AppDatabase; close: () => Promise<void> };

  async function call(
    person: Person,
    method: string,
    suffix: string,
    options: { body?: unknown; form?: FormData; headers?: Record<string, string> } = {},
  ): Promise<Answer> {
    const path = `/api/v1/organizations/${organization}/${suffix}`;
    const response = await fetch(BASE + path, {
      method,
      headers: {
        cookie: person.jar.cookie,
        ...(method === 'GET' ? {} : { origin: BASE }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : options.form
          ? { body: options.form }
          : {}),
      redirect: 'manual',
    });
    const text = await response.text();
    expect(
      contractProblems({ method, path, status: response.status, headers: response.headers, text })
        .problems,
      text,
    ).toEqual([]);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const json = response.headers.get('content-type')?.startsWith('application/json');
    return {
      status: response.status,
      text,
      json: json && text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: response.headers,
    };
  }

  /** The same operation, as someone with no membership here: the ordinary missing answer. */
  async function hiddenFromOutsider(method: string, suffix: string, body?: unknown) {
    const answer = await call(outsider, method, suffix, body === undefined ? {} : { body });
    expect(answer.status, answer.text).toBe(404);
  }

  /** An upload through the API, as a person adds a document. */
  async function upload(classification: 'internal' | 'confidential', words: string) {
    const form = new FormData();
    form.set(
      'metadata',
      JSON.stringify({ title: `Generated source ${randomUUID()}`, classification, grants: [] }),
    );
    form.set('file', new File([words], 'generated.txt', { type: 'text/plain' }));
    const created = await call(owner, 'POST', 'knowledge/sources', {
      form,
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(created.status, created.text).toBe(201);
    return created.json as { id: string; version: number; document_id: string | null };
  }

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    owner = await signUp('API coverage owner');
    organization = await createOrganization(owner, 'Generated API coverage company');
    member = await join(owner, organization, 'API coverage member');
    outsider = await signUp('API coverage outsider');
    await createOrganization(outsider, 'Generated other API coverage company');
    const session = await sessionOf(owner);
    // Model workload approval is an always-MFA action (0404). This proves it for the owner's own session only.
    await proveSecondFactor(session);
    ownerContext = await resolveTenantContext(app.db, session.userId, organization);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
  });

  it('lists the retention rules an owner set', async () => {
    const basis = randomUUID();
    const set = await call(owner, 'POST', 'retention-rules', {
      body: {
        data_category: 'raw_files',
        classification: 'internal',
        retain_days: null,
        basis_ref: basis,
      },
    });
    expect(set.status, set.text).toBe(201);
    const listed = await call(owner, 'GET', 'retention-rules');
    expect(listed.status, listed.text).toBe(200);
    expect(
      (listed.json.items as { basis_ref: string; data_category: string }[]).find(
        (rule) => rule.basis_ref === basis,
      )?.data_category,
    ).toBe('raw_files');
    expect((await call(member, 'GET', 'retention-rules')).status).toBe(404);
    await hiddenFromOutsider('GET', 'retention-rules');
  });

  it('lists a person’s own questions and reads one back', async () => {
    const question = `Generated coverage question ${randomUUID()}`;
    const asked = await call(owner, 'POST', 'knowledge/answers', {
      body: { question },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(asked.status, asked.text).toBe(202);
    const id = String(asked.json.id);
    const listed = await call(owner, 'GET', 'knowledge/answers');
    expect(listed.status, listed.text).toBe(200);
    expect((listed.json.items as { id: string }[]).map((item) => item.id)).toContain(id);
    const one = await call(owner, 'GET', `knowledge/answers/${id}`);
    expect(one.status, one.text).toBe(200);
    expect(one.json.question).toBe(question);
    // Another person's question is theirs alone, inside the tenant as well as outside it.
    expect((await call(member, 'GET', `knowledge/answers/${id}`)).status).toBe(404);
    await hiddenFromOutsider('GET', `knowledge/answers/${id}`);
  });

  it('proposes a fact with evidence, lists and reads it, and has someone else verify it', async () => {
    const words = `Generated evidence ${knowledgeCanary('fact')}`;
    const source = await seedSearchableSource(app.db, ownerContext, {
      passages: [words],
      grants: [{ kind: 'organization' }],
    });
    const proposed = await call(member, 'POST', 'knowledge/facts', {
      body: {
        subject_ref: `knowledge_source:${source.sourceId}`,
        predicate: 'generated.coverage',
        claim: { says: 'generated' },
        evidence: [{ chunk_id: source.chunkIds[0], quote_start: 0, quote_end: words.length }],
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(proposed.status, proposed.text).toBe(201);
    expect(proposed.json.trust_state).toBe('proposed');
    const id = String(proposed.json.id);
    const listed = await call(owner, 'GET', 'knowledge/facts');
    expect(listed.status, listed.text).toBe(200);
    expect((listed.json.items as { id: string }[]).map((item) => item.id)).toContain(id);
    const one = await call(owner, 'GET', `knowledge/facts/${id}`);
    expect(one.status, one.text).toBe(200);
    // The person who proposed it cannot verify it as well (ADR-029).
    const own = await call(member, 'POST', `knowledge/facts/${id}/review`, {
      body: { decision: 'verify', reason: 'Generated self review' },
      headers: { 'if-match': `"${String(one.json.version)}"` },
    });
    expect(own.status, own.text).not.toBe(200);
    const verified = await call(owner, 'POST', `knowledge/facts/${id}/review`, {
      body: { decision: 'verify', reason: 'Generated review against its evidence' },
      headers: { 'if-match': `"${String(one.json.version)}"` },
    });
    expect(verified.status, verified.text).toBe(200);
    expect(verified.json.trust_state).toBe('verified');
    await hiddenFromOutsider('GET', `knowledge/facts/${id}`);
    await hiddenFromOutsider('GET', 'knowledge/facts');
  });

  it('serves an uploaded document’s own bytes as an attachment', async () => {
    const words = `Generated document bytes ${randomUUID()}`;
    const source = await upload('internal', words);
    if (!source.document_id) throw new Error('TEST_DOCUMENT_ID_MISSING');
    const content = await call(owner, 'GET', `knowledge/documents/${source.document_id}/content`);
    expect(content.status, content.text).toBe(200);
    expect(content.text).toBe(words);
    expect(content.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    await hiddenFromOutsider('GET', `knowledge/documents/${source.document_id}/content`);
  });

  it('raises a source’s classification at its exact version, and never lowers it', async () => {
    const source = await upload('internal', `Generated classified words ${randomUUID()}`);
    const stale = await call(owner, 'PATCH', `knowledge/sources/${source.id}/classification`, {
      body: { classification: 'confidential' },
      headers: { 'if-match': '"2147483647"' },
    });
    expect(stale.status, stale.text).toBe(409);
    const raised = await call(owner, 'PATCH', `knowledge/sources/${source.id}/classification`, {
      body: { classification: 'confidential' },
      headers: { 'if-match': `"${source.version}"` },
    });
    expect(raised.status, raised.text).toBe(204);
    const after = await call(owner, 'GET', `knowledge/sources/${source.id}`);
    expect(after.json.classification).toBe('confidential');
    const lowered = await call(owner, 'PATCH', `knowledge/sources/${source.id}/classification`, {
      body: { classification: 'internal' },
      headers: { 'if-match': `"${String(after.json.version)}"` },
    });
    expect(lowered.status, lowered.text).not.toBe(204);
    expect((await call(owner, 'GET', `knowledge/sources/${source.id}`)).json.classification).toBe(
      'confidential',
    );
    await hiddenFromOutsider('PATCH', `knowledge/sources/${source.id}/classification`, {
      classification: 'restricted',
    });
  });

  it('revokes a source at its exact version and reports what its removal reached', async () => {
    const source = await upload('internal', `Generated revoked words ${randomUUID()}`);
    const body = { reason: 'Generated revocation' };
    const stale = await call(owner, 'POST', `knowledge/sources/${source.id}/revoke`, {
      body,
      headers: { 'if-match': '"2147483647"' },
    });
    expect(stale.status, stale.text).toBe(409);
    const revoked = await call(owner, 'POST', `knowledge/sources/${source.id}/revoke`, {
      body,
      headers: { 'if-match': `"${source.version}"` },
    });
    expect(revoked.status, revoked.text).toBe(202);
    expect(revoked.json.source_id).toBe(source.id);
    await hiddenFromOutsider('POST', `knowledge/sources/${source.id}/revoke`, body);
  });

  it('approves a model workload, queues a semantic query under it, reads the job, and revokes it', async () => {
    // The stack's own agent worker runs the qualification against the in-subnet fake, as the outbox
    // wakes it for every requested job. Running it here as well raced that worker for the same job.
    const route = await seedQualifiedKnowledgeRoute(app.db, ownerContext, {
      purpose: 'embed',
      endpointUrl: FAKE_MODEL_ENDPOINT,
      runner: 'stack',
    });
    const approval = {
      kind: 'query',
      scope: 'organization',
      source_id: null,
      connection_id: null,
      purposes: ['embed'],
      qualification_ids: [route.qualificationId],
      max_classification: 'internal',
      bounds,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      request_key: randomUUID(),
    };
    // Nobody but a manager in a recent second-factor session approves a workload.
    expect(
      (await call(member, 'POST', 'knowledge/workload-approvals', { body: approval })).status,
    ).not.toBe(201);
    const approved = await call(owner, 'POST', 'knowledge/workload-approvals', { body: approval });
    expect(approved.status, approved.text).toBe(201);
    const approvalId = String(approved.json.approval_id);
    const listed = await call(owner, 'GET', 'knowledge/workload-approvals');
    expect(listed.status, listed.text).toBe(200);
    expect((listed.json.items as { id: string }[]).map((item) => item.id)).toContain(approvalId);

    const job = {
      approval_id: approvalId,
      request_key: randomUUID(),
      bounds,
      classification: 'internal',
      query: `Generated semantic query ${randomUUID()}`,
    };
    // A query above the classification the approval allows is refused, and queues nothing.
    expect(
      (
        await call(owner, 'POST', 'knowledge/model-jobs', {
          body: { ...job, request_key: randomUUID(), classification: 'restricted' },
        })
      ).status,
    ).not.toBe(202);
    const queued = await call(owner, 'POST', 'knowledge/model-jobs', { body: job });
    expect(queued.status, queued.text).toBe(202);
    const jobId = String(queued.json.job_id);
    const read = await call(owner, 'GET', `knowledge/model-jobs/${jobId}`);
    expect(read.status, read.text).toBe(200);
    expect(read.json.job_id).toBe(jobId);
    expect(read.json.kind).toBe('query');
    await hiddenFromOutsider('GET', `knowledge/model-jobs/${jobId}`);

    const revoked = await call(owner, 'DELETE', `knowledge/workload-approvals/${approvalId}`);
    expect(revoked.status, revoked.text).toBe(204);
    // Nothing more runs under a revoked approval.
    expect(
      (
        await call(owner, 'POST', 'knowledge/model-jobs', {
          body: { ...job, request_key: randomUUID() },
        })
      ).status,
    ).not.toBe(202);
    await hiddenFromOutsider('GET', 'knowledge/workload-approvals');
    await hiddenFromOutsider('DELETE', `knowledge/workload-approvals/${approvalId}`);
  });

  it('shows an artifact’s verification and records a person’s rejection of its exact bytes', async () => {
    const work = await call(owner, 'POST', 'work-units', {
      body: {
        title: `Generated verified work ${randomUUID()}`,
        objective: 'Verification coverage',
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(work.status, work.text).toBe(201);
    const workUnitId = String(work.json.id);
    const bytes = Buffer.from(`Generated artifact ${randomUUID()}`);
    const objects = new S3ObjectStore({
      endpoint: `http://127.0.0.1:${process.env.ENSEMUS_TEST_OBJECTS_PORT ?? '58333'}`,
      bucket: 'ensemus',
      accessKey: secret('objects_access_key'),
      secretKey: secret('objects_secret_key'),
    });
    let artifactId: string;
    try {
      artifactId = (
        await addArtifact(app.db, objects, ownerContext, {
          workUnitId,
          name: 'generated.txt',
          mimeType: 'text/plain',
          body: bytes,
        })
      ).id;
    } finally {
      objects.close();
    }
    const path = `work-units/${workUnitId}/artifacts/${artifactId}/verification`;
    const shown = await call(owner, 'GET', path);
    expect(shown.status, shown.text).toBe(200);
    expect(shown.json.artifact_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(shown.json.human).toBeNull();
    // A decision on other bytes than the ones shown is refused.
    const changed = await call(owner, 'POST', path, {
      body: { artifact_sha256: '0'.repeat(64), verdict: 'rejected', reason: 'Generated' },
    });
    expect(changed.status, changed.text).not.toBe(200);
    const rejected = await call(owner, 'POST', path, {
      body: {
        artifact_sha256: shown.json.artifact_sha256,
        verdict: 'rejected',
        reason: 'Generated rejection of these exact bytes',
      },
    });
    expect(rejected.status, rejected.text).toBe(200);
    expect((rejected.json.human as { verdict: string } | null)?.verdict).toBe('rejected');
    await hiddenFromOutsider('GET', path);
  });
});
