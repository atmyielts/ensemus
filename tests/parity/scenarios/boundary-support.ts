// COMM-06: the steps the boundary scenarios share. Everything here goes through the product's own pages
// and API, as tests/stack does, and reads the database only to check what those left behind. Nothing
// returned from here that reaches an observation holds an ID, a name or an address, so a failure message
// names what leaked by its label and never repeats the value.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type pg from 'pg';
import { expect } from 'vitest';
import type { ResolvedConfig } from '../../helpers/compose-pins';
import { createWork, locationOf, membershipOf, workPage } from '../../helpers/flows';
import {
  aClientAddress,
  BASE,
  type Form,
  formOn,
  type Jar,
  join,
  onReplica,
  type Person,
  post,
  read,
  submit,
  tokenIn,
  visit,
} from '../../helpers/forms';
import { compose, repoRoot } from '../../helpers/stack';
import { eventsPath, lastIdOf, type openStreams, type Stream } from '../../helpers/streams';
import type { ParityTenant } from '../seams';

export type Replica = 'web' | 'web-2';
export type Streams = ReturnType<typeof openStreams>;

/** Something that must not turn up somewhere, with a label that is safe to print. */
export type Named = { readonly name: string; readonly value: string };

export const POLL = { timeout: 15_000, interval: 100 };

/** Longer than a poll and a reconnect, so a frame that was going to arrive has arrived. */
export const settle = () => new Promise((done) => setTimeout(done, 2_500));

export const fresh = (label: string) => `${label} ${randomUUID()}`;

/** A generated value nothing else could hold, so finding it anywhere means it travelled. */
export const canary = (kind: string) => `CANARY${kind}${randomUUID().replaceAll('-', '')}`;

export const foundIn = (body: string, named: readonly Named[]) =>
  named.filter(({ value }) => body.includes(value)).map(({ name }) => name);

export const named = (values: Readonly<Record<string, string>>): Named[] =>
  Object.entries(values).map(([name, value]) => ({ name, value }));

export const occurrences = (text: string, what: string) => text.split(what).length - 1;

/** The code a form sent someone back with, as the address bar states it. */
export const errorIn = (response: Response) =>
  new URL(locationOf(response), BASE).searchParams.get('error');

export const peoplePage = (organization: string) => `/o/${organization}/people`;
export const clientsPage = (organization: string) => `/o/${organization}/clients`;
export const apiRoot = (organization: string) => `/api/v1/organizations/${organization}`;

// --- Reading a page in each form the framework asks for it

export type Received = { status: number; type: string; body: string };

export const AS_HTML: Record<string, string> = {};
export const AS_PAYLOAD: Record<string, string> = { rsc: '1' };

/** How the framework asks for the same page: as HTML, as an RSC payload, and as a prefetch of one. */
export const REQUESTS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['html', AS_HTML],
  ['rsc', AS_PAYLOAD],
  ['prefetch', { rsc: '1', 'next-router-prefetch': '1' }],
];

export async function receive(
  path: string,
  jar: Jar,
  headers: Record<string, string>,
): Promise<Received> {
  let url = `${BASE}${path}`;
  for (;;) {
    const response = await fetch(url, {
      headers: { cookie: jar.cookie, ...headers },
      redirect: 'manual',
    });
    // Next.js sends an RSC request without its cache-busting value back for one, as the router has.
    const location = response.headers.get('location');
    if (response.status === 307 && location && /[?&]_rsc\b/.test(location)) {
      url = new URL(location, BASE).href;
      continue;
    }
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: await response.text(),
    };
  }
}

// --- The public API

export type ApiAnswer = {
  readonly status: number;
  readonly code: string | null;
  readonly message: string | null;
  readonly text: string;
  readonly json: unknown;
};

/**
 * One call to the public API. The time limit is for a stream that opens when it should have been
 * refused: reading it to the end would never finish, and the abort fails the scenario, as it should.
 */
export async function api(
  jar: Jar,
  method: string,
  path: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly key?: string;
  } = {},
): Promise<ApiAnswer> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: jar.cookie,
      'x-ensemus-test-client': aClientAddress(),
      ...(method === 'GET' ? {} : { origin: BASE }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...options.headers,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const error = (json ?? {}) as { code?: unknown; message?: unknown };
  return {
    status: response.status,
    code: typeof error.code === 'string' ? error.code : null,
    message: typeof error.message === 'string' ? error.message : null,
    text,
    json,
  };
}

// --- Things in a tenant

export async function organizationName(su: pg.Client, organization: string) {
  const { rows } = await su.query('select name from org.organizations where id = $1', [
    organization,
  ]);
  if (!rows[0]) throw new Error('No such organization');
  return rows[0].name as string;
}

export async function accountOf(su: pg.Client, person: Person) {
  const { rows } = await su.query('select id from identity.users where email = $1', [person.email]);
  if (!rows[0]) throw new Error('No such account');
  return rows[0].id as string;
}

export async function countRows(su: pg.Client, table: string, column: string, value: string) {
  const { rows } = await su.query(`select count(*)::int as n from ${table} where ${column} = $1`, [
    value,
  ]);
  return rows[0].n as number;
}

export async function workRow(su: pg.Client, id: string) {
  const { rows } = await su.query(
    'select title, status, version::int as version from work.work_units where id = $1',
    [id],
  );
  return rows[0] as { title: string; status: string; version: number };
}

/**
 * What a person's refusals left on the record. Refusals are kept to one row an hour, so a run that
 * crosses the hour would make two identical rows: `distinct` keeps that from failing it. Whether a row
 * exists at all, and exactly what it says, is still what this shows.
 */
export async function refusalsOn(su: pg.Client, organization: string, actor: string) {
  const { rows } = await su.query(
    `select distinct action, decision, safe_reason, target_ref from governance.audit_events
     where organization_id = $1 and actor_id = $2 and action like 'access.refused%'
     order by safe_reason`,
    [organization, actor],
  );
  return rows as Array<{
    action: string;
    decision: string;
    safe_reason: string;
    target_ref: string;
  }>;
}

/** The whole text of every refusal on a tenant, to check that nothing a request sent reached one. */
export async function allAuditText(su: pg.Client, organizations: readonly string[]) {
  const { rows } = await su.query(
    'select * from governance.audit_events where organization_id = any($1)',
    [organizations],
  );
  return JSON.stringify(rows);
}

export async function addClient(tenant: ParityTenant, displayName: string) {
  const page = clientsPage(tenant.organization);
  const response = await submit(page, tenant.owner.jar, /Client name/, { displayName });
  expect(locationOf(response)).toBe(page);
}

export async function addProject(tenant: ParityTenant, name: string, clientId?: string) {
  const page = clientsPage(tenant.organization);
  const response = await submit(page, tenant.owner.jar, /Project name/, {
    name,
    ...(clientId ? { clientId } : {}),
  });
  expect(locationOf(response)).toBe(page);
}

export async function clientIdOf(su: pg.Client, organization: string, displayName: string) {
  const { rows } = await su.query(
    'select id from work.clients where organization_id = $1 and display_name = $2',
    [organization, displayName],
  );
  if (!rows[0]) throw new Error('No such client');
  return rows[0].id as string;
}

/** Attaches a file through the work page, and returns its ID from the link that page then shows. */
export async function attach(person: Person, page: string, file: File) {
  const response = await submit(page, person.jar, /name="file"/, { file });
  expect(locationOf(response)).toBe(page);
  const name = file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { html } = await read(page, person.jar);
  const id = new RegExp(`href="[^"]+/files/([0-9a-f-]{36})">${name}<`).exec(html)?.[1];
  if (!id) throw new Error('No link to the file that was attached');
  return id;
}

export async function askForReview(
  su: pg.Client,
  by: Person,
  reviewer: Person,
  org: string,
  id: string,
) {
  const page = workPage(org, id);
  const asked = await submit(page, by.jar, /Request review/, {
    approverMembershipId: await membershipOf(su, reviewer, org),
  });
  expect(locationOf(asked)).toBe(page);
  const approval = /\/approvals\/([0-9a-f-]{36})"/.exec((await read(page, by.jar)).html)?.[1];
  if (!approval) throw new Error('No approval link');
  return approval;
}

/** One of everything a tenant has an ID for, each holding text that could not be anyone else's. */
export interface Estate {
  readonly organization: string;
  readonly work: string;
  readonly file: string;
  readonly approval: string;
  readonly project: string;
  readonly client: string;
  /** Text only this tenant should ever be shown. */
  readonly texts: Readonly<Record<string, string>>;
  readonly fileBody: string;
  readonly title: string;
}

export async function buildEstate(su: pg.Client, tenant: ParityTenant): Promise<Estate> {
  const { organization, owner } = tenant;
  const reviewer = await join(owner, organization, fresh('Reviewer'));
  const clientName = fresh('Client');
  const projectName = fresh('Project');
  const title = fresh('Title');
  const objective = fresh('Objective');
  const fileName = `document-${randomUUID()}.txt`;
  const fileBody = fresh('Document body');

  await addClient(tenant, clientName);
  const client = await clientIdOf(su, organization, clientName);
  await addProject(tenant, projectName, client);
  const { rows } = await su.query(
    'select id from work.projects where organization_id = $1 and name = $2',
    [organization, projectName],
  );
  if (!rows[0]) throw new Error('No such project');
  const project = rows[0].id as string;

  const work = await createWork(owner, organization, { title, objective, projectId: project });
  const file = await attach(
    owner,
    workPage(organization, work),
    new File([fileBody], fileName, { type: 'text/plain' }),
  );
  const approval = await askForReview(su, owner, reviewer, organization, work);

  return {
    organization,
    work,
    file,
    approval,
    project,
    client,
    fileBody,
    title,
    texts: {
      'organization name': await organizationName(su, organization),
      'owner name': owner.name,
      'owner address': owner.email,
      'reviewer name': reviewer.name,
      'reviewer address': reviewer.email,
      'client name': clientName,
      'project name': projectName,
      'work title': title,
      'work objective': objective,
      'file name': fileName,
      'file body': fileBody,
    },
  };
}

/** Its pages, under its own organization, by what a person would call them. */
export function pagesOf(estate: Estate): Record<string, string> {
  const org = `/o/${estate.organization}`;
  return {
    'organization home': org,
    'work list': `${org}/work`,
    'new work': `${org}/work/new`,
    'work detail': `${org}/work/${estate.work}`,
    file: `${org}/work/${estate.work}/files/${estate.file}`,
    'approvals list': `${org}/approvals`,
    'approval detail': `${org}/approvals/${estate.approval}`,
    people: `${org}/people`,
    'clients and projects': `${org}/clients`,
    inbox: `${org}/inbox`,
    'work in a project': `${org}/work?project=${estate.project}`,
  };
}

/** Its IDs asked for under someone else's organization, where row-level security has to answer. */
export function pagesNamedUnder(estate: Estate, other: string): Record<string, string> {
  const org = `/o/${other}`;
  return {
    'work detail under another organization': `${org}/work/${estate.work}`,
    'file under another organization': `${org}/work/${estate.work}/files/${estate.file}`,
    'approval detail under another organization': `${org}/approvals/${estate.approval}`,
  };
}

export function apiReadsOf(estate: Estate): Record<string, string> {
  const root = apiRoot(estate.organization);
  return {
    'work list': `${root}/work-units`,
    'work detail': `${root}/work-units/${estate.work}`,
    'work events': eventsPath(estate.organization, estate.work),
    'approvals list': `${root}/approvals`,
    'approval detail': `${root}/approvals/${estate.approval}`,
  };
}

export function apiReadsNamedUnder(estate: Estate, other: string): Record<string, string> {
  const root = apiRoot(other);
  return {
    'work detail under another organization': `${root}/work-units/${estate.work}`,
    'work events under another organization': eventsPath(other, estate.work),
    'approval detail under another organization': `${root}/approvals/${estate.approval}`,
  };
}

/** Everything of the estate that must be absent, leaving out an ID the request itself just named. */
export const leakable = (estate: Estate, path: string): Named[] => [
  ...named(estate.texts),
  ...named({
    'organization ID': estate.organization,
    'work ID': estate.work,
    'file ID': estate.file,
    'approval ID': estate.approval,
    'project ID': estate.project,
    'client ID': estate.client,
  }).filter(({ value }) => !path.includes(value)),
];

// --- Streams

/** Moves a Work Unit on by one version through the public API, and returns the new version. */
export async function edit(person: Person, org: string, id: string, version: number) {
  const answer = await api(person.jar, 'PATCH', `${apiRoot(org)}/work-units/${id}`, {
    body: { objective: fresh('Edited') },
    headers: { 'if-match': `"${version}"` },
  });
  expect(answer.status).toBe(200);
  return version + 1;
}

/** Work whose title can be told apart, moved to a version of its own. */
export async function workAt(person: Person, org: string, version: number) {
  const id = await createWork(person, org, { title: fresh('Streamed') });
  let at = 1;
  while (at < version) at = await edit(person, org, id, at);
  return id;
}

/**
 * The versions a stream carried, after checking it carried nothing else. A frame that held anything
 * but this work's status number would fail here, whatever the versions were.
 */
export function versionsOn(stream: Stream) {
  for (const frame of stream.received) {
    expect(frame.event).toBe('status');
    expect(frame.data).toBe(frame.id);
  }
  const frames = stream.raw().replace(/^retry: \d+\n\n/, '');
  expect(frames.replaceAll(/(id: \d+\nevent: status\ndata: \d+\n\n|: keep-alive\n\n)/g, '')).toBe(
    '',
  );
  return stream.received.map((frame) => Number(frame.id));
}

export const waitForVersion = (stream: Stream, version: number) =>
  expect.poll(() => lastIdOf(stream), POLL).toBe(String(version));

// --- Invitations

export async function invite(by: Person, organization: string, email: string) {
  const response = await submit(peoplePage(organization), by.jar, /name="email"/, {
    email,
    role: 'member',
  });
  const token = tokenIn(await response.text());
  if (!token) throw new Error(`No invitation link (status ${response.status})`);
  return token;
}

export const confirming = (person: Person) => (form: Form) =>
  form.html.includes(`Confirm ${person.email}`) && form.hidden.has('invitationId');

export async function membershipsOf(su: pg.Client, person: Person) {
  const { rows } = await su.query(
    `select m.organization_id, m.role, m.status from org.memberships m
     join identity.users u on u.id = m.user_id where u.email = $1`,
    [person.email],
  );
  return rows as Array<{ organization_id: string; role: string; status: string }>;
}

// --- Secrets the deployment holds

/** Every secret a deployment holds, except the public half of the sealing key, which is public. */
export const serverSecrets = (): Named[] =>
  readdirSync(joinPath(repoRoot, '.local', 'secrets'))
    .filter((file) => !file.endsWith('public_key.pem'))
    .map((file) => ({
      name: `secret ${file}`,
      value: readFileSync(joinPath(repoRoot, '.local', 'secrets', file), 'utf8').trim(),
    }))
    .filter(({ value }) => value.length > 0);

/** The pages and API lists a person's browser could be sent from one organization. */
export const scannedPages = (org: string, work: string, approval: string) => [
  '/',
  `/o/${org}`,
  `/o/${org}/work`,
  `/o/${org}/work/new`,
  workPage(org, work),
  `/o/${org}/approvals`,
  `/o/${org}/approvals/${approval}`,
  `/o/${org}/people`,
  `/o/${org}/clients`,
  `/o/${org}/inbox`,
  `${apiRoot(org)}/work-units`,
  `${apiRoot(org)}/approvals`,
];

/** Reads every page in every form as this person, and names whatever was found, and where by label. */
export async function scan(person: Person, pages: readonly string[], forbidden: readonly Named[]) {
  const found: string[] = [];
  let answered = 0;
  let payloads = 0;
  for (const path of pages) {
    for (const [form, headers] of REQUESTS) {
      const received = await receive(path, person.jar, headers);
      if (received.status === 200) answered += 1;
      // A page that answered an RSC request with anything else was not really read as one.
      if (form !== 'html' && received.status === 200 && !path.startsWith('/api/')) {
        expect(received.type, form).toContain('text/x-component');
        payloads += 1;
      }
      for (const name of foundIn(received.body, forbidden)) found.push(`${name} in ${form}`);
    }
  }
  return { found, answered, payloads };
}

/** Everything every service in the stack has logged so far. */
export const stackLogs = () => compose('logs', '--no-log-prefix');

export const logsOf = (service: string) => compose('logs', '--no-log-prefix', service);

// --- Replicas

const disabling = (target: string) => (form: Form) =>
  form.hidden.get('membershipId') === target && />Disable</.test(form.html);

/** Asks each replica for itself, so a change "on the other replica" cannot quietly be the same one. */
export async function expectEachReplicaAnswers() {
  for (const replica of ['web', 'web-2'] as const) {
    const response = await onReplica(replica, () => visit('/api/health/ready'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ensemus-served-by')).toBe(replica);
  }
}

/**
 * A member is disabled on one replica, after every path has been read on both, with a form in hand and
 * a stream open on the other. No waiting of any kind: the very next request there is refused.
 */
export async function disabledWhileWarm(
  su: pg.Client,
  tenant: ParityTenant,
  streams: Streams,
  changedOn: Replica,
  askedOf: Replica,
) {
  const { organization: org, owner } = tenant;
  const here = <T>(work: () => Promise<T>) => onReplica(changedOn, work);
  const there = <T>(work: () => Promise<T>) => onReplica(askedOf, work);
  const tenantName = await organizationName(su, org);
  const leaver = await join(owner, org, fresh('Leaver'));
  const id = await createWork(leaver, org, { title: fresh('Theirs') });
  const page = workPage(org, id);
  const warm: Record<string, string> = {
    home: `/o/${org}`,
    'work list': `/o/${org}/work`,
    'work detail': page,
    'approvals list': `/o/${org}/approvals`,
    'work through the API': `${apiRoot(org)}/work-units/${id}`,
  };

  for (const [label, path] of Object.entries(warm)) {
    expect((await here(() => read(path, leaver.jar))).status, label).toBe(200);
    expect((await there(() => read(path, leaver.jar))).status, label).toBe(200);
  }
  const form = await there(() => formOn(page, leaver.jar, (f) => f.hidden.get('to') === 'ready'));
  const stream = await streams.follow(leaver.jar, eventsPath(org, id), { replica: askedOf });
  await waitForVersion(stream, 1);
  expect(stream.servedBy).toBe(askedOf);

  const target = await membershipOf(su, leaver, org);
  const disabled = await here(() =>
    submit(peoplePage(org), owner.jar, disabling(target), { confirm: 'yes' }),
  );
  expect(locationOf(disabled)).toBe(peoplePage(org));

  const statuses: Record<string, number> = {};
  await Promise.all(
    Object.entries(warm).map(async ([label, path]) => {
      const { status, html } = await there(() => read(path, leaver.jar));
      statuses[label] = status;
      expect(status, label).toBe(404);
      expect(html.includes(tenantName), label).toBe(false);
    }),
  );
  const late = await there(() => post(page, leaver.jar, form));
  expect(late.status).toBe(404);
  const { status: workStatus, version } = await workRow(su, id);
  expect({ workStatus, version }).toEqual({ workStatus: 'queued', version: 1 });
  await expect.poll(() => stream.ended(), POLL).toBe(true);

  return {
    afterDisabling: Object.fromEntries(Object.entries(statuses).sort()),
    formAlreadyInHand: late.status,
    workStatus,
    streamEnded: stream.ended(),
  };
}

/** The same for a role: an admin can invite on the other replica, and then at once cannot. */
export async function demotedWhileWarm(
  su: pg.Client,
  tenant: ParityTenant,
  changedOn: Replica,
  askedOf: Replica,
) {
  const { organization: org, owner } = tenant;
  const here = <T>(work: () => Promise<T>) => onReplica(changedOn, work);
  const there = <T>(work: () => Promise<T>) => onReplica(askedOf, work);
  const people = peoplePage(org);
  const name = fresh('Admin');
  const admin = await join(owner, org, name);
  const target = await membershipOf(su, admin, org);
  const setRole = (role: string) =>
    here(() =>
      submit(
        people,
        owner.jar,
        (f) =>
          f.hidden.get('membershipId') === target && f.html.includes(`Save access for ${name}`),
        { role },
      ),
    );
  expect(locationOf(await setRole('admin'))).toBe(people);

  // Being an admin is seen at once as well, so no replica remembers the old answer either way.
  const inviteForm = await there(() => formOn(people, admin.jar, /name="email"/));
  const whileAdmin = await there(() =>
    post(people, admin.jar, inviteForm, {
      email: `first-${randomUUID()}@example.invalid`,
      role: 'member',
    }),
  );
  expect(whileAdmin.status).toBe(200);
  const linkWhileAdmin = tokenIn(await whileAdmin.text()) !== undefined;
  expect(linkWhileAdmin).toBe(true);

  expect(locationOf(await setRole('member'))).toBe(people);

  const email = `second-${randomUUID()}@example.invalid`;
  const refused = await there(() => post(people, admin.jar, inviteForm, { email, role: 'member' }));
  const linkAfter = tokenIn(await refused.text()) !== undefined;
  expect(linkAfter).toBe(false);
  const invitationsAfter = await countRows(su, 'org.invitations', 'email', email);
  expect(invitationsAfter).toBe(0);
  const page = await there(() => read(people, admin.jar));
  const formStillOffered = page.html.includes('name="email"');
  expect(formStillOffered).toBe(false);

  return { linkWhileAdmin, linkAfter, invitationsAfter, formStillOffered };
}

// --- The containers

const inContainer = (service: string, ...args: string[]) => compose('exec', '-T', service, ...args);

const inspect = (service: string, format: string) =>
  execFileSync('docker', ['inspect', compose('ps', '-q', service).trim(), '--format', format], {
    encoding: 'utf8',
  });

export const networksOf = (service: string) =>
  Object.keys(JSON.parse(inspect(service, '{{json .NetworkSettings.Networks}}')) as object);

/** Read from Docker, not looked up in a container: a lookup would itself be outbound DNS. */
export const addressesOf = (service: string) =>
  inspect(service, '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}').trim().split(/\s+/);

/** Tries a real connection from inside a container. It says connected, or blocked. */
export const connectFrom = (service: string, host: string, port: number) =>
  inContainer(
    service,
    'node',
    '-e',
    `const s=require('net').connect({host:'${host}',port:${port},timeout:3000});` +
      `s.on('connect',()=>{process.stdout.write('connected');s.destroy()});` +
      `s.on('timeout',()=>{process.stdout.write('blocked');s.destroy()});` +
      `s.on('error',()=>process.stdout.write('blocked'));`,
  );

/** Whether a name resolves inside a container. This is outbound DNS when it does not resolve there. */
export const lookUpFrom = (service: string, name: string) =>
  inContainer(
    service,
    'node',
    '-e',
    `require('dns').lookup('${name}',(e)=>{process.stdout.write(e?'blocked':'resolved')})`,
  );

export const temporalPackagesIn = (service: string) =>
  Number(
    inContainer(
      service,
      'sh',
      '-c',
      'ls /app/node_modules/.pnpm | grep -c temporalio || true',
    ).trim(),
  );

export const resolvedConfig = () =>
  JSON.parse(compose('config', '--format', 'json')) as ResolvedConfig;
