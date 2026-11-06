// Actual pinned OIDC code exchange/PKCE/JWKS signatures and real auth-role rows. No Docker service,
// hosted identity, test proof minting or unverified userinfo authentication time stands in for these.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createAuth } from '@ensemus/auth';
import { fixtureCookies } from '../../packages/auth/test-support/mfa-router';
import { generatedOidcIdp, type OidcScript } from '../helpers/oidc-idp';
import { totpFromUri } from '../helpers/totp';
import { urls } from '../helpers/stack';
const baseURL = 'http://127.0.0.1:3996',
  secret = `generated-oidc-primary-${randomUUID()}-${randomUUID()}`,
  providerId = `generated-operator-${randomUUID()}`;
describe('signed operator OIDC primary authentication receipts', () => {
  let idp: Awaited<ReturnType<typeof generatedOidcIdp>>, runtime: ReturnType<typeof createAuth>;
  const auth = new pg.Client({ connectionString: urls.auth() });
  let address = 0;
  const headers = (cookie = '') =>
    new Headers({
      cookie,
      'x-forwarded-for': `192.0.${Math.floor(++address / 250)}.${(address % 250) + 1}`,
      'user-agent': 'Generated OIDC primary conformance',
    });
  beforeAll(async () => {
    await auth.connect();
    idp = await generatedOidcIdp();
    runtime = createAuth({
      databaseUrl: urls.auth(),
      baseURL,
      secret,
      allowSignup: true,
      oidc: {
        providerId,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        discoveryUrl: idp.discoveryUrl,
      },
    });
  });
  afterAll(async () => {
    await runtime?.close();
    await idp?.close();
    await auth.end();
  });
  async function begin() {
    const start = await runtime.auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: {
          ...Object.fromEntries(headers()),
          origin: baseURL,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ provider: providerId, callbackURL: '/' }),
      }),
    );
    expect(start.status).toBe(200);
    const body = (await start.json()) as { url: string };
    expect(new URL(body.url).searchParams.get('code_challenge')).toBeTruthy();
    expect(new URL(body.url).searchParams.get('nonce')).toBeTruthy();
    return { url: body.url, cookie: fixtureCookies(start.headers.get('set-cookie')) };
  }
  async function login(script: OidcScript = {}) {
    const start = await begin(),
      authorization = idp.authorize(start.url, script),
      response = await runtime.auth.handler(
        new Request(authorization.callback, { headers: headers(start.cookie) }),
      ),
      currentHeaders = headers(fixtureCookies(response.headers.get('set-cookie'))),
      session = await runtime.auth.api.getSession({ headers: currentHeaders });
    return {
      start,
      authorization,
      response,
      headers: currentHeaders,
      session,
      identity: session ? { sessionId: session.session.id, userId: session.user.id } : null,
    };
  }
  async function requireSession(script: OidcScript = {}) {
    const result = await login(script);
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get('location')).not.toContain('error');
    expect(result.session).not.toBeNull();
    return { ...result, identity: result.identity! };
  }
  async function receipts(userId: string) {
    const accounts = (
        await auth.query('select id from identity.accounts where user_id=$1 and provider_id=$2', [
          userId,
          providerId,
        ])
      ).rows.map((row) => row.id as string),
      rows = (
        await auth.query(
          'select identifier,value from identity.verifications where value like $1',
          ['oidc:%'],
        )
      ).rows;
    return rows.filter((row) => {
      try {
        return accounts.includes(JSON.parse(row.value.slice(5)).accountId);
      } catch {
        return false;
      }
    });
  }
  async function enrolled() {
    const subject = randomUUID(),
      email = `generated-enrolled-${randomUUID()}@example.invalid`,
      value = await requireSession({ subject, email }),
      setup = await runtime.mfa.enable({ password: '' }, value.identity, value.headers);
    expect(setup.outcome).toBe('verified');
    expect(
      (
        await runtime.mfa.confirmEnrollment(
          { code: totpFromUri(setup.totpURI!, Date.now() - 30000) },
          value.identity,
          value.headers,
        )
      ).outcome,
    ).toBe('verified');
    return { subject, email, userId: value.identity.userId, uri: setup.totpURI! };
  }
  async function challenge(person: Awaited<ReturnType<typeof enrolled>>) {
    const value = await login({ subject: person.subject, email: person.email });
    expect(value.session).toBeNull();
    expect(value.response.status).toBe(302);
    expect(value.response.headers.get('location')).toContain('/sign-in/two-factor?');
    expect(value.headers.get('cookie')).toMatch(/better-auth\.two_factor=2fa-idp-[0-9a-f]{32}\./);
    const rows = (
      await auth.query(
        'select id,value from identity.verifications where identifier like $1 and value like $2',
        ['ensemus-idp-factor:v1:%', `%${person.userId}%`],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const protectedValue = JSON.parse(rows[0].value);
    expect(protectedValue).toMatchObject({ userId: person.userId, providerId, kind: 'oidc' });
    expect(rows[0].value).not.toContain(person.subject);
    expect(rows[0].value).not.toContain(person.email);
    expect(rows[0].value).not.toContain(idp.issuedToken(value.authorization.code));
    return { ...value, bridgeId: rows[0].id as string, protectedValue };
  }
  async function noMfaForChallenge(userId: string, sourceSessionId: string) {
    expect(
      (await auth.query('select id from identity.sessions where id=$1', [sourceSessionId])).rows,
    ).toHaveLength(0);
    expect(
      (
        await auth.query(
          'select session_id from identity.session_assurances where user_id=$1 and session_id=$2',
          [userId, sourceSessionId],
        )
      ).rows,
    ).toHaveLength(0);
  }
  it('requires the actual native local factor after a verified enrolled OIDC callback and consumes its opaque source bridge once across replicas', async () => {
    const person = await enrolled(),
      pending = await challenge(person);
    await noMfaForChallenge(person.userId, pending.protectedValue.sourceSessionId);
    const replica = createAuth({
      databaseUrl: urls.auth(),
      baseURL,
      secret,
      allowSignup: true,
      oidc: {
        providerId,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        discoveryUrl: idp.discoveryUrl,
      },
    });
    try {
      const code = totpFromUri(person.uri),
        done = await replica.mfa.completeSignIn({ kind: 'totp', code }, pending.headers);
      expect(done.outcome).toBe('verified');
      const session = await replica.auth.api.getSession({
        headers: headers(fixtureCookies(done.setCookie)),
      });
      expect(session?.user.id).toBe(person.userId);
      expect(session?.session.id).not.toBe(pending.protectedValue.sourceSessionId);
      expect(
        (await auth.query('select id from identity.verifications where id=$1', [pending.bridgeId]))
          .rows,
      ).toHaveLength(0);
      expect(
        (
          await auth.query('select kind from identity.session_assurances where session_id=$1', [
            session!.session.id,
          ])
        ).rows.map((row) => row.kind),
      ).toContain('mfa_totp');
      expect(
        (await receipts(person.userId)).some(
          (row) =>
            JSON.parse(row.value.slice(5)).tokenSha256 === pending.protectedValue.payloadSha256,
        ),
      ).toBe(true);
      expect(
        (await replica.mfa.completeSignIn({ kind: 'totp', code }, pending.headers)).outcome,
      ).toBe('refused');
    } finally {
      await replica.close();
    }
  });
  it('preserves the native challenge counter after a wrong code and never creates a full session until the correct factor succeeds', async () => {
    const person = await enrolled(),
      pending = await challenge(person),
      correct = totpFromUri(person.uri),
      wrong = `${(Number(correct[0]) + 1) % 10}${correct.slice(1)}`;
    const refused = await runtime.mfa.completeSignIn(
      { kind: 'totp', code: wrong },
      pending.headers,
    );
    expect(refused).toMatchObject({ outcome: 'refused', setCookie: null });
    expect(
      (
        await auth.query(
          'select value from identity.verifications where identifier like $1 and identifier like $2',
          [
            '2fa-attempts-2fa-idp-%',
            `%${pending.headers.get('cookie')!.match(/2fa-idp-([0-9a-f]{32})/)![1]}%`,
          ],
        )
      ).rows,
    ).toEqual([{ value: '1' }]);
    expect(
      (await runtime.mfa.completeSignIn({ kind: 'totp', code: correct }, pending.headers)).outcome,
    ).toBe('verified');
  });
  it.each([
    'missing-bridge',
    'expired-bridge',
    'expired-native-challenge',
    'unlinked-account',
    'other-account',
  ] as const)(
    'withholds cookie and assurance after factor completion when its provider handoff is %s',
    async (mode) => {
      const person = await enrolled(),
        pending = await challenge(person);
      let uri = person.uri;
      if (mode === 'missing-bridge')
        await auth.query('delete from identity.verifications where id=$1', [pending.bridgeId]);
      if (mode === 'expired-bridge')
        await auth.query(
          "update identity.verifications set expires_at=now()-interval '1 second' where id=$1",
          [pending.bridgeId],
        );
      if (mode === 'expired-native-challenge')
        await auth.query(
          "update identity.verifications set expires_at=now()-interval '1 second' where identifier like $1 and value=$2",
          ['2fa-idp-%', person.userId],
        );
      if (mode === 'unlinked-account')
        await auth.query('delete from identity.accounts where user_id=$1 and provider_id=$2', [
          person.userId,
          providerId,
        ]);
      if (mode === 'other-account') {
        const other = await enrolled();
        uri = other.uri;
        await auth.query(
          'update identity.verifications set value=$1 where identifier like $2 and value=$3',
          [other.userId, '2fa-idp-%', person.userId],
        );
      }
      const before = (
          await auth.query('select session_id from identity.session_assurances where user_id=$1', [
            person.userId,
          ])
        ).rows,
        done = await runtime.mfa.completeSignIn(
          { kind: 'totp', code: totpFromUri(uri) },
          pending.headers,
        );
      expect(done.setCookie).toBeNull();
      expect(done.outcome).not.toBe('verified');
      expect(
        (
          await auth.query('select session_id from identity.session_assurances where user_id=$1', [
            person.userId,
          ])
        ).rows,
      ).toEqual(before);
    },
  );
  it('withholds a factor-completed cookie after the configured operator trust changes, without minting a replacement primary receipt', async () => {
    const person = await enrolled(),
      pending = await challenge(person),
      other = await generatedOidcIdp(),
      changed = createAuth({
        databaseUrl: urls.auth(),
        baseURL,
        secret,
        allowSignup: true,
        oidc: {
          providerId,
          clientId: other.clientId,
          clientSecret: other.clientSecret,
          discoveryUrl: other.discoveryUrl,
        },
      }),
      before = await receipts(person.userId);
    try {
      const done = await changed.mfa.completeSignIn(
        { kind: 'totp', code: totpFromUri(person.uri) },
        pending.headers,
      );
      expect(done).toMatchObject({ outcome: 'primary_required', setCookie: null });
      expect(await receipts(person.userId)).toEqual(before);
    } finally {
      await changed.close();
      await other.close();
    }
  });
  it('completes real code/PKCE/nonce/JWKS verification, binds only opaque receipt data and confirms passwordless enrollment after actual rotation', async () => {
    const value = await requireSession(),
      rows = await receipts(value.identity.userId);
    expect(rows).toHaveLength(1);
    const marker = JSON.parse(rows[0].value.slice(5));
    expect(marker).toMatchObject({
      providerId,
      issuer: idp.issuer,
      tokenSha256: createHash('sha256')
        .update(idp.issuedToken(value.authorization.code)!)
        .digest('hex'),
    });
    expect(marker.authenticatedAt).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(rows)).not.toContain(idp.issuedToken(value.authorization.code));
    expect(JSON.stringify(rows)).not.toContain(value.authorization.subject);
    expect(JSON.stringify(rows)).not.toContain(value.authorization.email);
    expect(JSON.stringify(rows)).not.toContain(idp.clientSecret);
    const setup = await runtime.mfa.enable({ password: '' }, value.identity, value.headers);
    expect(setup.outcome).toBe('verified');
    const confirmed = await runtime.mfa.confirmEnrollment(
      { code: totpFromUri(setup.totpURI!, Date.now() - 30000) },
      value.identity,
      value.headers,
    );
    expect(confirmed.outcome).toBe('verified');
    const current = await runtime.auth.api.getSession({
      headers: headers(fixtureCookies(confirmed.setCookie)),
    });
    expect(current?.session.id).not.toBe(value.identity.sessionId);
  });
  it.each([
    { label: 'old', authTime: () => Math.floor(Date.now() / 1000) - 7200 },
    { label: 'missing', authTime: () => null },
    { label: 'future', authTime: () => Math.floor(Date.now() / 1000) + 120 },
    { label: 'within-skew future', authTime: () => Math.floor(Date.now() / 1000) + 30 },
    { label: 'fractional', authTime: () => 1.5 },
  ] as const)(
    'keeps ordinary verified login but refuses passwordless bootstrap for $label signed auth_time',
    async ({ authTime }) => {
      const value = await requireSession({ authTime: authTime() });
      expect(
        (
          await runtime.mfa.enable(
            { password: '', maxAgeSeconds: 900 },
            value.identity,
            value.headers,
          )
        ).outcome,
      ).toBe('primary_required');
    },
  );
  it('ignores fresh userinfo auth_time when the exact signed ID token says authentication was old', async () => {
    const value = await requireSession({
      omitEmail: true,
      authTime: Math.floor(Date.now() / 1000) - 7200,
      userinfoAuthTime: Math.floor(Date.now() / 1000),
    });
    expect(idp.requests.some((request) => request.path === '/userinfo')).toBe(true);
    expect(
      (await runtime.mfa.enable({ password: '' }, value.identity, value.headers)).outcome,
    ).toBe('primary_required');
  });
  it.each([
    'wrongKey',
    'wrongIssuer',
    'wrongAudience',
    'wrongNonce',
    'missingNonce',
    'expired',
    'profileSubject',
  ] as const)(
    'never mints primary authority for rejected native verification or signed/profile mismatch: %s',
    async (kind) => {
      const script: OidcScript = {
        ...(kind === 'wrongKey' ? { wrongKey: true } : {}),
        ...(kind === 'wrongIssuer' ? { issuer: 'https://wrong-issuer.invalid' } : {}),
        ...(kind === 'wrongAudience' ? { audience: 'wrong-client' } : {}),
        ...(kind === 'wrongNonce' ? { nonce: 'wrong-nonce' } : {}),
        ...(kind === 'missingNonce' ? { nonce: null } : {}),
        ...(kind === 'expired' ? { expired: true } : {}),
        ...(kind === 'profileSubject'
          ? { omitEmail: true, profileSubject: 'different-subject' }
          : {}),
      };
      const value = await login(script);
      expect(value.session).toBeNull();
      expect(value.response.headers.get('set-cookie') ?? '').not.toContain('session_token=');
      expect(
        (
          await auth.query(
            'select id from identity.accounts where provider_id=$1 and account_id=$2',
            [providerId, value.authorization.subject],
          )
        ).rows,
      ).toHaveLength(0);
    },
  );
  it('does not turn a userinfo-only/missing-ID-token fallback into signed primary authority', async () => {
    const value = await login({
      omitIdToken: true,
      userinfoAuthTime: Math.floor(Date.now() / 1000),
    });
    if (value.identity) {
      expect(
        (await runtime.mfa.enable({ password: '' }, value.identity, value.headers)).outcome,
      ).toBe('primary_required');
      expect(await receipts(value.identity.userId)).toHaveLength(0);
    }
    const subjectHash = createHash('sha256')
      .update(JSON.stringify([providerId, idp.issuer, value.authorization.subject]))
      .digest('hex');
    expect(
      (
        await auth.query('select value from identity.verifications where value like $1', ['oidc:%'])
      ).rows.every((row) => !row.value.includes(subjectHash)),
    ).toBe(true);
  });
  it('does not refresh old signed authentication time by completing another young callback/session', async () => {
    const subject = randomUUID(),
      email = `generated-repeat-${randomUUID()}@example.invalid`,
      authTime = Math.floor(Date.now() / 1000) - 7200,
      first = await requireSession({ subject, email, authTime }),
      second = await requireSession({ subject, email, authTime });
    expect(second.identity.userId).toBe(first.identity.userId);
    expect(second.identity.sessionId).not.toBe(first.identity.sessionId);
    expect(
      (await runtime.mfa.enable({ password: '' }, second.identity, second.headers)).outcome,
    ).toBe('primary_required');
    expect(
      (await receipts(first.identity.userId)).every(
        (row) => JSON.parse(row.value.slice(5)).authenticatedAt === authTime * 1000,
      ),
    ).toBe(true);
  });
  it('refuses expired, signed-out, mismatched and unlinked account/session authority', async () => {
    const first = await requireSession(),
      other = await requireSession();
    expect(
      (
        await runtime.mfa.enable(
          { password: '' },
          { userId: first.identity.userId, sessionId: other.identity.sessionId },
          other.headers,
        )
      ).outcome,
    ).toBe('primary_required');
    await auth.query('delete from identity.accounts where user_id=$1 and provider_id=$2', [
      first.identity.userId,
      providerId,
    ]);
    expect(
      (await runtime.mfa.enable({ password: '' }, first.identity, first.headers)).outcome,
    ).toBe('primary_required');
    await auth.query(
      "update identity.sessions set expires_at=now()-interval '1 second' where id=$1",
      [other.identity.sessionId],
    );
    expect(
      (await runtime.mfa.enable({ password: '' }, other.identity, other.headers)).outcome,
    ).toBe('primary_required');
    const third = await requireSession();
    await auth.query('delete from identity.sessions where id=$1', [third.identity.sessionId]);
    expect(
      (await runtime.mfa.enable({ password: '' }, third.identity, third.headers)).outcome,
    ).toBe('primary_required');
  });
  it('accepts the same exact source on another replica but refuses removed or changed operator provider trust', async () => {
    const value = await requireSession(),
      same = createAuth({
        databaseUrl: urls.auth(),
        baseURL,
        secret,
        allowSignup: true,
        oidc: {
          providerId,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
          discoveryUrl: idp.discoveryUrl,
        },
      }),
      replacement = await generatedOidcIdp(),
      changed = createAuth({
        databaseUrl: urls.auth(),
        baseURL,
        secret,
        allowSignup: true,
        oidc: {
          providerId,
          clientId: replacement.clientId,
          clientSecret: replacement.clientSecret,
          discoveryUrl: replacement.discoveryUrl,
        },
      }),
      removed = createAuth({ databaseUrl: urls.auth(), baseURL, secret, allowSignup: true });
    try {
      expect(
        (await changed.mfa.enable({ password: '' }, value.identity, value.headers)).outcome,
      ).toBe('primary_required');
      expect(
        (await removed.mfa.enable({ password: '' }, value.identity, value.headers)).outcome,
      ).toBe('primary_required');
      expect((await same.mfa.enable({ password: '' }, value.identity, value.headers)).outcome).toBe(
        'verified',
      );
    } finally {
      await same.close();
      await changed.close();
      await removed.close();
      await replacement.close();
    }
  });
  it('does not mix exact signed subjects or tokens across concurrent callback requests', async () => {
    const values = await Promise.all(Array.from({ length: 4 }, () => requireSession()));
    for (const value of values) {
      const rows = await receipts(value.identity.userId);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].value.slice(5)).tokenSha256).toBe(
        createHash('sha256').update(idp.issuedToken(value.authorization.code)!).digest('hex'),
      );
      expect(
        (await runtime.mfa.enable({ password: '' }, value.identity, value.headers)).outcome,
      ).toBe('verified');
    }
  });
});
