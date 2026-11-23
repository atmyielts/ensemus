// COMM-06: the steps the Work Unit parity scenarios share. Everything goes through the forms and the public
// API a person or client has. The superuser connection only reads a count back, or moves a clock forward
// the way the stack tests do, so that a refusal can be shown to have changed nothing.
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { connectClient } from '@ensemus/workflows/client';
import { reminderScheduleIdFor } from '@ensemus/workflows/schemas';
import { S3ObjectStore } from '@ensemus/storage';
import type pg from 'pg';
import { expect } from 'vitest';
import type { components } from '../../../packages/contracts/generated/openapi';
import { locationOf, mainOf, membershipOf, statusOn, workPage } from '../../helpers/flows';
import {
  BASE,
  type Form,
  type Jar,
  type Person,
  post,
  read,
  submit,
  visit,
} from '../../helpers/forms';
import { contractProblems } from '../../helpers/openapi';
import { secret } from '../../helpers/stack';
import type { Observation } from '../rules';

type ApiError = components['schemas']['Error'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What must never reach a client: SQL, parameters, ORM wording, or anything from a stack trace. */
const INTERNALS =
  /\bselect\b[\s\S]*\bfrom\b|insert into|update \S+ set|delete from|stack|postgres|drizzle|node_modules|\bat \S+:\d+:\d+/i;

/** How long a plan gets to reach its next stop. A worker that has just restarted needs longer. */
export const PLAN_WAIT = { timeout: 45_000, interval: 500 };
export const RESUME_WAIT = { timeout: 90_000, interval: 500 };
/** The dispatcher makes a tenant's schedule from an event, and reminders run after it is triggered. */
export const UPKEEP_WAIT = { timeout: 60_000, interval: 500 };
/** Up to two 30-second waits if the store was slow, as tests/stack/restore.test.ts explains. */
export const LEDGER_WAIT = { timeout: 90_000, interval: 250 };
export const STREAM_WAIT = { timeout: 15_000, interval: 100 };

export const decisionsPath = (organization: string, approval: string) =>
  `/o/${organization}/approvals/${approval}`;
export const inboxPath = (organization: string) => `/o/${organization}/inbox`;
export const workUnitsApi = (organization: string) =>
  `/api/v1/organizations/${organization}/work-units`;
export const workUnitApi = (organization: string, id: string) =>
  `${workUnitsApi(organization)}/${id}`;

/** The status a person is told, read fresh. A page that states none fails here, not later. */
export async function statusShown(path: string, person: Person): Promise<string> {
  const { status, html } = await read(path, person.jar);
  const shown = statusOn(html);
  if (!shown) throw new Error(`The page answered ${status} and states no status`);
  return shown;
}

/** The refusal notice a page shows a person, in the words on the screen. */
export function noticeOn(html: string): string | undefined {
  const main = mainOf(html);
  const notice =
    /<div\b(?=[^>]*\bdata-slot="alert")(?=[^>]*\brole="alert")[^>]*>\s*<div\b[^>]*\bdata-slot="alert-description"[^>]*>([^<]*)<\/div>/.exec(
      main,
    )?.[1] ?? /<p class="notice error" role="alert">([^<]*)<\/p>/.exec(main)?.[1];
  return notice?.replaceAll('&#x27;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

/**
 * A form refused by the service sends the person back to the page with a code. This reads that page, so
 * what comes back is both the code and what the person was really told. Anything else, such as a success
 * going through, stops the scenario.
 */
export async function refusal(response: Response, page: string, person: Person) {
  const location = locationOf(response);
  const expected = `${page}?error=`;
  if (response.status !== 303 || !location.startsWith(expected)) {
    throw new Error(`Expected a refusal, and the answer was ${response.status}`);
  }
  const { html } = await read(location, person.jar);
  const message = noticeOn(html);
  if (!message) throw new Error('The refusal was not explained to the person');
  return { code: location.slice(expected.length), message };
}

export interface WorkRow {
  readonly status: string;
  readonly version: number;
  readonly title: string;
}

/** What the row really holds, so "nothing happened" is read back and not assumed. */
export async function rowOf(su: pg.Client, id: string): Promise<WorkRow> {
  const { rows } = await su.query<WorkRow>(
    'select status, version::int as version, title from work.work_units where id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error('No such work');
  return row;
}

/**
 * Counts rows. `from` is always a constant from a scenario, with values passed as parameters, because a
 * count is what shows a refused request left nothing behind.
 */
export async function countOf(su: pg.Client, from: string, values: readonly string[]) {
  const { rows } = await su.query<{ n: number }>(`select count(*)::int as n from ${from}`, [
    ...values,
  ]);
  return rows[0]?.n ?? 0;
}

/** Asks for a review through the work's page, and returns the approval that came of it. */
export async function askForReview(
  su: pg.Client,
  asker: Person,
  approver: Person,
  organization: string,
  id: string,
) {
  const page = workPage(organization, id);
  const asked = await submit(page, asker.jar, /Request review/, {
    approverMembershipId: await membershipOf(su, approver, organization),
  });
  expect(locationOf(asked)).toBe(page);
  return approvalOn(page, asker, organization);
}

/** The approval a work page links to. A plan asks for its own, so this also finds that one. */
export async function approvalOn(page: string, person: Person, organization: string) {
  const { html } = await read(page, person.jar);
  const approvalId = /\/approvals\/([0-9a-f-]{36})"/.exec(html)?.[1];
  if (!approvalId) throw new Error('No approval link on the page');
  return { approvalId, path: decisionsPath(organization, approvalId) };
}

export const deciding = (decision: 'approve' | 'deny') => (form: Form) =>
  form.hidden.get('decision') === decision;

export const decisionsOn = (su: pg.Client, approvalId: string) =>
  countOf(su, 'work.approval_decisions where approval_id = $1', [approvalId]);

/** Moves an approval's clock past its end, as if the time had really gone by. */
export const runOutOfTime = (su: pg.Client, approvalId: string) =>
  su.query(`update work.approvals set expires_at = now() - interval '1 minute' where id = $1`, [
    approvalId,
  ]);

/** Attaches a file through the page, and returns the link the page gives it. */
export async function upload(person: Person, organization: string, id: string, file: File) {
  const page = workPage(organization, id);
  const response = await submit(page, person.jar, /name="file"/, { file });
  expect(response.status).toBe(303);
  expect(locationOf(response)).toBe(page);
  return linkTo(page, person, file.name);
}

export async function linkTo(page: string, person: Person, name: string) {
  const { html } = await read(page, person.jar);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = new RegExp(`href="([^"]+/files/[0-9a-f-]{36})">${escaped}<`).exec(html)?.[1];
  if (!link) throw new Error('No link to the file on the page');
  return link;
}

export const artifactIn = (link: string) => link.slice(link.lastIndexOf('/') + 1);

/** A download's status, with the body read so a refusal can be checked for what it gave away. */
export async function download(link: string, jar?: Jar) {
  const response = await visit(link, jar);
  return { status: response.status, body: await response.text() };
}

/** The object store the deployment really writes to, reached through the test overlay's port. */
export const objectStore = () =>
  new S3ObjectStore({
    endpoint: 'http://127.0.0.1:58333',
    bucket: 'ensemus',
    accessKey: secret('objects_access_key'),
    secretKey: secret('objects_secret_key'),
  });

export type ApiResult = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
};

export type ApiOptions = {
  readonly body?: unknown;
  readonly raw?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly key?: string;
  readonly replica?: 'web' | 'web-2';
};

/**
 * One call to the public API, from a client's side of the proxy. Every answer is checked against
 * docs/specifications/openapi.yaml, so a mode that answered off contract fails here.
 */
export async function api(
  person: Person | undefined,
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResult> {
  const payload =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(person ? { cookie: person.jar.cookie } : {}),
      ...(method === 'GET' ? {} : { origin: BASE }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...(options.replica === 'web-2' ? { 'x-ensemus-test-replica': '2' } : {}),
      ...options.headers,
    },
    redirect: 'manual',
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
  expect(problems).toEqual([]);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/**
 * Holds an error answer to the one envelope, and returns what may be compared across modes. The request
 * ID differs on every call, so it is checked here and left out of what comes back.
 */
export function envelope(result: ApiResult, status: number, code: string) {
  expect(result.status, result.text).toBe(status);
  expect(result.text).not.toMatch(INTERNALS);
  const error = result.json as ApiError;
  expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.request_id).toMatch(UUID);
  expect(result.headers.get('x-request-id')).toBe(error.request_id);
  expect(result.headers.get('cache-control')).toContain('no-store');
  return {
    status: result.status,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    fields: Object.keys(error).sort(),
    // JSON.parse made this, so it is plain data. The harness refuses it if it holds an identifier.
    details: (error.details ?? null) as Observation,
  };
}

/** Each row of a person's inbox, as they see it, top first. */
export async function inboxRows(person: Person, organization: string) {
  const { html } = await read(inboxPath(organization), person.jar);
  // The inbox streams in after its loading state, so this reads the whole response. The rows are the
  // only list items holding one of these forms.
  return [...html.matchAll(/<li>(?:(?!<\/li>)[\s\S])*?<\/li>/g)]
    .map(([row]) => row.replaceAll('<!-- -->', ''))
    .filter((row) => row.includes('name="target"'));
}

const INBOX_WORDS = [
  'An approval needs your decision',
  'You were put on some work',
  'A review of your work was decided',
] as const;

/** One inbox row as an observation: what it says and its badges, without the title or the time. */
export function describeRow(row: string) {
  const says = INBOX_WORDS.find((words) => row.includes(words));
  if (!says) throw new Error('An inbox row this scenario did not expect');
  return { says, reminder: row.includes('>Reminder<'), unread: row.includes('>New<') };
}

/**
 * Hands over a way to run this tenant's upkeep now, through its real schedule, rather than waiting up to
 * 15 minutes for it. Reaches Temporal the way tests/stack/pages.test.ts does, from outside the web tier.
 */
export async function withUpkeep<T>(
  organization: string,
  use: (runUpkeep: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const temporal = await connectClient({
    address: '127.0.0.1:57233',
    namespace: 'default',
    codecKey: secret('temporal_codec_key'),
  });
  try {
    const handle = temporal.client.schedule.getHandle(reminderScheduleIdFor(organization));
    await expect
      .poll(
        () =>
          handle.describe().then(
            () => true,
            () => false,
          ),
        UPKEEP_WAIT,
      )
      .toBe(true);
    return await use(() => handle.trigger(ScheduleOverlapPolicy.ALLOW_ALL));
  } finally {
    await temporal.close();
  }
}

/** Reads the one accountable owner a work page names, and how many it names. */
export function ownersOn(ownerSection: string) {
  const named = [...ownerSection.matchAll(/<dt>Accountable owner<\/dt><dd>([^<]*)<\/dd>/g)];
  return { count: named.length, name: named[0]?.[1] };
}

/** A form from one person's page, sent by someone else. This is what a forged request can do. */
export const forged = (
  page: string,
  person: Person,
  form: Form,
  values: Parameters<typeof post>[3] = {},
) => post(page, person.jar, form, values);
