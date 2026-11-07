// Actual proxy/SQL/worker/native-MFA journey. Authored until the built stack gate runs.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASE,
  PASSWORD,
  assembled,
  createOrganization,
  join,
  signUp,
  submit,
  type Person,
} from '../helpers/forms';
import { contractProblems, operationName, operations } from '../helpers/openapi';
import { testAnswers } from '../helpers/product';
import { totpFromUri } from '../helpers/totp';
import { urls } from '../helpers/stack';

describe('Studio actual HTTP contracts and synthetic rehearsal', () => {
  let owner: Person, member: Person, foreign: Person, org: string, ownerId: string, su: pg.Client;
  const validated = new Set<string>();
  beforeAll(async () => {
    owner = await signUp('Generated Studio owner');
    org = await createOrganization(owner, 'Generated Studio company');
    member = await join(owner, org, 'Generated Studio member');
    foreign = await signUp('Generated Studio outsider');
    await createOrganization(foreign, 'Other generated Studio company');
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    ownerId = (
      await su.query<{ id: string }>(
        'select m.id from org.memberships m join identity.users u on u.id=m.user_id where m.organization_id=$1 and u.email=$2',
        [org, owner.email],
      )
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await su?.end();
  });
  async function call(
    person: Person | undefined,
    method: string,
    suffix: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const path = `/api/v1/organizations/${org}/studio/${suffix}`,
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
  it('denies anonymous/member/foreign and cross-origin attempts before effects', async () => {
    expect((await call(undefined, 'GET', 'agent-drafts')).status).toBe(401);
    expect((await call(member, 'GET', 'agent-drafts')).status).toBe(403);
    expect((await call(foreign, 'GET', 'agent-drafts')).status).toBe(404);
    expect(
      (
        await call(
          owner,
          'POST',
          'agent-drafts',
          { name: 'Generated denied draft', answers: testAnswers(ownerId) },
          { origin: 'https://example.invalid', 'idempotency-key': randomUUID() },
        )
      ).status,
    ).toBe(403);
  });
  it('validates all Studio operations with real rehearsal, MFA, publication and optimistic/idempotent writes', async () => {
    const key = randomUUID(),
      input = { name: `Generated reviewed ${randomUUID()}`, answers: testAnswers(ownerId) },
      [first, repeated] = await Promise.all([
        call(owner, 'POST', 'agent-drafts', input, { 'idempotency-key': key }),
        call(owner, 'POST', 'agent-drafts', input, { 'idempotency-key': key }),
      ]);
    expect(first.status).toBe(201);
    expect(repeated.body?.id).toBe(first.body?.id);
    expect(
      (
        await call(
          owner,
          'POST',
          'agent-drafts',
          { ...input, name: 'Changed intent' },
          { 'idempotency-key': key },
        )
      ).status,
    ).toBe(409);
    const agentPath = `agent-drafts/${String(first.body?.id)}`;
    expect((await call(owner, 'GET', 'agent-drafts')).status).toBe(200);
    expect((await call(owner, 'GET', agentPath)).status).toBe(200);
    expect((await call(owner, 'PATCH', agentPath, { name: input.name })).status).toBe(428);
    const patched = await call(
      owner,
      'PATCH',
      agentPath,
      { name: input.name },
      { 'if-match': first.headers.get('etag')! },
    );
    expect(patched.status).toBe(200);
    // A real authenticator enrollment; no SQL proof or copied session UUID authorizes publication.
    const security = `/o/${org}/security/two-factor`,
      prepared = await submit(security, owner.jar, /Set up authenticator app/, {
        password: PASSWORD,
      }),
      uri = /href="(otpauth:\/\/[^"]+)"/
        .exec(assembled(await prepared.text()))?.[1]
        ?.replaceAll('&amp;', '&');
    if (!uri) throw new Error('TEST_STUDIO_NATIVE_MFA_SETUP_MISSING');
    expect(
      (
        await submit(security, owner.jar, /Finish setup/, {
          kind: 'totp',
          code: totpFromUri(uri, Date.now() - 30000),
        })
      ).status,
    ).toBe(303);
    const process = await call(
        owner,
        'POST',
        'process-drafts',
        { name: 'Generated process rehearsal', classification: 'internal' },
        { 'idempotency-key': randomUUID() },
      ),
      processPath = `process-drafts/${String(process.body?.id)}`;
    expect(process.status).toBe(201);
    expect((await call(owner, 'GET', 'process-drafts')).status).toBe(200);
    expect((await call(owner, 'GET', processPath)).status).toBe(200);
    const graph = {
      schemaVersion: 1,
      nodes: [
        { id: 'start', kind: 'start', label: 'Start', x: 0, y: 0 },
        { id: 'prepare', kind: 'work_item', label: 'Prepare a result', x: 100, y: 0 },
        { id: 'end', kind: 'end', label: 'Finish', x: 200, y: 0 },
      ],
      edges: [
        { from: 'start', to: 'prepare' },
        { from: 'prepare', to: 'end' },
      ],
    };
    expect(
      (
        await call(
          owner,
          'PATCH',
          processPath,
          { graph },
          { 'if-match': process.headers.get('etag')! },
        )
      ).status,
    ).toBe(200);
    for (const [path, kind, scenario] of [
      [agentPath, 'agent_draft', 'standard.draft_only'],
      [processPath, 'process_draft', 'standard.process'],
    ] as const) {
      const queued = await call(
        owner,
        'POST',
        `${path}/simulations`,
        { scenario_key: scenario },
        { 'idempotency-key': randomUUID() },
      );
      expect(queued.status).toBe(202);
      const simulationId = String(queued.body?.id);
      await expect
        .poll(
          async () =>
            String((await call(owner, 'GET', `simulations/${simulationId}`)).body?.status),
          { timeout: 45000, interval: 250 },
        )
        .toBe('passed');
      const cancelled = await call(
        owner,
        'POST',
        'publish-reviews',
        { subject_kind: kind, subject_id: path.split('/')[1], simulation_run_id: simulationId },
        { 'idempotency-key': randomUUID() },
      );
      expect(cancelled.status).toBe(201);
      expect(
        (
          await call(owner, 'DELETE', `publish-reviews/${String(cancelled.body?.id)}`, undefined, {
            'if-match': cancelled.headers.get('etag')!,
          })
        ).status,
      ).toBe(204);
      const review = await call(
        owner,
        'POST',
        'publish-reviews',
        { subject_kind: kind, subject_id: path.split('/')[1], simulation_run_id: simulationId },
        { 'idempotency-key': randomUUID() },
      );
      expect(review.status).toBe(201);
      const reviewPath = `publish-reviews/${String(review.body?.id)}`;
      expect((await call(owner, 'GET', reviewPath)).status).toBe(200);
      expect(
        (
          await call(
            owner,
            'POST',
            `${reviewPath}/decisions`,
            { decision: 'approved', session_id: randomUUID() },
            { 'if-match': review.headers.get('etag')!, 'idempotency-key': randomUUID() },
          )
        ).status,
      ).toBe(400);
      const approved = await call(
        owner,
        'POST',
        `${reviewPath}/decisions`,
        { decision: 'approved' },
        { 'if-match': review.headers.get('etag')!, 'idempotency-key': randomUUID() },
      );
      expect(approved.status).toBe(200);
      const publishKey = randomUUID(),
        published = await call(owner, 'POST', `${reviewPath}/publication`, undefined, {
          'if-match': approved.headers.get('etag')!,
          'idempotency-key': publishKey,
        });
      expect(published.status).toBe(200);
      expect(published.body?.status).toBe('published');
      expect(
        (
          await call(owner, 'POST', `${reviewPath}/publication`, undefined, {
            'if-match': approved.headers.get('etag')!,
            'idempotency-key': publishKey,
          })
        ).body?.published_ref,
      ).toBe(published.body?.published_ref);
    }
    expect((await call(owner, 'GET', 'publish-reviews')).status).toBe(200);
    const implemented = operations()
      .filter((op) => op.path.includes('/studio/') && op.status === undefined)
      .map((operation) => operationName(operation.method, operation.path));
    expect(implemented).toHaveLength(17);
    expect([...validated].sort()).toEqual(implemented.sort());
  });
});
