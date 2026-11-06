// Drives the product the way a browser does with JavaScript off: it reads the page, takes the hidden
// fields Next.js and the page rendered, and posts the form back, through the proxy, against built
// images. Nothing here reaches past what a person's browser could send.
import { randomUUID } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // The proxy uses a local test certificate.

export const BASE = process.env.ENSEMUS_TEST_BASE ?? 'https://localhost:8443';
export const PASSWORD = 'correct horse battery staple';

export type Jar = { cookie: string };
export type Person = { jar: Jar; name: string; email: string };

/** Merges a response's cookies into the jar, as a browser would. */
export function remember(jar: Jar, response: Response) {
  const fresh = response.headers.getSetCookie().map((c) => c.split(';')[0] as string);
  const merged = new Map(
    [...jar.cookie.split('; ').filter(Boolean), ...fresh].map((c) => {
      const at = c.indexOf('=');
      return [c.slice(0, at), c.slice(at + 1)] as const;
    }),
  );
  jar.cookie = [...merged].map(([k, v]) => `${k}=${v}`).join('; ');
}

const headersOf = (jar?: Jar): Record<string, string> => (jar ? { cookie: jar.cookie } : {});

/** One request, without following redirects, so tests see exactly what the server answered. */
export const visit = (path: string, jar?: Jar) =>
  fetch(`${BASE}${path}`, { headers: headersOf(jar), redirect: 'manual' });

/**
 * Puts a streamed page together, which React's inline scripts do in a browser. A page can arrive with
 * a form or a section split over several hidden segments, depending on timing, and read raw that would
 * make a check on it pass or fail by luck.
 */
export function assembled(raw: string): string {
  const segments = new Map<string, string>();
  let html = raw;
  for (let opening = /<div hidden id="S:(\w+)">/.exec(html); opening;) {
    const start = opening.index + opening[0].length;
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = start;
    let end = start;
    for (let depth = 1; depth > 0;) {
      const tag = tags.exec(html);
      if (!tag) throw new Error('A streamed segment never closed');
      depth += tag[0] === '</div>' ? -1 : 1;
      end = tag.index;
    }
    segments.set(opening[1] as string, html.slice(start, end));
    html = html.slice(0, opening.index) + html.slice(tags.lastIndex);
    opening = /<div hidden id="S:(\w+)">/.exec(html);
  }
  for (const [, boundary, segment] of raw.matchAll(/\$RC\("B:(\w+)","S:(\w+)"\)/g)) {
    html = html.replace(
      new RegExp(`<!--\\$\\?--><template id="B:${boundary}"></template>[\\s\\S]*?<!--/\\$-->`),
      () => segments.get(segment as string) ?? '',
    );
  }
  for (let left = /<template id="P:(\w+)"><\/template>/; left.test(html);) {
    html = html.replace(left, (_, id: string) => segments.get(id) ?? '');
  }
  return html;
}

export async function read(path: string, jar?: Jar) {
  const response = await visit(path, jar);
  return {
    status: response.status,
    location: response.headers.get('location'),
    html: assembled(await response.text()),
  };
}

const unescapeHtml = (value: string) =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');

export type Form = { html: string; hidden: Map<string, string> };

/** Every form in a page, with its hidden fields whatever order their attributes came in. */
export function formsIn(html: string): Form[] {
  return [...html.matchAll(/<form\b[\s\S]*?<\/form>/g)].map(([form]) => {
    const hidden = new Map<string, string>();
    for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
      const attribute = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
      const name = attribute('name');
      if (attribute('type') === 'hidden' && name) {
        hidden.set(name, unescapeHtml(attribute('value') ?? ''));
      }
    }
    return { html: form, hidden };
  });
}

export type FormMatch = RegExp | ((form: Form) => boolean);

export async function formOn(path: string, jar: Jar | undefined, match: FormMatch): Promise<Form> {
  const { status, html } = await read(path, jar);
  const found = formsIn(html).find((form) =>
    match instanceof RegExp ? match.test(form.html) : match(form),
  );
  if (!found) throw new Error(`No matching form on ${path} (status ${status})`);
  return found;
}

export type Values = Record<string, string | string[] | File>;

/**
 * Posts a form back to the page it came from. Values replace hidden fields of the same name, which
 * is exactly what a forged request can do, so tests use it to check the server does not trust them.
 */
export async function post(
  path: string,
  jar: Jar | undefined,
  form: Form,
  values: Values = {},
  origin = BASE,
) {
  const body = new FormData();
  for (const [name, value] of form.hidden) {
    if (!(name in values)) body.append(name, value);
  }
  for (const [name, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  }
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...headersOf(jar), origin },
    body,
    redirect: 'manual',
  });
  if (jar) remember(jar, response);
  return response;
}

export async function submit(
  path: string,
  jar: Jar | undefined,
  match: FormMatch,
  values: Values = {},
) {
  return post(path, jar, await formOn(path, jar, match), values);
}

const unique = (prefix: string) => `${prefix}-${randomUUID()}@example.invalid`;

/** Signs up through the real form. A `next` is carried in the page's query, as a link would. */
export async function signUp(name: string, next?: string): Promise<Person> {
  const person: Person = { jar: { cookie: '' }, name, email: unique('person') };
  const page = next ? `/sign-up?next=${encodeURIComponent(next)}` : '/sign-up';
  const response = await submit(page, person.jar, /name="password"/, {
    name,
    email: person.email,
    password: PASSWORD,
  });
  if (response.status !== 303 || !person.jar.cookie.includes('session_token')) {
    throw new Error(`Sign-up failed with status ${response.status}`);
  }
  return person;
}

const ORGANIZATION_PATH = /^\/o\/([0-9a-f-]{36})$/;

/** Creates the first organization through the setup form on the home page, and returns its ID. */
export async function createOrganization(person: Person, name: string): Promise<string> {
  const response = await submit('/', person.jar, /Create organization/, { name });
  const id = ORGANIZATION_PATH.exec(response.headers.get('location') ?? '')?.[1];
  if (!id) throw new Error(`Organization not created (status ${response.status})`);
  return id;
}

/** The invitation token in a page. The link only ever arrives in the body of a response. */
export const tokenIn = (html: string) => /\/invite\/([A-Za-z0-9_-]{43})/.exec(html)?.[1];

/**
 * Brings someone new into an organization: invited on the people page, asking on the invitation, and
 * confirmed on the people page, because nothing has proven the address on a new password account.
 */
export async function join(inviter: Person, organization: string, name: string): Promise<Person> {
  const person = await signUp(name);
  const people = `/o/${organization}/people`;
  const invited = await submit(people, inviter.jar, /name="email"/, {
    email: person.email,
    role: 'member',
  });
  const token = tokenIn(await invited.text());
  if (!token) throw new Error(`No invitation link (status ${invited.status})`);
  const asked = await submit(`/invite/${token}`, person.jar, /Accept invitation/);
  if (asked.headers.get('location') !== `/invite/${token}?state=waiting`) {
    throw new Error(`Invitation not taken up (status ${asked.status})`);
  }
  const confirmed = await submit(
    people,
    inviter.jar,
    (form) => form.html.includes(`Confirm ${person.email}`) && form.hidden.has('invitationId'),
    { confirm: 'yes' },
  );
  if (confirmed.headers.get('location') !== people) {
    throw new Error(`Invitation not confirmed (status ${confirmed.status})`);
  }
  return person;
}
