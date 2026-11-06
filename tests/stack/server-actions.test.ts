// FOUND-02, NEXT-01, API-11 groundwork: drives the real Server Actions the way a browser does when
// it submits a form without JavaScript, through the proxy, against built images.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // The proxy uses a local test certificate.

const BASE = 'https://localhost:8443';
const PASSWORD = 'correct horse battery staple';

type Jar = { cookie: string };

function store(jar: Jar, response: Response) {
  const fresh = response.headers.getSetCookie().map((c) => c.split(';')[0] as string);
  const merged = new Map(
    [...jar.cookie.split('; ').filter(Boolean), ...fresh].map((c) => {
      const at = c.indexOf('=');
      return [c.slice(0, at), c.slice(at + 1)] as const;
    }),
  );
  jar.cookie = [...merged].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** The hidden fields Next.js renders for a form's Server Action, in document order, by form. */
async function formFields(path: string, jar: Jar, match: RegExp) {
  const response = await fetch(`${BASE}${path}`, { headers: { cookie: jar.cookie } });
  const html = await response.text();
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
  const form = forms.find((f) => match.test(f));
  if (!form) throw new Error(`No matching form on ${path}`);
  return [...form.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?/g)].map(
    (m) => [m[1] as string, m[2] ?? ''] as const,
  );
}

async function submit(
  path: string,
  jar: Jar,
  match: RegExp,
  values: Record<string, string>,
  origin = BASE,
) {
  const body = new FormData();
  for (const [name, value] of await formFields(path, jar, match)) body.append(name, value);
  for (const [name, value] of Object.entries(values)) body.append(name, value);
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie: jar.cookie, origin },
    body,
    redirect: 'manual',
  });
  store(jar, response);
  return response;
}

const signUp = async (jar: Jar, email = `${randomUUID()}@example.invalid`) =>
  submit('/sign-up', jar, /name="password"/, { name: 'Form User', email, password: PASSWORD });

describe('Server Actions through real forms', () => {
  it('signs up, signs out and signs back in', async () => {
    const jar: Jar = { cookie: '' };
    const email = `${randomUUID()}@example.invalid`;
    const created = await signUp(jar, email);
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/');
    expect(jar.cookie).toContain('session_token');

    const home = await fetch(`${BASE}/`, { headers: { cookie: jar.cookie } });
    expect(await home.text()).toContain(email);

    const out = await submit('/', jar, />Sign out</, {});
    expect(out.headers.get('location')).toBe('/sign-in');

    const again: Jar = { cookie: '' };
    const back = await submit('/sign-in', again, /name="password"/, { email, password: PASSWORD });
    expect(back.headers.get('location')).toBe('/');
    expect(again.cookie).toContain('session_token');
  });

  it('shows a generic error for a wrong password', async () => {
    const jar: Jar = { cookie: '' };
    const response = await submit('/sign-in', jar, /name="password"/, {
      email: `${randomUUID()}@example.invalid`,
      password: 'wrong password here',
    });
    expect(response.headers.get('location')).toBe('/sign-in?error=invalid');
    expect(jar.cookie).not.toContain('session_token');
  });

  it('creates an organization and opens it', async () => {
    const jar: Jar = { cookie: '' };
    await signUp(jar);
    const name = `Org ${randomUUID()}`;
    const response = await submit('/', jar, /Create organization/, { name });
    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toMatch(/^\/o\/[0-9a-f-]{36}$/);
    const page = await fetch(`${BASE}${location}`, { headers: { cookie: jar.cookie } });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain(name);
    expect(html).toMatch(/Hello, (<!-- -->)?Form/);
  });

  it('rejects an empty organization name', async () => {
    const jar: Jar = { cookie: '' };
    await signUp(jar);
    const response = await submit('/', jar, /Create organization/, { name: '   ' });
    expect(response.headers.get('location')).toBe('/?error=name');
  });

  it('refuses the action without a session, even with a valid action ID', async () => {
    const owner: Jar = { cookie: '' };
    await signUp(owner);
    const fields = await formFields('/', owner, /Create organization/);
    const body = new FormData();
    for (const [name, value] of fields) body.append(name, value);
    body.append('name', 'Should not exist');
    const response = await fetch(`${BASE}/`, {
      method: 'POST',
      headers: { origin: BASE },
      body,
      redirect: 'manual',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/sign-in');
  });

  it('refuses a form posted from another site', async () => {
    const jar: Jar = { cookie: '' };
    await signUp(jar);
    const response = await submit(
      '/',
      jar,
      /Create organization/,
      { name: 'Cross-site attempt' },
      'https://evil.example',
    );
    expect(response.status).not.toBe(303);
    const home = await fetch(`${BASE}/`, { headers: { cookie: jar.cookie } });
    expect(await home.text()).not.toContain('Cross-site attempt');
  });
});
