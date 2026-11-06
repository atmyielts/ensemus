// CONNECT-06: the external action and connection routes against built images, through the proxy. Every
// response goes through the same OpenAPI validator as tests/stack/api.test.ts, and a real response from
// each of these operations has to have been seen by the end.
//
// It runs both ways. With ENSEMUS_CONNECTORS_ENABLED=true (the connectors job in CI) the writes go through.
// Without it they must say the connector is not available, and nothing else may change: reading and
// resolving still work, because an action already stuck in `unknown` still needs a person. Seeds use the
// superuser for rows that only a worker could otherwise put there, through the real triggers. Everything is
// a generated test value, and no connector here contacts anything.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { components } from '../../packages/contracts/generated/openapi';
import { BASE, createOrganization, join, signUp, type Person } from '../helpers/forms';
import { contractProblems, operationName, operations } from '../helpers/openapi';
import { urls } from '../helpers/stack';

type ExternalAction = components['schemas']['ExternalAction'];
type ApiError = components['schemas']['Error'];

const enabled = process.env.ENSEMUS_CONNECTORS_ENABLED === 'true';

/** The operations this file answers for. tests/stack/api.test.ts covers the rest of the spec. */
const OURS = (path: string) => /\/(external-actions|connections)(\/|$)/.test(path);

const validated = new Set<string>();

type Result = { status: number; headers: Headers; text: string; json: unknown };

async function call(
  person: Person | undefined,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; key?: string } = {},
): Promise<Result> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(person ? { cookie: person.jar.cookie } : {}),
      ...(method !== 'GET' ? { origin: BASE } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...options.headers,
    },
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await response.text();
  const { operation, problems } = contractProblems({
    method,
    path,
    status: response.status,
    headers: response.headers,
    text,
  });
  expect(problems).toEqual([]);
  if (operation && response.status < 400) validated.add(operation);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function expectError(result: Result, status: number, code: string) {
  expect(result.status, result.text).toBe(status);
  expect((result.json as ApiError).code).toBe(code);
  expect(result.headers.get('cache-control')).toContain('no-store');
}

describe('external actions API', () => {
  let su: pg.Client;
  let owner: Person;
  let member: Person;
  let approver: Person;
  let rival: Person;
  let org: string;
  let rivalOrg: string;
  let connection: string;

  const root = (organization = org) => `/api/v1/organizations/${organization}`;

  async function membershipOf(person: Person, organization = org): Promise<string> {
    const { rows } = await su.query(
      `select m.id from org.memberships m join identity.users u on u.id = m.user_id
       where u.email = $1 and m.organization_id = $2`,
      [person.email, organization],
    );
    if (!rows[0]) throw new Error('No membership');
    return rows[0].id as string;
  }

  async function createWork(person = owner) {
    const result = await call(person, 'POST', `${root()}/work-units`, {
      body: { title: `Work ${randomUUID()}`, objective: 'Written by a test' },
      key: randomUUID(),
    });
    expect(result.status, result.text).toBe(201);
    return (result.json as { id: string }).id;
  }

  /** Walks an intent to `status` through the real triggers, as tests/helpers/integrations.ts does. */
  async function seedAction(status: 'awaiting_approval' | 'unknown' | 'failed' | 'sent') {
    const work = await createWork();
    const approverId = await membershipOf(approver);
    const id = randomUUID();
    const approvalId = randomUUID();
    const attemptId = randomUUID();
    const payload = {
      from: { address: 'sender@example.invalid' },
      to: ['recipient@example.invalid'],
      subject: 'A test message',
      text_body: 'Nothing here is real.',
    };
    const hash = createHash('sha256').update(id).digest('hex');
    const action = {
      toolName: 'email.send',
      toolVersion: '1',
      targetRef: `connection:${connection}`,
      payload,
    };
    await su.query('begin');
    try {
      await su.query(
        `insert into work.approvals (organization_id, id, work_unit_id, tool_name, action, action_hash,
           target_ref, approver_membership_id, expires_at)
         values ($1, $2, $3, 'email.send', $4, $5, $6, $7, now() + interval '1 hour')`,
        [org, approvalId, work, action, hash, action.targetRef, approverId],
      );
      await su.query(
        `insert into integrations.external_actions (organization_id, id, work_unit_id, connection_id,
           tool_name, tool_version, target_ref, payload, request_hash, idempotency_key, classification,
           requires_approval, approval_id, status)
         values ($1, $2, $3, $4, 'email.send', '1', $5, $6, $7, $8, 'internal', true, $9,
           'awaiting_approval')`,
        [org, id, work, connection, action.targetRef, payload, hash, `ensemus-${id}`, approvalId],
      );
      if (status !== 'awaiting_approval') {
        await su.query(
          `update work.approvals set status = 'approved', decided_at = now() where id = $1`,
          [approvalId],
        );
        const move = (to: string) =>
          su.query('update integrations.external_actions set status = $1 where id = $2', [to, id]);
        await move('ready');
        await su.query(
          `insert into integrations.external_action_attempts (organization_id, id, external_action_id,
             attempt_no, request_hash, idempotency_key, run_id)
           values ($1, $2, $3, 1, $4, $5, 'test-run')`,
          [org, attemptId, id, hash, `ensemus-${id}`],
        );
        await move('sending');
        const outcome =
          status === 'sent' ? 'accepted' : status === 'failed' ? 'rejected' : 'indeterminate';
        await su.query(
          'update integrations.external_action_attempts set outcome = $1 where id = $2',
          [outcome, attemptId],
        );
        if (status === 'unknown') {
          await move('reconciling');
          await move('unknown');
        } else {
          await move(status);
        }
      }
      await su.query('commit');
    } catch (error) {
      await su.query('rollback');
      throw error;
    }
    return { id, approvalId, work };
  }

  beforeAll(async () => {
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
    owner = await signUp('Ada Owner');
    org = await createOrganization(owner, `Actions ${randomUUID()}`);
    member = await join(owner, org, 'Max Member');
    approver = await join(owner, org, 'Rae Approver');
    rival = await signUp('Ron Rival');
    rivalOrg = await createOrganization(rival, `Rival ${randomUUID()}`);
    connection = randomUUID();
    await su.query(
      `insert into integrations.connections (organization_id, id, connector_type, display_name, config)
       values ($1, $2, 'email_smtp', 'Test mail', $3)`,
      [org, connection, { fromAddress: 'sender@example.invalid' }],
    );
  });

  afterAll(async () => {
    await su.end();
  });

  describe('reading', () => {
    it('lists and reads, with a version to send back', async () => {
      const { id, work } = await seedAction('sent');
      const list = await call(owner, 'GET', `${root()}/external-actions?work_unit_id=${work}`);
      expect(list.status, list.text).toBe(200);
      const items = (list.json as { items: Array<{ id: string; status: string }> }).items;
      expect(items.map((item) => item.id)).toEqual([id]);
      expect(items[0]?.status).toBe('sent');

      const one = await call(owner, 'GET', `${root()}/external-actions/${id}`);
      expect(one.status, one.text).toBe(200);
      expect(one.headers.get('etag')).toBe('"1"');
      const detail = one.json as ExternalAction;
      expect(detail.can_resolve).toBe(false);
      expect((detail.payload as { to: string[] }).to).toEqual(['recipient@example.invalid']);
    });

    it('answers 404 to another tenant, by their token and by this one', async () => {
      const { id } = await seedAction('unknown');
      expectError(await call(rival, 'GET', `${root()}/external-actions`), 404, 'NOT_FOUND');
      expectError(
        await call(rival, 'GET', `${root(rivalOrg)}/external-actions/${id}`),
        404,
        'NOT_FOUND',
      );
    });

    it('refuses someone not signed in, and a malformed address', async () => {
      expectError(
        await call(undefined, 'GET', `${root()}/external-actions`),
        401,
        'UNAUTHENTICATED',
      );
      expectError(
        await call(owner, 'GET', `${root()}/external-actions/nope`),
        400,
        'INVALID_INPUT',
      );
      expectError(
        await call(owner, 'GET', `${root()}/external-actions?status=nearly`),
        400,
        'INVALID_INPUT',
      );
    });
  });

  describe('saying what happened', () => {
    const answer = { resolution: 'confirmed_sent', reason: 'It is in the log.' };

    it('records it as this person, says so, and needs the version', async () => {
      const { id } = await seedAction('unknown');
      const path = `${root()}/external-actions/${id}/resolution`;
      expectError(await call(owner, 'POST', path, { body: answer }), 428, 'PRECONDITION_REQUIRED');
      expectError(
        await call(owner, 'POST', path, { body: answer, headers: { 'if-match': '"9"' } }),
        409,
        'VERSION_CONFLICT',
      );
      const done = await call(owner, 'POST', path, {
        body: answer,
        headers: { 'if-match': '"1"' },
      });
      expect(done.status, done.text).toBe(200);
      expect(done.headers.get('etag')).toBe('"2"');
      const detail = done.json as ExternalAction;
      expect(detail).toMatchObject({
        status: 'sent',
        resolution: 'confirmed_sent',
        resolved_by_name: 'Ada Owner',
        can_resolve: false,
      });
      expect(detail.receipts[0]).toMatchObject({ basis: 'person', actor_name: 'Ada Owner' });
      expectError(
        await call(owner, 'POST', path, { body: answer, headers: { 'if-match': '"2"' } }),
        409,
        'EXTERNAL_ACTION_NOT_RESOLVABLE',
      );
    });

    it('refuses a member with no say, and another tenant', async () => {
      const { id } = await seedAction('unknown');
      const path = `${root()}/external-actions/${id}/resolution`;
      expectError(
        await call(member, 'POST', path, { body: answer, headers: { 'if-match': '"1"' } }),
        403,
        'FORBIDDEN',
      );
      expectError(
        await call(rival, 'POST', path, { body: answer, headers: { 'if-match': '"1"' } }),
        404,
        'NOT_FOUND',
      );
    });

    it('refuses a blank reason and an unknown answer', async () => {
      const { id } = await seedAction('unknown');
      const path = `${root()}/external-actions/${id}/resolution`;
      for (const body of [
        { resolution: 'confirmed_sent', reason: '   ' },
        { resolution: 'perhaps', reason: 'A reason.' },
        { ...answer, extra: true },
      ]) {
        expectError(
          await call(owner, 'POST', path, { body, headers: { 'if-match': '"1"' } }),
          400,
          'INVALID_INPUT',
        );
      }
    });
  });

  describe('proposing, changing and asking again', () => {
    const email = {
      to: ['recipient@example.invalid'],
      subject: 'A test message',
      text_body: 'Nothing here is real.',
    };

    it('normalizes request IDs before idempotency and still refuses self-approval', async () => {
      const work = await createWork();
      const path = `${root()}/work-units/${work}/external-actions`;
      const reviewer = await membershipOf(approver);
      const key = randomUUID();
      const made = await call(owner, 'POST', path, {
        body: {
          connection_id: connection.toUpperCase(),
          approver_membership_id: reviewer.toUpperCase(),
          email,
        },
        key,
      });
      if (!enabled) {
        expectError(made, 409, 'CONNECTOR_NOT_AVAILABLE');
        return;
      }
      expect(made.status, made.text).toBe(201);
      const repeated = await call(owner, 'POST', path, {
        body: { connection_id: connection, approver_membership_id: reviewer, email },
        key,
      });
      expect(repeated.status, repeated.text).toBe(201);
      expect(repeated.json).toEqual(made.json);
      const self = await call(owner, 'POST', path, {
        body: {
          connection_id: connection.toUpperCase(),
          approver_membership_id: (await membershipOf(owner)).toUpperCase(),
          email,
        },
        key: randomUUID(),
      });
      expectError(self, 409, 'APPROVAL_SELF_APPROVAL');
    });

    it('takes the sender from the connection and refuses one in the body', async () => {
      const work = await createWork();
      const path = `${root()}/work-units/${work}/external-actions`;
      const body = {
        connection_id: connection,
        approver_membership_id: await membershipOf(approver),
        email,
      };
      expectError(
        await call(owner, 'POST', path, {
          body: { ...body, email: { ...email, from: { address: 'x@example.invalid' } } },
          key: randomUUID(),
        }),
        400,
        'INVALID_INPUT',
      );
      const made = await call(owner, 'POST', path, { body, key: randomUUID() });
      if (!enabled) {
        expectError(made, 409, 'CONNECTOR_NOT_AVAILABLE');
        return;
      }
      expect(made.status, made.text).toBe(201);
      const proposed = made.json as components['schemas']['ProposedExternalAction'];
      expect(proposed.status).toBe('awaiting_approval');
      const read = await call(owner, 'GET', `${root()}/external-actions/${proposed.id}`);
      const payload = (read.json as ExternalAction).payload as { from: { address: string } };
      expect(payload.from.address).toBe('sender@example.invalid');
    });

    it('closes the old action on a revision, or says it is not available', async () => {
      const { id } = await seedAction('awaiting_approval');
      const revised = await call(owner, 'POST', `${root()}/external-actions/${id}/revisions`, {
        body: { approver_membership_id: await membershipOf(approver), email },
        headers: { 'if-match': '"1"' },
      });
      if (!enabled) {
        expectError(revised, 409, 'CONNECTOR_NOT_AVAILABLE');
        return;
      }
      expect(revised.status, revised.text).toBe(201);
      const old = await call(owner, 'GET', `${root()}/external-actions/${id}`);
      expect((old.json as ExternalAction).status).toBe('cancelled');
    });

    it('makes a new action when asked again, or says it is not available', async () => {
      const { id } = await seedAction('failed');
      const again = await call(owner, 'POST', `${root()}/external-actions/${id}/retries`, {
        body: { approver_membership_id: await membershipOf(approver) },
      });
      if (!enabled) {
        expectError(again, 409, 'CONNECTOR_NOT_AVAILABLE');
        return;
      }
      expect(again.status, again.text).toBe(201);
      expect((again.json as { id: string }).id).not.toBe(id);
    });
  });

  describe('connections', () => {
    const settings = { fromAddress: 'sender@example.invalid' };
    const credential = `generated-${randomUUID()}`;

    it('lists without a credential, for who may manage them only', async () => {
      const list = await call(owner, 'GET', `${root()}/connections`);
      expect(list.status, list.text).toBe(200);
      expect(list.text).toContain('Test mail');
      expectError(await call(member, 'GET', `${root()}/connections`), 403, 'FORBIDDEN');
      expectError(await call(rival, 'GET', `${root()}/connections`), 404, 'NOT_FOUND');
      const one = await call(owner, 'GET', `${root()}/connections/${connection}`);
      expect(one.status, one.text).toBe(200);
      expect(one.headers.get('etag')).toBeTruthy();
    });

    it('refuses a member before reading what they sent', async () => {
      expectError(
        await call(member, 'POST', `${root()}/connections`, {
          body: {
            connector_type: 'email_smtp',
            display_name: 'Mine',
            config: settings,
            credential,
          },
          key: randomUUID(),
        }),
        403,
        'FORBIDDEN',
      );
      const { rows } = await su.query(
        `select count(*)::int as n from integrations.connections where organization_id = $1
           and display_name = 'Mine'`,
        [org],
      );
      expect(rows[0].n).toBe(0);
    });

    it('seals a credential, never returns it, and takes no host', async () => {
      const make = (config: object, name = `Mail ${randomUUID()}`) =>
        call(owner, 'POST', `${root()}/connections`, {
          body: { connector_type: 'email_smtp', display_name: name, config, credential },
          key: randomUUID(),
        });
      const hosted = await make({ ...settings, host: 'relay.example.invalid', port: 25 });
      if (!enabled) {
        expectError(hosted, 409, 'CONNECTOR_NOT_AVAILABLE');
        expectError(await make(settings), 409, 'CONNECTOR_NOT_AVAILABLE');
        return;
      }
      expectError(hosted, 400, 'INVALID_INPUT');
      const made = await make(settings);
      expect(made.status, made.text).toBe(201);
      expect(made.text).not.toContain(credential);
      expect((made.json as components['schemas']['Connection']).has_credential).toBe(true);
      const { rows } = await su.query(
        `select s.ciphertext from integrations.connections c
           join secrets.sealed_secrets s on s.organization_id = c.organization_id
             and s.id = c.credential_secret_id
          where c.id = $1`,
        [(made.json as { id: string }).id],
      );
      expect(rows).toHaveLength(1);
      expect(Buffer.from(rows[0].ciphertext).toString()).not.toContain(credential);
    });

    it('revokes with the version, for who may manage them only', async () => {
      const gone = randomUUID();
      await su.query(
        `insert into integrations.connections (organization_id, id, connector_type, display_name, config)
         values ($1, $2, 'email_smtp', 'To revoke', '{}')`,
        [org, gone],
      );
      const path = `${root()}/connections/${gone}`;
      expectError(await call(owner, 'DELETE', path), 428, 'PRECONDITION_REQUIRED');
      expectError(
        await call(member, 'DELETE', path, { headers: { 'if-match': '"1"' } }),
        403,
        'FORBIDDEN',
      );
      const done = await call(owner, 'DELETE', path, { headers: { 'if-match': '"1"' } });
      expect(done.status, done.text).toBe(204);
    });

    it('makes a callback address once, or says it is not available', async () => {
      const inbound = randomUUID();
      await su.query(
        `insert into integrations.connections (organization_id, id, connector_type, display_name, config)
         values ($1, $2, 'inbound_webhook', 'Callback', '{}')`,
        [org, inbound],
      );
      const path = `${root()}/connections/${inbound}/webhook-endpoints`;
      expectError(await call(member, 'POST', path), 403, 'FORBIDDEN');
      const made = await call(owner, 'POST', path);
      if (!enabled) {
        expectError(made, 409, 'CONNECTOR_NOT_AVAILABLE');
        return;
      }
      expect(made.status, made.text).toBe(201);
      expect(made.headers.get('cache-control')).toBe('no-store');
      const created = made.json as components['schemas']['CreatedWebhookEndpoint'];
      expect(created.url).toContain('/api/webhooks/');
      const { rows } = await su.query(
        'select token_hash from integrations.webhook_endpoints where id = $1',
        [created.id],
      );
      const token = decodeURIComponent(created.url.split('/').at(-1) ?? '');
      expect(rows[0].token_hash).not.toContain(token);
    });

    it('asks a connection to read its source, or says it is not available', async () => {
      const asked = await call(owner, 'POST', `${root()}/connections/${connection}/sync`);
      if (!enabled) {
        expectError(asked, 409, 'CONNECTOR_NOT_AVAILABLE');
        return;
      }
      expect(asked.status, asked.text).toBe(202);
    });
  });

  it('has validated a real response from every operation it covers that can run here', () => {
    const ours = operations()
      .filter(({ status, path }) => status === undefined && OURS(path))
      .map(({ method, path }) => operationName(method, path));
    expect(ours.length).toBeGreaterThan(0);
    // These only succeed with connectors on. Off, each one was shown refusing, in the tests above.
    const needsConnectors = (name: string) =>
      /POST .*(external-actions$|revisions|retries|connections$|webhook-endpoints|sync)/.test(name);
    const expected = enabled ? ours : ours.filter((name) => !needsConnectors(name));
    expect([...validated].filter((name) => OURS(name)).sort()).toEqual(expected.sort());
  });
});
