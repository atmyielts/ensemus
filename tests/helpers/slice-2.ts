// Steps for Slice 2 (ADR-027) on real containers: the API, a signed sender, the test mail sink, and what
// the database and Temporal hold afterwards. Only generated values: `@example.invalid` addresses and
// random secrets. It needs the `connectors` profile, and nothing here runs without it.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { signWebhook } from '@ensemus/connectors/runtime';
import pg from 'pg';
import { expect } from 'vitest';
import type { components } from '../../packages/contracts/generated/openapi';
import {
  aClientAddress,
  BASE,
  type Form,
  type Person,
  signUp,
  submit,
  createOrganization,
} from './forms';
import { contractProblems } from './openapi';
import { composeWith } from './stack';

type Schemas = components['schemas'];
export type ExternalAction = Schemas['ExternalAction'];
export type ExternalActionSummary = Schemas['ExternalActionSummary'];
export type ProposedExternalAction = Schemas['ProposedExternalAction'];
export type Connection = Schemas['Connection'];
export type CreatedWebhookEndpoint = Schemas['CreatedWebhookEndpoint'];
export type Approval = Schemas['Approval'];
export type WorkUnit = Schemas['WorkUnit'];

/**
 * The stack only has a connector worker when both are set, and the rest of the stack suite runs without
 * them, so this file skips there rather than failing. CI's `connectors` job sets them for the whole job.
 */
export const connectorsEnabled = () => process.env.ENSEMUS_CONNECTORS_ENABLED === 'true';

/** Compose with the profile on, so its services can be named whatever the environment says. */
export const connectors = (...args: string[]) =>
  composeWith({ COMPOSE_PROFILES: 'connectors' }, ...args);

/** Waits for what a run does on its own: a dispatcher, a workflow, and a worker in turn. */
export const RUN = { timeout: 90_000, interval: 500 };
/** The send's own deadline, then reconciling and ending. `SEND_DEADLINE_MS` is one minute. */
export const AFTER_DEADLINE = { timeout: 180_000, interval: 1_000 };
/** A killed worker: Temporal gives the send Activity two minutes before it looks at what happened. */
export const AFTER_KILL = { timeout: 300_000, interval: 2_000 };

// --- The API, through the proxy, with every answer checked against the specification.

export type ApiResult = { status: number; headers: Headers; text: string; json: unknown };

export async function api(
  person: Person | undefined,
  method: string,
  path: string,
  options: { body?: unknown; key?: string; ifMatch?: string } = {},
): Promise<ApiResult> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(person ? { cookie: person.jar.cookie } : {}),
      ...(method === 'GET' ? {} : { origin: BASE }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...(options.ifMatch ? { 'if-match': options.ifMatch } : {}),
    },
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await response.text();
  const { problems } = contractProblems({
    method,
    path,
    status: response.status,
    headers: response.headers,
    text,
  });
  expect(problems, `${method} ${path}`).toEqual([]);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

const organizationPath = (organization: string) => `/api/v1/organizations/${organization}`;
export const paths = {
  connections: (organization: string) => `${organizationPath(organization)}/connections`,
  connection: (organization: string, id: string) =>
    `${organizationPath(organization)}/connections/${id}`,
  endpoints: (organization: string, connection: string) =>
    `${organizationPath(organization)}/connections/${connection}/webhook-endpoints`,
  workUnits: (organization: string) => `${organizationPath(organization)}/work-units`,
  proposals: (organization: string, workUnit: string) =>
    `${organizationPath(organization)}/work-units/${workUnit}/external-actions`,
  actions: (organization: string) => `${organizationPath(organization)}/external-actions`,
  action: (organization: string, id: string) =>
    `${organizationPath(organization)}/external-actions/${id}`,
  revisions: (organization: string, id: string) =>
    `${organizationPath(organization)}/external-actions/${id}/revisions`,
  resolution: (organization: string, id: string) =>
    `${organizationPath(organization)}/external-actions/${id}/resolution`,
  retries: (organization: string, id: string) =>
    `${organizationPath(organization)}/external-actions/${id}/retries`,
  approval: (organization: string, id: string) =>
    `${organizationPath(organization)}/approvals/${id}`,
};

/** A page, for reading. Someone who cannot read the work gets the usual not found. */
export const actionPage = (organization: string, id: string) =>
  `/o/${organization}/external-actions/${id}`;
export const approvalPage = (organization: string, id: string) =>
  `/o/${organization}/approvals/${id}`;

// --- Generated values.

export const anAddress = (label: string) => `${label}-${randomUUID()}@example.invalid`;
/** A value that is searched for later, in places it must not be. Lower case, so an address can hold it. */
export const aCanary = (label: string) => `canary${label}${randomUUID().replaceAll('-', '')}`;

// --- A tenant with everything the slice needs, made through the API as an admin would.

export type Endpoint = { id: string; token: string; secret: string };
export type Tenant = {
  name: string;
  organization: string;
  owner: Person;
  /** Where mail goes out, and the address it goes out as. */
  mail: { id: string; fromAddress: string; credential: string };
  inbound: { id: string };
};

async function createConnection(
  owner: Person,
  organization: string,
  body: { connector_type: string; display_name: string; config: object; credential?: string },
) {
  const created = await api(owner, 'POST', paths.connections(organization), {
    body,
    key: randomUUID(),
  });
  expect(created.status, created.text).toBe(201);
  return created.json as Connection;
}

export async function newEndpoint(owner: Person, organization: string, connection: string) {
  const created = await api(owner, 'POST', paths.endpoints(organization, connection));
  expect(created.status, created.text).toBe(201);
  expect(created.headers.get('cache-control')).toContain('no-store');
  const { id, url, signing_secret: secret } = created.json as CreatedWebhookEndpoint;
  const token = /\/api\/webhooks\/([^/?#]+)$/.exec(url)?.[1];
  if (!token) throw new Error('No token in the callback address');
  return { id, token, secret } satisfies Endpoint;
}

export async function setUpTenant(name: string): Promise<Tenant> {
  const owner = await signUp(`${name} Owner`);
  const organization = await createOrganization(owner, `${name} ${randomUUID()}`);
  const fromAddress = anAddress('sender');
  const credential = randomBytes(24).toString('base64url');
  const mail = await createConnection(owner, organization, {
    connector_type: 'email_smtp',
    display_name: 'Test mail',
    config: { fromAddress },
    credential,
  });
  // A credential goes in and does not come back, in any form.
  expect(mail.has_credential).toBe(true);
  expect(JSON.stringify(mail)).not.toContain(credential);
  const inbound = await createConnection(owner, organization, {
    connector_type: 'inbound_webhook',
    display_name: 'Test callback',
    config: {},
  });
  return {
    name,
    organization,
    owner,
    mail: { id: mail.id, fromAddress, credential },
    inbound: { id: inbound.id },
  };
}

/** Work that asks for a receipt from outside, which needs a connection that can act. */
export async function createReceiptWork(person: Person, organization: string, title: string) {
  const created = await api(person, 'POST', paths.workUnits(organization), {
    body: {
      title,
      objective: 'Written by a test',
      completion_criteria: { external_receipt: true },
    },
    key: randomUUID(),
  });
  expect(created.status, created.text).toBe(201);
  return (created.json as WorkUnit).id;
}

// --- Proposing, deciding and resolving.

export type Email = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text_body: string;
};

export const anEmail = (to: string[], overrides: Partial<Email> = {}): Email => ({
  to,
  subject: 'A test message',
  text_body: 'Nothing here is real.',
  ...overrides,
});

export async function propose(
  person: Person,
  organization: string,
  workUnit: string,
  input: { connection: string; approver: string; email: Email },
) {
  const proposed = await api(person, 'POST', paths.proposals(organization, workUnit), {
    body: {
      connection_id: input.connection,
      approver_membership_id: input.approver,
      email: input.email,
    },
    key: randomUUID(),
  });
  expect(proposed.status, proposed.text).toBe(201);
  return proposed.json as ProposedExternalAction;
}

/** Decides through the page, so what is approved is what the page showed and bound. */
export async function approveOnPage(person: Person, organization: string, approval: string) {
  const decided = await submit(
    approvalPage(organization, approval),
    person.jar,
    (form: Form) => form.hidden.get('decision') === 'approve',
  );
  expect(decided.status).toBe(303);
  expect(decided.headers.get('location') ?? '').not.toContain('error=');
}

export async function readAction(person: Person, organization: string, id: string) {
  const read = await api(person, 'GET', paths.action(organization, id));
  expect(read.status, read.text).toBe(200);
  return {
    action: read.json as ExternalAction,
    etag: read.headers.get('etag') ?? '',
  };
}

export async function resolve(
  person: Person,
  organization: string,
  id: string,
  input: { resolution: 'confirmed_sent' | 'confirmed_not_sent'; reason: string },
) {
  const { etag } = await readAction(person, organization, id);
  const resolved = await api(person, 'POST', paths.resolution(organization, id), {
    body: input,
    ifMatch: etag,
  });
  expect(resolved.status, resolved.text).toBe(200);
  return resolved.json as ExternalAction;
}

// --- A sender of signed callbacks. The route has no session, no API and no answer but a status.

export type SignedRequest = { body: Buffer; headers: Record<string, string> };

/**
 * What a customer's system does. The key is the secret exactly as the API showed it, as UTF-8, because
 * that is what a sender holds and what gets sealed. Anything can be set wrong, to test the refusals.
 */
export function signedRequest(
  secret: string,
  envelope: unknown,
  options: { eventId?: string; timestampSeconds?: number } = {},
): SignedRequest {
  const body = Buffer.from(JSON.stringify(envelope));
  const eventId = options.eventId ?? `event-${randomUUID()}`;
  const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-ensemus-signature': signWebhook(Buffer.from(secret, 'utf8'), {
        timestampSeconds,
        eventId,
        body,
      }),
      'x-ensemus-timestamp': String(timestampSeconds),
      'x-ensemus-event-id': eventId,
    },
  };
}

/** Posts to the public address, from an address nobody else is using, and returns what came back. */
export async function postWebhook(token: string, request: SignedRequest) {
  const response = await fetch(`${BASE}/api/webhooks/${token}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { ...request.headers, 'x-ensemus-test-client': aClientAddress() },
    body: new Uint8Array(request.body),
  });
  return { status: response.status, text: await response.text() };
}

export const proposalEnvelope = (workUnit: string, connection: string, email: Email) => ({
  type: 'external_action.proposed',
  work_unit_id: workUnit,
  connection_id: connection,
  email,
});

// --- The test mail sink. The only place that knows how its control port is spoken to.

/** What the sink took. `rcptTo` is the envelope, which is who really receives it, Bcc included. */
export type SinkMessage = { mailFrom: string; rcptTo: string[]; raw: string };
export type SinkMode =
  | 'accept'
  | 'accept_then_silent'
  | 'refuse_recipient'
  | 'refuse_after_data'
  | 'busy'
  | 'silent_on_connect'
  | 'drop_after_data';

const sinkControl = () =>
  `http://127.0.0.1:${process.env.ENSEMUS_TEST_SMTP_CONTROL_PORT ?? '58025'}`;

export const sink = {
  async messages(): Promise<SinkMessage[]> {
    const response = await fetch(`${sinkControl()}/messages`);
    if (!response.ok) throw new Error(`Sink control answered ${response.status}`);
    return (await response.json()) as SinkMessage[];
  },
  async setMode(mode: SinkMode) {
    const response = await fetch(`${sinkControl()}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) throw new Error(`Sink control answered ${response.status}`);
  },
  /** Counters that only ever go up, to show there was not a second message or a second connection. */
  async stats(): Promise<{ received: number; connections: number }> {
    const response = await fetch(`${sinkControl()}/stats`);
    if (!response.ok) throw new Error(`Sink control answered ${response.status}`);
    return (await response.json()) as { received: number; connections: number };
  },
  /** Every test uses addresses of its own, so one never has to clear what another sent. */
  async messagesTo(address: string): Promise<SinkMessage[]> {
    return (await this.messages()).filter((message) => message.rcptTo.includes(address));
  },
};

// --- What the database holds, read as the superuser, past every rule, to check the rules held.

export async function statusOf(su: pg.Client, action: string) {
  const { rows } = await su.query(
    'select status, status_reason as reason from integrations.external_actions where id = $1',
    [action],
  );
  return rows[0] as { status: string; reason: string | null } | undefined;
}

export async function attemptsOf(su: pg.Client, action: string) {
  const { rows } = await su.query(
    `select attempt_no as "attemptNo", outcome, outcome_code as code
     from integrations.external_action_attempts
     where external_action_id = $1 order by attempt_no`,
    [action],
  );
  return rows as Array<{ attemptNo: number; outcome: string | null; code: string | null }>;
}

export async function actionsOnWork(su: pg.Client, workUnit: string) {
  const { rows } = await su.query(
    `select id, status, status_reason as reason, supersedes_id as "supersedesId",
       retry_of_id as "retryOfId"
     from integrations.external_actions where work_unit_id = $1 order by created_at`,
    [workUnit],
  );
  return rows as Array<{
    id: string;
    status: string;
    reason: string | null;
    supersedesId: string | null;
    retryOfId: string | null;
  }>;
}

export type Delivery = { state: string; rejectCode: string | null; bodyGone: boolean };

/** One endpoint's deliveries, oldest first. Each test makes its own endpoint, so these are its own. */
export async function deliveriesOf(su: pg.Client, endpoint: string): Promise<Delivery[]> {
  const { rows } = await su.query(
    `select state, reject_code as "rejectCode", body is null as "bodyGone"
     from integrations.webhook_deliveries where endpoint_id = $1 order by received_at`,
    [endpoint],
  );
  return rows;
}

export async function notificationsFor(su: pg.Client, membership: string, target: string) {
  const { rows } = await su.query(
    `select kind from platform.notifications
     where recipient_membership_id = $1 and target_ref = $2`,
    [membership, target],
  );
  return rows.map((row) => row.kind as string);
}

/** Every table a value must never reach: events, delivery, audit, the inbox and notifications. */
const NEVER_HOLD = [
  'platform.domain_events',
  'platform.outbox_events',
  'platform.inbox_events',
  'platform.notifications',
  'governance.audit_events',
  'integrations.webhook_deliveries',
];

export async function tablesHolding(su: pg.Client, value: string) {
  const found: string[] = [];
  for (const table of NEVER_HOLD) {
    const { rows } = await su.query(
      `select count(*)::int as n from ${table} row where row::text like '%' || $1 || '%'`,
      [value],
    );
    if (rows[0].n > 0) found.push(table);
  }
  return found;
}

// --- What a process kept: Temporal's database and every service's log.

export const dumpTemporal = () =>
  ['temporal', 'temporal_visibility']
    .map((database) => connectors('exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', database))
    .join('\n');

export const dumpApplicationDatabase = () =>
  connectors('exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'ensemus');

/** Everything that runs in a deployment. The sink is left out: it is the outside world in this test. */
const LOGGED_SERVICES = [
  'proxy',
  'web',
  'web-2',
  'worker',
  'connector-worker',
  'egress-gateway',
  'dispatcher',
  'temporal',
  'postgres',
];

export const serviceLogs = () =>
  connectors('logs', '--no-color', '--no-log-prefix', ...LOGGED_SERVICES);

/** The text itself, or as hex, or as base64, which is how a database dump shows a binary column. */
export function holds(dump: string, text: string) {
  const bytes = Buffer.from(text);
  return (
    dump.includes(text) ||
    dump.toLowerCase().includes(bytes.toString('hex')) ||
    dump.includes(bytes.toString('base64').replace(/=+$/, ''))
  );
}

// --- Failures.

/** SIGKILL, with no chance to finish anything: a real crash, and the exit code says so. */
export function killConnectorWorker() {
  const container = connectors('ps', '-q', 'connector-worker').trim();
  if (!container) throw new Error('The connector worker is not running');
  execFileSync('docker', ['kill', container], { encoding: 'utf8' });
  return execFileSync('docker', ['inspect', container, '--format', '{{.State.ExitCode}}'], {
    encoding: 'utf8',
  }).trim();
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
