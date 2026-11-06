// ID-03, FOUND-02: authentication through the real auth role, including a real OIDC round trip.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth } from '@ensemus/auth';
import { createOrganization, listMyOrganizations, openAppDatabase } from '@ensemus/database';
import { issueSetupToken } from '@ensemus/database/setup-token';
import { compose, urls } from '../helpers/stack';

const PASSWORD = 'correct horse battery staple';
const baseURL = 'http://127.0.0.1:3999';
const waitFor = async (url: string) => {
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(url)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
};
const email = () => `${randomUUID()}@example.invalid`;

describe('authentication', () => {
  const secret = 'test-only-secret-'.padEnd(40, 'x');
  let open: ReturnType<typeof createAuth>;
  let closed: ReturnType<typeof createAuth>;
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;

  beforeAll(async () => {
    open = createAuth({ databaseUrl: urls.auth(), secret, baseURL, allowSignup: true });
    closed = createAuth({ databaseUrl: urls.auth(), secret, baseURL, allowSignup: false });
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
  });

  afterAll(async () => {
    await open?.close();
    await closed?.close();
    await app?.close();
    await auth?.end();
  });

  const signUp = (address: string) =>
    open.auth.api.signUpEmail({ body: { name: 'Test User', email: address, password: PASSWORD } });

  it('signs up with a UUID identity and stores only a password hash', async () => {
    const address = email();
    const { user } = await signUp(address);
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    const { rows } = await auth.query('select password from identity.accounts where user_id = $1', [
      user.id,
    ]);
    expect(rows[0].password).toBeTruthy();
    expect(rows[0].password).not.toContain(PASSWORD);
  });

  it('signs in with the right password only', async () => {
    const address = email();
    await signUp(address);
    const ok = await open.auth.api.signInEmail({ body: { email: address, password: PASSWORD } });
    expect(ok.token).toBeTruthy();
    await expect(
      open.auth.api.signInEmail({ body: { email: address, password: 'wrong password here' } }),
    ).rejects.toThrow();
  });

  it('gives the same answer for an unknown account and a wrong password', async () => {
    const known = email();
    await signUp(known);
    const failure = (address: string) =>
      open.auth.api
        .signInEmail({ body: { email: address, password: 'wrong password here' } })
        .catch((e: { status: unknown; message: string }) => [e.status, e.message]);
    expect(await failure(known)).toEqual(await failure(email()));
  });

  it('rejects short passwords', async () => {
    await expect(
      open.auth.api.signUpEmail({ body: { name: 'x', email: email(), password: 'short' } }),
    ).rejects.toThrow();
  });

  it('blocks sign-up when it is turned off', async () => {
    await expect(
      closed.auth.api.signUpEmail({ body: { name: 'x', email: email(), password: PASSWORD } }),
    ).rejects.toThrow();
  });

  it('resolves a session from a cookie, and rejects a forged one', async () => {
    const address = email();
    await signUp(address);
    const { headers } = await open.auth.api.signInEmail({
      body: { email: address, password: PASSWORD },
      returnHeaders: true,
    });
    const cookie = headers.get('set-cookie')?.split(';')[0] ?? '';
    const session = await open.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.email).toBe(address);
    const forged = await open.auth.api.getSession({
      headers: new Headers({ cookie: 'better-auth.session_token=forged.value' }),
    });
    expect(forged).toBeNull();
  });

  it('rate-limits repeated sign-in attempts per client', async () => {
    const address = email();
    await signUp(address);
    const attempt = () =>
      open.auth.handler(
        new Request(`${baseURL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: baseURL,
            'x-forwarded-for': '203.0.113.77',
          },
          body: JSON.stringify({ email: address, password: 'wrong password here' }),
        }),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);
    expect(statuses).toContain(429);
  });

  describe('the sign-in and sign-up forms', () => {
    const fromClient = () =>
      new Headers({
        'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
        // Whatever a form's request carries beyond this, the limit counts the same.
        'next-action': 'abc',
        'content-type': 'multipart/form-data; boundary=x',
        cookie: 'something=else',
      });
    const signInForm = (address: string, password: string) =>
      ({ path: '/sign-in/email', body: { email: address, password } }) as const;

    it('signs in and hands back a session, or refuses, as the route would', async () => {
      const address = email();
      await signUp(address);
      const client = fromClient();
      const wrong = await open.submitCredentials(
        signInForm(address, 'wrong password here'),
        client,
      );
      expect(wrong).toEqual({ outcome: 'refused', status: 401, setCookie: null });
      const right = await open.submitCredentials(signInForm(address, PASSWORD), client);
      expect(right.outcome).toBe('accepted');
      const cookie = right.setCookie?.split(';')[0] as string;
      const session = await open.auth.api.getSession({ headers: new Headers({ cookie }) });
      expect(session?.user.email).toBe(address);
    });

    it('refuses the attempt past the limit, even with the right password', async () => {
      const address = email();
      await signUp(address);
      const client = fromClient();
      for (let i = 0; i < 10; i++) {
        const { outcome } = await open.submitCredentials(
          signInForm(address, 'wrong password here'),
          client,
        );
        expect(outcome).toBe('refused');
      }
      expect(await open.submitCredentials(signInForm(address, PASSWORD), client)).toEqual({
        outcome: 'rate_limited',
        status: 429,
        setCookie: null,
      });
    });

    it('shares its count with the route, so neither is a way around the other', async () => {
      const address = email();
      await signUp(address);
      const client = fromClient();
      const route = () =>
        open.auth.handler(
          new Request(`${baseURL}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: baseURL,
              'x-forwarded-for': client.get('x-forwarded-for') as string,
            },
            body: JSON.stringify({ email: address, password: 'wrong password here' }),
          }),
        );
      for (let i = 0; i < 10; i++) expect((await route()).status).toBe(401);
      const { outcome } = await open.submitCredentials(signInForm(address, PASSWORD), client);
      expect(outcome).toBe('rate_limited');
    });

    it('limits sign-up too, and counts each client on its own', async () => {
      const client = fromClient();
      const form = () =>
        ({
          path: '/sign-up/email',
          body: { name: 'Test User', email: email(), password: PASSWORD },
        }) as const;
      for (let i = 0; i < 5; i++) {
        expect((await open.submitCredentials(form(), client)).outcome).toBe('accepted');
      }
      expect((await open.submitCredentials(form(), client)).outcome).toBe('rate_limited');
      const elsewhere = new Headers({ 'x-forwarded-for': '192.0.2.200' });
      expect((await open.submitCredentials(form(), elsewhere)).outcome).toBe('accepted');
    });

    it('stays as closed as the route when sign-up is off', async () => {
      const { outcome } = await closed.submitCredentials(
        {
          path: '/sign-up/email',
          body: { name: 'Test User', email: email(), password: PASSWORD },
        },
        fromClient(),
      );
      expect(outcome).toBe('refused');
    });
  });

  it('connects a new identity to organizations without crossing roles', async () => {
    const { user } = await signUp(email());
    const org = await createOrganization(app.db, {
      userId: user.id,
      name: 'Acme',
      commercialMode: 'sovereign',
    });
    const mine = await listMyOrganizations(app.db, user.id);
    expect(mine).toEqual([{ id: org.organizationId, name: 'Acme', role: 'owner' }]);
  });
});

describe('setup codes, where sign-up is off (ID-01)', () => {
  const secret = 'test-only-secret-'.padEnd(40, 'z');
  let closed: ReturnType<typeof createAuth>;
  let auth: pg.Client;
  let appRole: pg.Client;
  let su: pg.Client;

  const redeem = (token: string, address: string, password = PASSWORD) =>
    closed.redeemSetupToken(
      { token, name: 'First Owner', email: address, password },
      new Headers(),
    );
  const accounts = async (address: string) => {
    const { rows } = await su.query(
      'select count(*)::int as n from identity.users where email = $1',
      [address],
    );
    return rows[0].n as number;
  };

  beforeAll(async () => {
    closed = createAuth({ databaseUrl: urls.auth(), secret, baseURL, allowSignup: false });
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    appRole = new pg.Client({ connectionString: urls.app() });
    await appRole.connect();
    su = new pg.Client({ connectionString: urls.superuser() });
    await su.connect();
  });

  afterAll(async () => {
    await closed?.close();
    await auth?.end();
    await appRole?.end();
    await su?.end();
  });

  it('makes one working account, and leaves sign-up closed for everyone else', async () => {
    const { token } = await issueSetupToken(urls.migrator());
    const address = email();
    expect(await redeem(token, address)).toBe('created');
    const signedIn = await closed.auth.api.signInEmail({
      body: { email: address, password: PASSWORD },
    });
    expect(signedIn.token).toBeTruthy();
    await expect(
      closed.auth.api.signUpEmail({ body: { name: 'x', email: email(), password: PASSWORD } }),
    ).rejects.toThrow();
    const open = await closed.auth.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({ name: 'x', email: email(), password: PASSWORD }),
      }),
    );
    expect(open.ok).toBe(false);
  });

  it('works once', async () => {
    const { token } = await issueSetupToken(urls.migrator());
    expect(await redeem(token, email())).toBe('created');
    const second = email();
    expect(await redeem(token, second)).toBe('invalid_token');
    expect(await accounts(second)).toBe(0);
  });

  it('lets only one of two people sending it at once through', async () => {
    const { token } = await issueSetupToken(urls.migrator());
    const outcomes = await Promise.all([redeem(token, email()), redeem(token, email())]);
    expect(outcomes.sort()).toEqual(['created', 'invalid_token']);
  });

  it('refuses a code that ran out, and one that was never issued', async () => {
    const issued = await issueSetupToken(urls.migrator(), new Date(Date.now() - 25 * 3_600_000));
    const address = email();
    expect(await redeem(issued.token, address)).toBe('invalid_token');
    expect(await redeem('not-a-code-anyone-issued', address)).toBe('invalid_token');
    expect(await accounts(address)).toBe(0);
  });

  it('keeps the code usable when the account could not be made', async () => {
    const { token } = await issueSetupToken(urls.migrator());
    const taken = email();
    expect(await redeem(token, taken, 'short')).toBe('invalid_details');
    expect(await accounts(taken)).toBe(0);
    expect(await redeem(token, taken)).toBe('created');

    const again = await issueSetupToken(urls.migrator());
    expect(await redeem(again.token, taken)).toBe('invalid_details');
    expect(await accounts(taken)).toBe(1);
    expect(await redeem(again.token, email())).toBe('created');
  });

  it('stores only a hash, valid for a day, out of the application role’s reach', async () => {
    const before = Date.now();
    const { token, expiresAt } = await issueSetupToken(urls.migrator());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(24 * 3_600_000 + 5_000);
    const { rows } = await su.query('select * from identity.setup_tokens');
    expect(JSON.stringify(rows)).not.toContain(token);

    await expect(appRole.query('select * from identity.setup_tokens')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      auth.query(`insert into identity.setup_tokens (token_hash, expires_at)
                  values ('forged', now() + interval '1 day')`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      auth.query(`update identity.setup_tokens set expires_at = now() + interval '1 year'`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('OIDC sign-in', () => {
  let oidc: ReturnType<typeof createAuth>;
  const issuer = 'http://127.0.0.1:58080/default';

  beforeAll(async () => {
    compose('--profile', 'test-oidc', 'up', '-d', 'oidc-mock');
    await waitFor(`${issuer}/.well-known/openid-configuration`);
    oidc = createAuth({
      databaseUrl: urls.auth(),
      secret: 'test-only-secret-'.padEnd(40, 'y'),
      baseURL,
      allowSignup: true,
      oidc: {
        providerId: 'company-sso',
        clientId: 'ensemus',
        clientSecret: 'test-only-client-secret',
        discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      },
    });
  });

  afterAll(async () => {
    await oidc?.close();
    compose('--profile', 'test-oidc', 'rm', '-f', '-s', 'oidc-mock');
  });

  it('completes a full authorization-code round trip with PKCE', async () => {
    const start = await oidc.auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({ provider: 'company-sso', callbackURL: '/' }),
      }),
    );
    expect(start.status, await start.clone().text()).toBe(200);
    const { url } = (await start.json()) as { url: string };
    expect(url).toContain('code_challenge=');
    const stateCookies = start.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');

    const idp = await fetch(url, { redirect: 'manual' });
    const callback = idp.headers.get('location');
    expect(callback, `${idp.status} ${url} ${await idp.clone().text()}`).toBeTruthy();
    expect(callback).toContain('/api/auth/');
    expect(callback).toContain('company-sso');

    const done = await oidc.auth.handler(
      new Request(callback as string, { headers: { cookie: stateCookies } }),
    );
    expect(done.status).toBe(302);
    expect(done.headers.get('location') ?? '').not.toContain('/error');
    const cookie = done.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const session = await oidc.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
