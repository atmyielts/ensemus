// API-12, API-13, NEXT-01: the public /api/v1 contract against built images, through the proxy.
// Every response goes through call(), which validates it against docs/specifications/openapi.yaml at
// run time (see tests/helpers/openapi.ts). The generated types then only name what was validated.
import { randomUUID } from 'node:crypto';
import {
  connections,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
} from '@ensemus/database';
import { EMAIL_CONNECTOR_TYPE } from '@ensemus/domain/external-action';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { components } from '../../packages/contracts/generated/openapi';
import {
  contractProblems,
  operationName,
  operations,
  requestLimit,
  spec,
  validatedOperations,
} from '../helpers/openapi';
import {
  BASE,
  createOrganization,
  formOn,
  join,
  type Jar,
  type Person,
  read,
  signUp,
  submit,
} from '../helpers/forms';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';

type WorkUnit = components['schemas']['WorkUnit'];
type ApiError = components['schemas']['Error'];
type PendingApproval = components['schemas']['PendingApproval'];
type Approval = components['schemas']['Approval'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What must never reach a client: SQL, parameters, ORM wording, or anything from a stack trace. */
const INTERNALS =
  /\bselect\b[\s\S]*\bfrom\b|insert into|update \S+ set|delete from|stack|postgres|drizzle|node_modules|\bat \S+:\d+:\d+/i;

/**
 * Fails the test if this response is not what the contract says. A matching response under 400 is recorded by
 * contractProblems itself, in the record every stack suite of this run shares (tests/helpers/openapi.ts).
 */
function checkContract(
  method: string,
  path: string,
  status: number,
  headers: Headers,
  text?: string,
) {
  const { problems } = contractProblems({
    method,
    path,
    status,
    headers,
    ...(text === undefined ? {} : { text }),
  });
  expect(problems).toEqual([]);
}

type Result = { status: number; headers: Headers; text: string; json: unknown };

type CallOptions = {
  body?: unknown;
  raw?: string | Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  /** The Origin to send on a write. Null sends none. */
  origin?: string | null;
  key?: string;
};

async function call(
  person: Person | undefined,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Result> {
  const payload =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = {
    ...(person ? { cookie: person.jar.cookie } : {}),
    ...(method !== 'GET' && options.origin !== null ? { origin: options.origin ?? BASE } : {}),
    ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.key ? { 'idempotency-key': options.key } : {}),
    ...options.headers,
  };
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    redirect: 'manual',
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await response.text();
  checkContract(method, path, response.status, response.headers, text);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function expectError(result: Result, status: number, code?: string): ApiError {
  expect(result.status, result.text).toBe(status);
  expect(result.text).not.toMatch(INTERNALS);
  const error = result.json as ApiError;
  expect(error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  if (code) expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.request_id).toMatch(UUID);
  expect(result.headers.get('x-request-id')).toBe(error.request_id);
  expect(result.headers.get('cache-control')).toContain('no-store');
  return error;
}

/** call() has already validated the body against the spec, so this only names its type. */
const asWorkUnit = (value: unknown) => value as WorkUnit;

const workUnits = (organization: string) => `/api/v1/organizations/${organization}/work-units`;
const workUnit = (organization: string, id: string) => `${workUnits(organization)}/${id}`;
const dependencies = (organization: string, id: string) =>
  `${workUnit(organization, id)}/dependencies`;
const events = (organization: string, id: string) => `${workUnit(organization, id)}/events`;
const decisions = (organization: string, id: string) =>
  `/api/v1/organizations/${organization}/approvals/${id}/decisions`;

const sessionCookieName = spec.components.securitySchemes.sessionCookie?.name as string;

describe('public API', () => {
  let su: pg.Client;
  let owner: Person;
  let member: Person;
  let reviewer: Person;
  let rival: Person;
  let org: string;
  let rivalOrg: string;

  const titleCount = async (title: string) => {
    const { rows } = await su.query(
      'select count(*)::int as n from work.work_units where title = $1',
      [title],
    );
    return rows[0].n as number;
  };

  async function membershipOf(person: Person, organization = org): Promise<string> {
    const { rows } = await su.query(
      `select m.id from org.memberships m join identity.users u on u.id = m.user_id
       where u.email = $1 and m.organization_id = $2`,
      [person.email, organization],
    );
    if (!rows[0]) throw new Error('No membership');
    return rows[0].id;
  }

  async function createWork(person = owner, organization = org, title = `Work ${randomUUID()}`) {
    const result = await call(person, 'POST', workUnits(organization), {
      body: { title, objective: 'Written by a test' },
      key: randomUUID(),
    });
    expect(result.status, result.text).toBe(201);
    return asWorkUnit(result.json);
  }

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Ada Owner');
    org = await createOrganization(owner, `API ${randomUUID()}`);
    member = await join(owner, org, 'Max Member');
    reviewer = await join(owner, org, 'Rae Reviewer');
    rival = await signUp('Ron Rival');
    rivalOrg = await createOrganization(rival, `Rival ${randomUUID()}`);
  });

  afterAll(() => su?.end());

  describe('creating work with an Idempotency-Key', () => {
    it('creates once and states the version', async () => {
      const title = `Create ${randomUUID()}`;
      const result = await call(owner, 'POST', workUnits(org), {
        body: { title, objective: 'The outcome', due_at: '2031-01-02T03:04:05.000Z' },
        key: randomUUID(),
      });
      expect(result.status).toBe(201);
      const work = asWorkUnit(result.json);
      expect(work).toMatchObject({
        organization_id: org,
        title,
        objective: 'The outcome',
        status: 'queued',
        version: 1,
        due_at: '2031-01-02T03:04:05.000Z',
      });
      expect(result.headers.get('etag')).toBe('"1"');
      expect(result.headers.get('cache-control')).toContain('no-store');
    });

    it('replays the first answer for the same key and request, and does the work once', async () => {
      const key = randomUUID();
      const title = `Replay ${randomUUID()}`;
      const body = { title, objective: 'Only once' };
      const first = await call(owner, 'POST', workUnits(org), { body, key });
      const second = await call(owner, 'POST', workUnits(org), { body, key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.json).toEqual(first.json);
      expect(await titleCount(title)).toBe(1);
    });

    it('gives two racing requests one result', async () => {
      const key = randomUUID();
      const title = `Race ${randomUUID()}`;
      const body = { title, objective: 'Only once' };
      const results = await Promise.all(
        Array.from({ length: 4 }, () => call(owner, 'POST', workUnits(org), { body, key })),
      );
      for (const result of results) {
        expect(result.status, result.text).toBe(201);
        expect(result.json).toEqual(results[0]?.json);
      }
      expect(await titleCount(title)).toBe(1);
    });

    it('refuses the same key on a different request', async () => {
      const key = randomUUID();
      const first = `Original ${randomUUID()}`;
      const second = `Different ${randomUUID()}`;
      await call(owner, 'POST', workUnits(org), { body: { title: first, objective: 'x' }, key });
      const conflict = await call(owner, 'POST', workUnits(org), {
        body: { title: second, objective: 'x' },
        key,
      });
      expectError(conflict, 409, 'IDEMPOTENCY_KEY_REUSED');
      expect(await titleCount(second)).toBe(0);
    });

    it('keeps one person’s keys apart from another’s', async () => {
      const key = randomUUID();
      const body = { title: `Shared ${randomUUID()}`, objective: 'x' };
      const mine = await call(owner, 'POST', workUnits(org), { body, key });
      const theirs = await call(member, 'POST', workUnits(org), { body, key });
      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      expect(asWorkUnit(theirs.json).id).not.toBe(asWorkUnit(mine.json).id);
    });

    it('needs a usable key', async () => {
      const body = { title: `Keyless ${randomUUID()}`, objective: 'x' };
      expectError(await call(owner, 'POST', workUnits(org), { body }), 400, 'INVALID_INPUT');
      expectError(
        await call(owner, 'POST', workUnits(org), { body, key: 'short' }),
        400,
        'INVALID_INPUT',
      );
      expect(await titleCount(body.title)).toBe(0);
    });

    it('stores nothing for a request that fails, so it can be retried', async () => {
      const key = randomUUID();
      const title = `Retry ${randomUUID()}`;
      const missingProject = await call(owner, 'POST', workUnits(org), {
        body: { title, objective: 'x', project_id: randomUUID() },
        key,
      });
      expectError(missingProject, 400, 'INVALID_INPUT');
      expect(await titleCount(title)).toBe(0);
      const retried = await call(owner, 'POST', workUnits(org), {
        body: { title, objective: 'x' },
        key,
      });
      expect(retried.status).toBe(201);
    });
  });

  describe('reading work', () => {
    it('lists a permission-filtered page in the documented shape', async () => {
      const work = await createWork();
      const list = await call(owner, 'GET', workUnits(org));
      expect(list.status).toBe(200);
      expect(list.headers.get('cache-control')).toContain('no-store');
      const page = list.json as { items: unknown[]; next_cursor: string | null };
      expect(Object.keys(page).sort()).toEqual(['items', 'next_cursor']);
      const items = page.items.map(asWorkUnit);
      expect(items.map((item) => item.id)).toContain(work.id);
      expect(new Set(items.map((item) => item.organization_id))).toEqual(new Set([org]));
    });

    it('filters by status, and refuses a status or cursor it does not know', async () => {
      const work = await createWork();
      const none = await call(owner, 'GET', `${workUnits(org)}?status=completed`);
      const items = (none.json as { items: unknown[] }).items.map(asWorkUnit);
      expect(items.map((item) => item.id)).not.toContain(work.id);
      expect(items.every((item) => item.status === 'completed')).toBe(true);
      expectError(await call(owner, 'GET', `${workUnits(org)}?status=bogus`), 400, 'INVALID_INPUT');
      expectError(
        await call(owner, 'GET', `${workUnits(org)}?cursor=bm90LWEtY3Vyc29y`),
        400,
        'INVALID_INPUT',
      );
    });

    it('pages through more work than fits on one page, without repeating any', async () => {
      const person = await signUp('Paging Owner');
      const paged = await createOrganization(person, `Paging ${randomUUID()}`);
      const created = await Promise.all(
        Array.from({ length: 52 }, () => createWork(person, paged)),
      );
      const first = (await call(person, 'GET', workUnits(paged))).json as {
        items: WorkUnit[];
        next_cursor: string | null;
      };
      expect(first.items).toHaveLength(50);
      expect(first.next_cursor).toEqual(expect.any(String));
      const next = await call(
        person,
        'GET',
        `${workUnits(paged)}?cursor=${encodeURIComponent(first.next_cursor as string)}`,
      );
      const second = next.json as { items: WorkUnit[]; next_cursor: string | null };
      expect(second.items).toHaveLength(2);
      expect(second.next_cursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
        new Set(created.map((item) => item.id)),
      );
    });

    it('gets one, with its version as an entity tag', async () => {
      const work = await createWork();
      const result = await call(owner, 'GET', workUnit(org, work.id));
      expect(result.status).toBe(200);
      expect(asWorkUnit(result.json)).toEqual(work);
      expect(result.headers.get('etag')).toBe('"1"');
    });

    it('hides restricted work from a member in both the list and the read', async () => {
      const title = `Restricted ${randomUUID()}`;
      const created = await submit(`/o/${org}/work/new`, owner.jar, /name="title"/, {
        title,
        classification: 'restricted',
      });
      const id = /\/work\/([0-9a-f-]{36})$/.exec(created.headers.get('location') ?? '')?.[1];
      if (!id) throw new Error('Work not created');
      expect((await call(owner, 'GET', workUnit(org, id))).status).toBe(200);

      const list = await call(member, 'GET', workUnits(org));
      expect(list.status).toBe(200);
      expect(list.text).not.toContain(title);
      expect(list.text).not.toContain(id);
      const single = await call(member, 'GET', workUnit(org, id));
      expectError(single, 404, 'NOT_FOUND');
      expect(single.text).not.toContain(title);
      expectError(
        await call(member, 'PATCH', workUnit(org, id), {
          body: { title: 'Changed' },
          headers: { 'if-match': '"1"' },
        }),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('changing work with If-Match', () => {
    it('updates against the current version and moves the version on', async () => {
      const work = await createWork();
      const result = await call(owner, 'PATCH', workUnit(org, work.id), {
        body: { title: 'New title', objective: 'New objective', due_at: null },
        headers: { 'if-match': '"1"' },
      });
      expect(result.status).toBe(200);
      expect(asWorkUnit(result.json)).toMatchObject({
        title: 'New title',
        objective: 'New objective',
        due_at: null,
        version: 2,
      });
      expect(result.headers.get('etag')).toBe('"2"');
    });

    it('refuses a stale version, and leaves the later change in place', async () => {
      const work = await createWork();
      await call(owner, 'PATCH', workUnit(org, work.id), {
        body: { title: 'Saved first' },
        headers: { 'if-match': '"1"' },
      });
      const stale = await call(owner, 'PATCH', workUnit(org, work.id), {
        body: { title: 'Saved later from old data' },
        headers: { 'if-match': '"1"' },
      });
      expectError(stale, 409, 'VERSION_CONFLICT');
      const current = await call(owner, 'GET', workUnit(org, work.id));
      expect(asWorkUnit(current.json)).toMatchObject({ title: 'Saved first', version: 2 });
    });

    it('lets one of two racing writers win', async () => {
      const work = await createWork();
      const results = await Promise.all(
        ['A', 'B'].map((title) =>
          call(owner, 'PATCH', workUnit(org, work.id), {
            body: { title },
            headers: { 'if-match': '"1"' },
          }),
        ),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    });

    it('needs one exact version', async () => {
      const work = await createWork();
      const patch = (headers: Record<string, string>, body: unknown = { title: 'x' }) =>
        call(owner, 'PATCH', workUnit(org, work.id), { body, headers });
      expectError(await patch({}), 428, 'PRECONDITION_REQUIRED');
      for (const value of ['*', 'W/"1"', '"1", "2"', '"one"', '0', '99999999999']) {
        expectError(await patch({ 'if-match': value }), 400, 'INVALID_INPUT');
      }
      expectError(await patch({ 'if-match': '"1"' }, {}), 400, 'INVALID_INPUT');
      expectError(await patch({ 'if-match': '"1"' }, { status: 'completed' }), 400);
      const current = await call(owner, 'GET', workUnit(org, work.id));
      expect(asWorkUnit(current.json).version).toBe(1);
    });

    it('accepts a member reading internal work, but not changing it', async () => {
      const work = await createWork();
      expect((await call(member, 'GET', workUnit(org, work.id))).status).toBe(200);
      expectError(
        await call(member, 'PATCH', workUnit(org, work.id), {
          body: { title: 'Not theirs' },
          headers: { 'if-match': '"1"' },
        }),
        403,
        'FORBIDDEN',
      );
    });
  });

  describe('dependencies', () => {
    const depend = (id: string, prerequisite: string) =>
      call(owner, 'POST', dependencies(org, id), { body: { prerequisite_id: prerequisite } });

    it('adds a prerequisite, and refuses a direct or indirect cycle', async () => {
      const [a, b, c] = [await createWork(), await createWork(), await createWork()];
      expect((await depend(a.id, b.id)).status).toBe(201);
      expect((await depend(b.id, c.id)).status).toBe(201);
      expectError(await depend(b.id, a.id), 409, 'DEPENDENCY_CYCLE');
      expectError(await depend(c.id, a.id), 409, 'DEPENDENCY_CYCLE');
      expectError(await depend(a.id, a.id), 409, 'DEPENDENCY_CYCLE');
      // The same work whichever spelling names it, on either side.
      expectError(await depend(a.id, a.id.toUpperCase()), 409, 'DEPENDENCY_CYCLE');
      expectError(await depend(a.id.toUpperCase(), a.id), 409, 'DEPENDENCY_CYCLE');
    });

    it('treats adding the same prerequisite again as done', async () => {
      const [a, b] = [await createWork(), await createWork()];
      expect((await depend(a.id, b.id)).status).toBe(201);
      expect((await depend(a.id, b.id)).status).toBe(201);
    });

    it('refuses a malformed body or a prerequisite that cannot be seen', async () => {
      const a = await createWork();
      expectError(
        await call(owner, 'POST', dependencies(org, a.id), { body: { prerequisite_id: 'nope' } }),
        400,
        'INVALID_INPUT',
      );
      expectError(await depend(a.id, randomUUID()), 404, 'NOT_FOUND');
      const theirs = await createWork(rival, rivalOrg);
      expectError(await depend(a.id, theirs.id), 404, 'NOT_FOUND');
    });
  });

  describe('reading approvals', () => {
    const approvals = (organization: string) => `/api/v1/organizations/${organization}/approvals`;

    it('gives a client what it needs to decide, with no page to scrape', async () => {
      const work = await createWork();
      const page = `/o/${org}/work/${work.id}`;
      await submit(page, owner.jar, /Request review/, {
        approverMembershipId: await membershipOf(reviewer),
      });

      const listed = await call(reviewer, 'GET', approvals(org));
      expect(listed.status).toBe(200);
      const { items } = listed.json as { items: PendingApproval[] };
      const item = items.find((entry) => entry.work_unit_id === work.id);
      if (!item) throw new Error('Approval not listed');

      const read = await call(reviewer, 'GET', `${approvals(org)}/${item.id}`);
      expect(read.status).toBe(200);
      const approval = read.json as Approval;
      expect(approval.status).toBe('pending');
      expect(approval.action).toBeTruthy();

      const decided = await call(reviewer, 'POST', decisions(org, item.id), {
        body: { decision: 'approve', action_hash: approval.action_hash },
      });
      expect(decided.status).toBe(200);
    });

    it('hides an approval from another tenant, and from anyone not signed in', async () => {
      const work = await createWork();
      await submit(`/o/${org}/work/${work.id}`, owner.jar, /Request review/, {
        approverMembershipId: await membershipOf(reviewer),
      });
      const { rows } = await su.query('select id from work.approvals where work_unit_id = $1', [
        work.id,
      ]);
      const id = rows[0].id as string;
      expectError(
        await call(rival, 'GET', `/api/v1/organizations/${org}/approvals/${id}`),
        404,
        'NOT_FOUND',
      );
      expectError(await call(rival, 'GET', `${approvals(rivalOrg)}/${id}`), 404, 'NOT_FOUND');
      expectError(
        await call(undefined, 'GET', `/api/v1/organizations/${org}/approvals/${id}`),
        401,
        'UNAUTHENTICATED',
      );
    });
  });

  describe('completion criteria', () => {
    it('refuses one nothing can ever satisfy, rather than leaving work that cannot finish', async () => {
      const result = await call(owner, 'POST', workUnits(org), {
        body: {
          title: 'Needs a receipt',
          objective: 'Written by a test',
          completion_criteria: { external_receipt: true },
        },
        key: randomUUID(),
      });
      expectError(result, 400, 'INVALID_INPUT');
    });
  });

  describe('approval decisions', () => {
    /** Asks through the work page, and takes the hash the approver's page would show. */
    async function askForReview() {
      const work = await createWork();
      const page = `/o/${org}/work/${work.id}`;
      await submit(page, owner.jar, /Request review/, {
        approverMembershipId: await membershipOf(reviewer),
      });
      const id = /\/approvals\/([0-9a-f-]{36})"/.exec((await read(page, owner.jar)).html)?.[1];
      if (!id) throw new Error('No approval link');
      const form = await formOn(
        `/o/${org}/approvals/${id}`,
        reviewer.jar,
        (f) => f.hidden.get('decision') === 'approve',
      );
      const hash = form.hidden.get('shownHash');
      if (!hash) throw new Error('No hash on the approval page');
      return { id, hash };
    }

    const statusOf = async (id: string) => {
      const { rows } = await su.query('select status from work.approvals where id = $1', [id]);
      return rows[0].status as string;
    };

    it('records a decision on the exact action, once', async () => {
      const { id, hash } = await askForReview();
      const body = { decision: 'approve', action_hash: hash, reason: 'Looks right' };
      const decided = await call(reviewer, 'POST', decisions(org, id), { body });
      expect(decided.status, decided.text).toBe(200);
      expect(await statusOf(id)).toBe('approved');
      expectError(
        await call(reviewer, 'POST', decisions(org, id), { body }),
        409,
        'APPROVAL_NOT_PENDING',
      );
    });

    it('records a denial', async () => {
      const { id, hash } = await askForReview();
      const decided = await call(reviewer, 'POST', decisions(org, id), {
        body: { decision: 'deny', action_hash: hash },
      });
      expect(decided.status).toBe(200);
      expect(await statusOf(id)).toBe('denied');
    });

    it('refuses a changed action, the wrong person, and the wrong tenant', async () => {
      const { id, hash } = await askForReview();
      const body = { decision: 'approve', action_hash: hash };
      expectError(
        await call(reviewer, 'POST', decisions(org, id), {
          body: { decision: 'approve', action_hash: 'f'.repeat(64) },
        }),
        409,
        'APPROVAL_HASH_MISMATCH',
      );
      expectError(
        await call(owner, 'POST', decisions(org, id), { body }),
        403,
        'APPROVAL_WRONG_APPROVER',
      );
      expectError(
        await call(member, 'POST', decisions(org, id), { body }),
        403,
        'APPROVAL_WRONG_APPROVER',
      );
      expectError(await call(rival, 'POST', decisions(rivalOrg, id), { body }), 404, 'NOT_FOUND');
      expectError(await call(rival, 'POST', decisions(org, id), { body }), 404, 'NOT_FOUND');
      expect(await statusOf(id)).toBe('pending');
    });

    it('reports an approval past its time as expired, before anything has settled it', async () => {
      const { id, hash } = await askForReview();
      await su.query(
        `update work.approvals set expires_at = now() - interval '1 minute' where id = $1`,
        [id],
      );
      const shown = await call(reviewer, 'GET', `/api/v1/organizations/${org}/approvals/${id}`);
      expect(shown.status).toBe(200);
      expect((shown.json as Approval).status).toBe('expired');
      // The row still says pending, and the page, the API and a decision all agree that it is not.
      expect(await statusOf(id)).toBe('pending');
      expectError(
        await call(reviewer, 'POST', decisions(org, id), {
          body: { decision: 'approve', action_hash: hash },
        }),
        409,
        'APPROVAL_EXPIRED',
      );
      expect((await read(`/o/${org}/approvals/${id}`, reviewer.jar)).html).toContain('Expired');
    });

    it('needs a reason to stop paused work for good, the same as the form does', async () => {
      const work = await createWork();
      const page = `/o/${org}/work/${work.id}`;
      for (const to of ['ready', 'running']) {
        await submit(page, owner.jar, (form) => form.hidden.get('to') === to);
      }
      await submit(page, owner.jar, /Request review/, {
        approverMembershipId: await membershipOf(reviewer),
      });
      const id = /\/approvals\/([0-9a-f-]{36})"/.exec((await read(page, owner.jar)).html)?.[1];
      if (!id) throw new Error('No approval link');
      const { rows } = await su.query('select action_hash from work.approvals where id = $1', [id]);
      const body = { decision: 'deny', action_hash: rows[0].action_hash as string };

      for (const silent of [body, { ...body, reason: '   ' }]) {
        expectError(
          await call(reviewer, 'POST', decisions(org, id), { body: silent }),
          400,
          'REASON_REQUIRED',
        );
      }
      expect(await statusOf(id)).toBe('pending');
      expect((await call(owner, 'GET', workUnit(org, work.id))).json).toMatchObject({
        status: 'awaiting_approval',
      });

      const denied = await call(reviewer, 'POST', decisions(org, id), {
        body: { ...body, reason: 'Not this way' },
      });
      expect(denied.status, denied.text).toBe(200);
      expect((await call(owner, 'GET', workUnit(org, work.id))).json).toMatchObject({
        status: 'cancelled',
      });
    });

    it('refuses a malformed decision', async () => {
      const { id, hash } = await askForReview();
      for (const body of [
        { decision: 'maybe', action_hash: hash },
        { decision: 'approve', action_hash: 'short' },
        { decision: 'approve' },
        { decision: 'approve', action_hash: hash, extra: true },
        { decision: 'approve', action_hash: hash, reason: 'x'.repeat(2001) },
      ]) {
        expectError(await call(reviewer, 'POST', decisions(org, id), { body }), 400);
      }
      expect(await statusOf(id)).toBe('pending');
    });
  });

  describe('malformed requests', () => {
    const post = (options: CallOptions) =>
      call(owner, 'POST', workUnits(org), { key: randomUUID(), ...options });

    it('answers malformed JSON with a 400 that does not echo it', async () => {
      const canary = `canary${randomUUID()}`;
      const result = await post({ raw: `{"title": "${canary}", oops` });
      expectError(result, 400, 'INVALID_INPUT');
      expect(result.text).not.toContain(canary);
    });

    it('refuses text that is not valid UTF-8', async () => {
      expectError(
        await post({ raw: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }),
        400,
        'INVALID_INPUT',
      );
    });

    it('refuses JSON of the wrong shape, naming fields but not values', async () => {
      const canary = `canary${randomUUID()}`;
      for (const raw of ['[]', 'null', '"text"', '{}']) {
        expectError(await post({ raw }), 400, 'INVALID_INPUT');
      }
      const longTitle = await post({ body: { title: 'x'.repeat(301), objective: 'x' } });
      expect(expectError(longTitle, 400, 'INVALID_INPUT').details).toEqual({ fields: ['title'] });
      const wrongType = await post({ body: { title: canary, objective: 42 } });
      expect(expectError(wrongType, 400, 'INVALID_INPUT').details).toEqual({
        fields: ['objective'],
      });
      expect(wrongType.text).not.toContain(canary);
      const badDate = await post({ body: { title: canary, objective: 'x', due_at: 'tomorrow' } });
      expectError(badDate, 400, 'INVALID_INPUT');
      const unknown = await post({ body: { title: canary, objective: 'x', classification: 'x' } });
      expectError(unknown, 400, 'INVALID_INPUT');
      expect(await titleCount(canary)).toBe(0);
    });

    it('refuses the wrong media type, and an oversized body', async () => {
      expectError(
        await post({ raw: '{}', headers: { 'content-type': 'text/plain' } }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
      expectError(
        await post({ raw: JSON.stringify({ title: 'x', objective: 'x'.repeat(300 * 1024) }) }),
        413,
        'PAYLOAD_TOO_LARGE',
      );
    });

    it('refuses IDs that are not IDs, before they reach the database', async () => {
      expectError(await call(owner, 'GET', workUnit(org, 'not-a-uuid')), 400, 'INVALID_INPUT');
      expectError(await call(owner, 'GET', workUnits('not-a-uuid')), 400, 'INVALID_INPUT');
      expectError(
        await call(owner, 'GET', workUnit(org, `${randomUUID()}'%20or%201=1--`)),
        400,
        'INVALID_INPUT',
      );
    });

    it('keeps database failures out of the answer', async () => {
      // PostgreSQL cannot store a NUL in text, so this reaches the database and fails there.
      const result = await post({ raw: '{"title":"a\\u0000b","objective":"x"}' });
      expect([400, 500]).toContain(result.status);
      expectError(result, result.status);
    });
  });

  describe('who may ask', () => {
    const forWrites = (id: string) =>
      [
        ['POST', workUnits(org), { body: { title: 'x', objective: 'x' }, key: randomUUID() }],
        ['PATCH', workUnit(org, id), { body: { title: 'x' }, headers: { 'if-match': '"1"' } }],
        ['POST', dependencies(org, id), { body: { prerequisite_id: randomUUID() } }],
        [
          'POST',
          decisions(org, randomUUID()),
          { body: { decision: 'approve', action_hash: 'a'.repeat(64) } },
        ],
      ] as const;

    it('refuses a write from another origin, or with no origin', async () => {
      const work = await createWork();
      for (const [method, path, options] of forWrites(work.id)) {
        for (const origin of [
          'https://evil.example',
          'null',
          'https://localhost:8443.evil.example',
        ]) {
          expectError(
            await call(owner, method, path, { ...options, origin }),
            403,
            'ORIGIN_NOT_ALLOWED',
          );
        }
        expectError(
          await call(owner, method, path, { ...options, origin: null }),
          403,
          'ORIGIN_NOT_ALLOWED',
        );
      }
      expect((await call(owner, 'GET', workUnit(org, work.id))).json).toEqual(work);
    });

    it('records a project from another tenant, and answers as for any bad input', async () => {
      const forger = await join(owner, org, 'Fred Forger');
      const membership = await membershipOf(forger);
      const { rows: theirs } = await inFixtureTenant(su, rivalOrg, () =>
        su.query(
          `insert into work.projects (organization_id, name) values ($1, 'Theirs') returning id`,
          [rivalOrg],
        ),
      );
      const title = `Forged ${randomUUID()}`;
      for (const project of [theirs[0].id as string, randomUUID()]) {
        expectError(
          await call(forger, 'POST', workUnits(org), {
            body: { title, objective: 'x', project_id: project },
            key: randomUUID(),
          }),
          400,
          'INVALID_INPUT',
        );
      }
      expect(await titleCount(title)).toBe(0);
      const { rows } = await su.query(
        `select action, safe_reason from governance.audit_events
         where organization_id = $1 and actor_id = $2 and action like 'access.refused%'`,
        [org, membership],
      );
      expect(rows).toEqual([{ action: 'access.refused.api', safe_reason: 'FOREIGN_REFERENCE' }]);
    });

    it('records a forged tenant and a forged role, once each, with nothing they sent', async () => {
      const prober = await join(owner, org, 'Pat Prober');
      const { rows: users } = await su.query('select id from identity.users where email = $1', [
        prober.email,
      ]);
      const account = users[0].id as string;
      const membership = await membershipOf(prober);
      const refusals = async (organization: string, actor: string) => {
        const { rows } = await su.query(
          `select action, target_ref, decision, safe_reason from governance.audit_events
           where organization_id = $1 and actor_id = $2 and action like 'access.refused%'`,
          [organization, actor],
        );
        return rows;
      };

      const canary = `Canary-${randomUUID()}`;
      for (let i = 0; i < 5; i += 1) {
        expectError(
          await call(prober, 'POST', workUnits(rivalOrg), {
            body: { title: canary, objective: 'x' },
            key: randomUUID(),
          }),
          404,
          'NOT_FOUND',
        );
      }
      expect(await refusals(rivalOrg, account)).toEqual([
        {
          action: 'access.refused.api',
          target_ref: `organization:${rivalOrg}`,
          decision: 'deny',
          safe_reason: 'TENANT_ACCESS_DENIED',
        },
      ]);

      const work = await createWork();
      for (let i = 0; i < 3; i += 1) {
        expectError(
          await call(prober, 'PATCH', workUnit(org, work.id), {
            body: { title: canary },
            headers: { 'if-match': '"1"' },
          }),
          403,
          'FORBIDDEN',
        );
      }
      expect(await refusals(org, membership)).toEqual([
        {
          action: 'access.refused.api',
          target_ref: `organization:${org}`,
          decision: 'deny',
          safe_reason: 'FORBIDDEN',
        },
      ]);

      const { rows: all } = await su.query(
        'select * from governance.audit_events where organization_id = any($1)',
        [[org, rivalOrg]],
      );
      expect(JSON.stringify(all)).not.toContain(canary);
    });

    it('records nothing for someone with no session, who names no one', async () => {
      const refusals = async () => {
        const { rows } = await su.query(
          `select count(*)::int as n from governance.audit_events
           where organization_id = $1 and action like 'access.refused%'`,
          [org],
        );
        return rows[0].n as number;
      };
      const before = await refusals();
      expectError(await call(undefined, 'GET', workUnits(org)), 401, 'UNAUTHENTICATED');
      expect(await refusals()).toBe(before);
    });

    it('answers 401 without a session, or with a forged one', async () => {
      const work = await createWork();
      const forged: Person = {
        jar: { cookie: `${sessionCookieName}=forged.value` },
        name: 'Nobody',
        email: 'nobody@example.invalid',
      };
      for (const person of [undefined, forged]) {
        for (const path of [workUnits(org), workUnit(org, work.id), events(org, work.id)]) {
          expectError(await call(person, 'GET', path), 401, 'UNAUTHENTICATED');
        }
        for (const [method, path, options] of forWrites(work.id)) {
          expectError(await call(person, method, path, options), 401, 'UNAUTHENTICATED');
        }
      }
    });

    it('answers 404 for another tenant, the same as for one that does not exist', async () => {
      const theirs = await createWork(rival, rivalOrg);
      const refused = await call(owner, 'GET', workUnits(rivalOrg));
      const missing = await call(owner, 'GET', workUnits(randomUUID()));
      const refusedError = expectError(refused, 404, 'NOT_FOUND');
      const missingError = expectError(missing, 404, 'NOT_FOUND');
      expect({ ...refusedError, request_id: '' }).toEqual({ ...missingError, request_id: '' });

      for (const path of [workUnit(rivalOrg, theirs.id), events(rivalOrg, theirs.id)]) {
        expectError(await call(owner, 'GET', path), 404, 'NOT_FOUND');
      }
      // Their work named under this person's own tenant: row-level security finds nothing.
      expectError(await call(owner, 'GET', workUnit(org, theirs.id)), 404, 'NOT_FOUND');
      expectError(await call(owner, 'GET', events(org, theirs.id)), 404, 'NOT_FOUND');
      expectError(
        await call(owner, 'PATCH', workUnit(rivalOrg, theirs.id), {
          body: { title: 'Taken over' },
          headers: { 'if-match': '"1"' },
        }),
        404,
        'NOT_FOUND',
      );
      expectError(
        await call(owner, 'PATCH', workUnit(org, theirs.id), {
          body: { title: 'Taken over' },
          headers: { 'if-match': '"1"' },
        }),
        404,
        'NOT_FOUND',
      );
      const title = `Forged ${randomUUID()}`;
      expectError(
        await call(owner, 'POST', workUnits(rivalOrg), {
          body: { title, objective: 'x' },
          key: randomUUID(),
        }),
        404,
        'NOT_FOUND',
      );
      expect(await titleCount(title)).toBe(0);
      const unchanged = await call(rival, 'GET', workUnit(rivalOrg, theirs.id));
      expect(unchanged.json).toEqual(theirs);
    });
  });

  describe('live status (API-13)', () => {
    type StatusEvent = { event: string; id: string | undefined; data: string };
    type Stream = {
      response: Response;
      received: StatusEvent[];
      ended: () => boolean;
      close: () => void;
    };

    const open: Stream[] = [];

    /** Follows a stream in the background, reading frames the way EventSource does. */
    async function follow(jar: Jar, path: string, lastEventId?: string): Promise<Stream> {
      const abort = new AbortController();
      const response = await fetch(`${BASE}${path}`, {
        headers: {
          cookie: jar.cookie,
          accept: 'text/event-stream',
          ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
        },
        signal: abort.signal,
      });
      // A stream never ends on its own, so only its status, type and headers are checked here.
      checkContract('GET', path, response.status, response.headers);
      const received: StatusEvent[] = [];
      let ended = false;
      const pump = async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const fields = new Map(
              frame
                .split('\n')
                .filter((line) => line && !line.startsWith(':'))
                .map((line) => {
                  const colon = line.indexOf(':');
                  return [line.slice(0, colon), line.slice(colon + 1).trimStart()] as const;
                }),
            );
            if (fields.has('data')) {
              received.push({
                event: fields.get('event') ?? 'message',
                id: fields.get('id'),
                data: fields.get('data') as string,
              });
            }
          }
        }
      };
      void pump()
        .catch(() => undefined)
        .finally(() => {
          ended = true;
        });
      const stream = { response, received, ended: () => ended, close: () => abort.abort() };
      open.push(stream);
      return stream;
    }

    afterEach(() => {
      for (const stream of open.splice(0)) stream.close();
    });

    const POLL = { timeout: 15_000, interval: 100 };
    const lastId = (stream: Stream) => stream.received.at(-1)?.id;
    const settle = () => new Promise((done) => setTimeout(done, 2_500));
    const patch = (id: string, version: number, title: string) =>
      call(owner, 'PATCH', workUnit(org, id), {
        body: { title },
        headers: { 'if-match': `"${version}"` },
      });

    it('states the current version first, as a status event', async () => {
      const work = await createWork();
      const stream = await follow(owner.jar, events(org, work.id));
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
      expect(stream.response.headers.get('cache-control')).toContain('no-store');
      await expect.poll(() => lastId(stream), POLL).toBe('1');
      expect(stream.received).toEqual([{ event: 'status', id: '1', data: '1' }]);
    });

    it('sends a status event when the work changes, and only ever the version', async () => {
      const title = `Canary ${randomUUID()}`;
      const work = await createWork(owner, org, title);
      const stream = await follow(owner.jar, events(org, work.id));
      await expect.poll(() => lastId(stream), POLL).toBe('1');

      expect((await patch(work.id, 1, `${title} edited`)).status).toBe(200);
      await expect.poll(() => lastId(stream), POLL).toBe('2');

      // A change made through the page reaches the same stream.
      const moved = await submit(
        `/o/${org}/work/${work.id}`,
        owner.jar,
        (form) => form.hidden.get('to') === 'ready',
      );
      expect(moved.status).toBe(303);
      await expect.poll(() => lastId(stream), POLL).toBe('3');
      expect(stream.received).toEqual([
        { event: 'status', id: '1', data: '1' },
        { event: 'status', id: '2', data: '2' },
        { event: 'status', id: '3', data: '3' },
      ]);
    });

    it('resumes from Last-Event-ID, and sends nothing when already up to date', async () => {
      const work = await createWork();
      const first = await follow(owner.jar, events(org, work.id));
      await expect.poll(() => lastId(first), POLL).toBe('1');
      first.close();

      // Changes made while disconnected are recovered on reconnecting.
      await patch(work.id, 1, 'While away');
      await patch(work.id, 2, 'Still away');
      const behind = await follow(owner.jar, events(org, work.id), '1');
      await expect.poll(() => lastId(behind), POLL).toBe('3');
      expect(behind.received).toEqual([{ event: 'status', id: '3', data: '3' }]);
      behind.close();

      const current = await follow(owner.jar, events(org, work.id), '3');
      await settle();
      expect(current.received).toEqual([]);
      await patch(work.id, 3, 'Back again');
      await expect.poll(() => lastId(current), POLL).toBe('4');
    });

    it('treats a malformed Last-Event-ID as none at all', async () => {
      const work = await createWork();
      const stream = await follow(owner.jar, events(org, work.id), 'not-a-version');
      expect(stream.response.status).toBe(200);
      await expect.poll(() => lastId(stream), POLL).toBe('1');
    });

    it('ends when access is revoked, and stays closed', async () => {
      const leaver = await join(owner, org, 'Lee Leaving');
      const work = await createWork();
      const stream = await follow(leaver.jar, events(org, work.id));
      await expect.poll(() => lastId(stream), POLL).toBe('1');
      expect(stream.ended()).toBe(false);

      const target = await membershipOf(leaver);
      const disabled = await submit(
        `/o/${org}/people`,
        owner.jar,
        (form) => form.hidden.get('membershipId') === target && />Disable</.test(form.html),
        { confirm: 'yes' },
      );
      expect(disabled.status).toBe(303);
      await expect.poll(() => stream.ended(), POLL).toBe(true);

      const before = stream.received.length;
      await patch(work.id, 1, 'After they left');
      await settle();
      expect(stream.received).toHaveLength(before);
      expectError(await call(leaver, 'GET', events(org, work.id)), 404, 'NOT_FOUND');
      // Every other route answers the same, at once.
      expectError(await call(leaver, 'GET', workUnits(org)), 404, 'NOT_FOUND');
      expectError(await call(leaver, 'GET', workUnit(org, work.id)), 404, 'NOT_FOUND');
    });

    it('ends when the person signs out', async () => {
      const person = await join(owner, org, 'Sam Signing-Out');
      const work = await createWork();
      const stream = await follow(person.jar, events(org, work.id));
      await expect.poll(() => lastId(stream), POLL).toBe('1');
      const cookie = person.jar.cookie;
      const out = await submit(`/o/${org}`, person.jar, />Sign out</);
      expect(out.status).toBe(303);
      // The session is checked less often than the membership, by design.
      await expect.poll(() => stream.ended(), { timeout: 45_000, interval: 250 }).toBe(true);
      expectError(
        await call({ ...person, jar: { cookie } }, 'GET', events(org, work.id)),
        401,
        'UNAUTHENTICATED',
      );
    });

    it('never opens for work the person may not see', async () => {
      const created = await submit(`/o/${org}/work/new`, owner.jar, /name="title"/, {
        title: `Restricted ${randomUUID()}`,
        classification: 'restricted',
      });
      const id = /\/work\/([0-9a-f-]{36})$/.exec(created.headers.get('location') ?? '')?.[1];
      if (!id) throw new Error('Work not created');
      expectError(await call(member, 'GET', events(org, id)), 404, 'NOT_FOUND');
      expectError(await call(owner, 'GET', events(org, randomUUID())), 404, 'NOT_FOUND');
    });
  });

  // An onboarding ends with a welcome message that only the connector worker can send. A deployment without
  // connectors would start one and leave it waiting for a worker that is not coming, so it refuses to start one,
  // over the API and on the page, before anything is read or written: CONNECTOR_NOT_AVAILABLE, as a connection,
  // a proposal and a sync are refused (docs/06-delivery/m3-slices.md). The main gate runs no connector worker,
  // so it proves that refusal here. That refusal comes before any membership, role, reviewer or connection
  // check (apps/web/src/server/knowledge-api.ts, onboardingPOST), so the only other negative this gate can
  // reach over HTTP is a stranger's 404, which the route's membership check answers first. Every negative is
  // still asserted, each where it can be reached:
  //   - here, on the main gate: the 409 refusal (and again on its idempotency key), the page's refusal, and
  //     the stranger's 404 on both POST and GET;
  //   - tests/integration/client-onboarding.test.ts, in the integration shards, at the application layer
  //     with nothing written: a plain member's 403 FORBIDDEN (and a service actor's), APPROVAL_SELF_APPROVAL,
  //     a foreign reviewer's 404, and the 404 for an email connection that is missing or another tenant's;
  //   - tests/stack/slice-2.test.ts, in the connectors job, which also runs on every push: all of them over
  //     HTTP (member 403, stranger 404, self-review 403, missing connection 404), with starting one and
  //     reading it back, which is where API-12's coverage of the two operations is asserted too.
  // The request is otherwise one that would start an onboarding: its email
  // connection is the one row that needs connectors on to be made over HTTP, and a deployment keeps the
  // connections it made while connectors were on, so the row is written as the app role writes it, in its own
  // tenant and through its own policies, as tests/integration/client-onboarding.test.ts does. The company is
  // founded by a person of its own: the setup form on the home page is for someone with no organization yet, and
  // sends anyone with exactly one straight to it (apps/web/src/app/page.tsx). Everything is a generated value.
  describe.skipIf(process.env.ENSEMUS_CONNECTORS_ENABLED === 'true')(
    'client onboarding on a deployment without connectors',
    () => {
      const app = openAppDatabase(urls.app());
      const onboardings = (organization: string) =>
        `/api/v1/organizations/${organization}/client-onboardings`;
      const page = (organization: string) => `/o/${organization}/onboarding`;
      let founder: Person;
      let company: string;
      let connectionId: string;
      let founderMembership: string;
      let colleagueMembership: string;

      beforeAll(async () => {
        founder = await signUp('Ona Onboarding Owner');
        company = await createOrganization(founder, `Onboarding ${randomUUID()}`);
        const colleague = await join(founder, company, 'Oli Onboarding Reviewer');
        founderMembership = await membershipOf(founder, company);
        colleagueMembership = await membershipOf(colleague, company);
        const { rows } = await su.query('select id from identity.users where email = $1', [
          founder.email,
        ]);
        const context = await resolveTenantContext(app.db, rows[0].id as string, company);
        connectionId = randomUUID();
        await withTenantTx(app.db, context, (tx) =>
          tx.insert(connections).values({
            organizationId: company,
            id: connectionId,
            connectorType: EMAIL_CONNECTOR_TYPE,
            displayName: 'Generated email connection',
            config: { fromAddress: 'sender@example.invalid' },
          }),
        );
      });
      afterAll(() => app.close());

      const start = () => ({
        deal_ref: `deal-${randomUUID()}`,
        client_name: `Generated client ${randomUUID()}`,
        project_name: 'Generated project',
        owner_membership_id: founderMembership,
        reviewer_membership_id: colleagueMembership,
        email_connection_id: connectionId,
        contact_email: 'client@example.invalid',
      });

      /** What a start would have written: the onboarding, and the client it makes first. */
      async function written(dealRef: string, clientName: string) {
        const { rows } = await su.query(
          `select
             (select count(*)::int from work.client_onboardings
               where organization_id = $1 and deal_ref = $2) as onboardings,
             (select count(*)::int from work.clients
               where organization_id = $1 and display_name = $3) as clients`,
          [company, dealRef, clientName],
        );
        return rows[0] as { onboardings: number; clients: number };
      }

      it('refuses to start one over the API, and writes nothing', async () => {
        const body = start();
        const key = randomUUID();
        expectError(
          await call(founder, 'POST', onboardings(company), { body, key }),
          409,
          'CONNECTOR_NOT_AVAILABLE',
        );
        expect(await written(body.deal_ref, body.client_name)).toEqual({
          onboardings: 0,
          clients: 0,
        });
        // Asked again with the same key, it is refused again: nothing was kept to replay.
        expectError(
          await call(founder, 'POST', onboardings(company), { body, key }),
          409,
          'CONNECTOR_NOT_AVAILABLE',
        );
        expect(await written(body.deal_ref, body.client_name)).toEqual({
          onboardings: 0,
          clients: 0,
        });
      });

      it('tells a stranger nothing, about the deployment or an onboarding', async () => {
        // Their membership is checked first, so they get the ordinary missing answer, not the refusal.
        expectError(
          await call(rival, 'POST', onboardings(company), { body: start(), key: randomUUID() }),
          404,
          'NOT_FOUND',
        );
        expectError(
          await call(rival, 'GET', `${onboardings(company)}/${randomUUID()}`),
          404,
          'NOT_FOUND',
        );
      });

      it('says why on the page, and refuses the form there the same way', async () => {
        const shown = await read(page(company), founder.jar);
        expect(shown.status).toBe(200);
        expect(shown.html).toContain('Connectors are not turned on for this deployment');
        const body = start();
        const response = await submit(page(company), founder.jar, /Start onboarding/, {
          dealRef: body.deal_ref,
          clientName: body.client_name,
          projectName: body.project_name,
          ownerMembershipId: body.owner_membership_id,
          reviewerMembershipId: body.reviewer_membership_id,
          emailConnectionId: body.email_connection_id,
          contactEmail: body.contact_email,
        });
        // The form comes back with the reason, and does not go on to an onboarding.
        expect(response.headers.get('location')).toBeNull();
        expect(await response.text()).toContain(
          'This connector is not available on this deployment.',
        );
        expect(await written(body.deal_ref, body.client_name)).toEqual({
          onboardings: 0,
          clients: 0,
        });
      });
    },
  );

  // Members' own Google and Microsoft accounts (ADR-038 D5). What members may connect, and whose own
  // connection exists, answer with connectors off as well, so API-12's coverage of those three operations is
  // here. Starting a consent, the callback and a member's own connections need connectors on: those are
  // proven in tests/stack/slice-2.test.ts, which asserts their coverage, and this shows the starts refused
  // where they are off. A tenant of its own, so the setting it changes is in no other test's way.
  describe('members’ own connections (ADR-038 D5)', () => {
    const base = (organization: string) => `/api/v1/organizations/${organization}`;
    let founder: Person;
    let company: string;
    let colleague: Person;

    beforeAll(async () => {
      founder = await signUp('Pia Personal Owner');
      company = await createOrganization(founder, `Personal ${randomUUID()}`);
      colleague = await join(founder, company, 'Cal Personal Member');
    });

    it('lets anyone read what members may connect, and only a manager change it', async () => {
      const path = `${base(company)}/member-connection-capabilities`;
      const before = await call(colleague, 'GET', path);
      expect(before.status, before.text).toBe(200);
      expect([...(before.json as { capabilities: string[] }).capabilities].sort()).toEqual([
        'calendar',
        'mail',
      ]);
      expectError(
        await call(colleague, 'PUT', path, { body: { capabilities: ['documents'] } }),
        403,
        'FORBIDDEN',
      );
      const changed = await call(founder, 'PUT', path, {
        body: { capabilities: ['mail', 'documents'] },
      });
      expect(changed.status, changed.text).toBe(200);
      expect([...(changed.json as { capabilities: string[] }).capabilities].sort()).toEqual([
        'documents',
        'mail',
      ]);
      const after = await call(colleague, 'GET', path);
      expect([...(after.json as { capabilities: string[] }).capabilities].sort()).toEqual([
        'documents',
        'mail',
      ]);
      // A capability only the organization may own is not one members can be given.
      expectError(await call(founder, 'PUT', path, { body: { capabilities: ['files'] } }), 400);
      expectError(await call(rival, 'GET', `${base(company)}/member-connection-capabilities`), 404);
    });

    it('shows a manager whose own connections exist, and nobody else', async () => {
      const path = `${base(company)}/member-connections`;
      const listed = await call(founder, 'GET', path);
      expect(listed.status, listed.text).toBe(200);
      expect(listed.json).toEqual({ items: [] });
      expectError(await call(colleague, 'GET', path), 403, 'FORBIDDEN');
      expectError(await call(rival, 'GET', path), 404);
    });

    it.skipIf(process.env.ENSEMUS_CONNECTORS_ENABLED === 'true')(
      'refuses to start a consent where connectors are off, before anything is sealed',
      async () => {
        expectError(
          await call(founder, 'POST', `${base(company)}/oauth-authorizations`, {
            body: {
              connector_type: 'google_workspace',
              display_name: 'Generated workspace',
              config: {},
              capabilities: ['files'],
              client: { kind: 'platform' },
            },
          }),
          409,
          'CONNECTOR_NOT_AVAILABLE',
        );
        expectError(
          await call(colleague, 'POST', `${base(company)}/my-connections`, {
            body: {
              connector_type: 'google_workspace',
              display_name: 'Mine',
              capabilities: ['mail'],
            },
          }),
          409,
          'CONNECTOR_NOT_AVAILABLE',
        );
        const { rows } = await su.query(
          'select count(*)::int as n from integrations.oauth_authorizations where organization_id = $1',
          [company],
        );
        expect(rows[0].n).toBe(0);
      },
    );
  });

  describe('what the contract promises (API-12)', () => {
    const WORK = '/organizations/{organization_id}/work-units';
    const ONE_WORK = `${WORK}/{work_unit_id}`;
    const DECISIONS = '/organizations/{organization_id}/approvals/{approval_id}/decisions';

    it('answers a malformed ID on the approval reads with the 400 it lists', async () => {
      const approvals = `/api/v1/organizations/${org}/approvals`;
      expectError(await call(owner, 'GET', `${approvals}/not-a-uuid`), 400, 'INVALID_INPUT');
      expectError(
        await call(owner, 'GET', '/api/v1/organizations/not-a-uuid/approvals'),
        400,
        'INVALID_INPUT',
      );
    });

    it('holds a new Work Unit to the limits the contract states, exactly', async () => {
      const titles = requestLimit(WORK, 'post', 'title', 'maxLength');
      const objectives = requestLimit(WORK, 'post', 'objective', 'maxLength');
      const create = (title: string, objective: string) =>
        call(owner, 'POST', workUnits(org), { body: { title, objective }, key: randomUUID() });
      expect((await create('x'.repeat(titles), 'x'.repeat(objectives))).status).toBe(201);
      expectError(await create('x'.repeat(titles + 1), 'x'), 400, 'INVALID_INPUT');
      expectError(await create('x', 'x'.repeat(objectives + 1)), 400, 'INVALID_INPUT');
    });

    it('holds a change to a Work Unit to the limits the contract states, exactly', async () => {
      const work = await createWork();
      const titles = requestLimit(ONE_WORK, 'patch', 'title', 'maxLength');
      const objectives = requestLimit(ONE_WORK, 'patch', 'objective', 'maxLength');
      const patch = (body: Record<string, string>) =>
        call(owner, 'PATCH', workUnit(org, work.id), { body, headers: { 'if-match': '"1"' } });
      expectError(await patch({ title: 'x'.repeat(titles + 1) }), 400, 'INVALID_INPUT');
      expectError(await patch({ title: '' }), 400, 'INVALID_INPUT');
      expectError(await patch({ objective: 'x'.repeat(objectives + 1) }), 400, 'INVALID_INPUT');
      const fits = await patch({ title: 'x'.repeat(titles), objective: 'x'.repeat(objectives) });
      expect(fits.status).toBe(200);
      expect(fits.headers.get('etag')).toBe('"2"');
    });

    it('holds a decision’s hash to the limit the contract states, exactly', async () => {
      const longest = requestLimit(DECISIONS, 'post', 'action_hash', 'maxLength');
      const decide = (hash: string) =>
        call(reviewer, 'POST', decisions(org, randomUUID()), {
          body: { decision: 'approve', action_hash: hash },
        });
      expectError(await decide('a'.repeat(longest + 1)), 400, 'INVALID_INPUT');
      // It passes the check on its shape, and goes on to be refused for naming nothing.
      expectError(await decide('a'.repeat(longest)), 404, 'NOT_FOUND');
    });

    it('signs in with the cookie it names, and takes no bearer token', async () => {
      const person = await signUp('Cookie Holder');
      const session = person.jar.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
      if (!session) throw new Error('The real session cookie is not the one the contract names');
      const own = await createOrganization(person, `Cookie ${randomUUID()}`);
      expect((await call(person, 'GET', workUnits(own))).status).toBe(200);

      const value = session.slice(sessionCookieName.length + 1);
      const asBearer = await call(undefined, 'GET', workUnits(own), {
        headers: { authorization: `Bearer ${value}` },
      });
      expectError(asBearer, 401, 'UNAUTHENTICATED');
    });

    it('has validated a real response from every operation that exists', () => {
      // These operations have their own successful-response coverage assertion. client-onboardings, consent to
      // Google and Microsoft (oauth-authorizations, the callback) and members' own connections succeed only with
      // connectors on, so theirs is in tests/stack/slice-2.test.ts, which the connectors job runs.
      const ownCoverage = (path: string) =>
        /\/(external-actions|connections|client-onboardings|agent-runs|agent-versions|model-profiles|budgets|usage|entitlements|object-types|object-records|studio|process-specs|process-runs|outcome-drafts|onboarding|oauth-authorizations|my-connections)(\/|$)|^\/oauth\/callback$/.test(
          path,
        );
      const implemented = operations()
        .filter((operation) => operation.status === undefined)
        .filter(({ path }) => !ownCoverage(path))
        .map(({ method, path }) => operationName(method, path));
      expect(implemented.length).toBeGreaterThan(0);
      // Every suite of this run counts, whichever file saw the response: the gate runs this file after all the
      // others, in both modes, sharing one record. Without that record only this file's responses are known.
      const { operations: seen, tested, setupOnly, shared } = validatedOperations();
      const unshared =
        'ENSEMUS_API_RECORD_DIR is not set, so only this file was recorded: run it through air-gap-gate.mjs';
      const validated = [...seen].filter((name) => !ownCoverage(name.slice(name.indexOf(' ') + 1)));
      expect(
        validated.sort(),
        shared
          ? 'Operations no stack suite in this run saw a successful real response for'
          : unshared,
      ).toEqual(implemented.sort());
      // A response seen only while a suite set itself up proves the operation answered, not that any test of it
      // ran. Each operation needs one running test that saw its documented answer (the record keeps the file).
      const untested = implemented
        .filter((name) => !tested.has(name))
        .map((name) => `${name}: only in setup, in ${(setupOnly.get(name) ?? []).join(', ')}`);
      expect(
        untested,
        shared ? 'Operations no running stack test saw a successful real response for' : unshared,
      ).toEqual([]);
    });
  });
});
