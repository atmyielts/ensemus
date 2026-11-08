// Authored real-role/native-resolver cases. The existing owner fixture is used only to configure
// a generated provider; every linked account/session/password below is created by native HTTP.
// No Account, source-session, email-verification or SSO/MFA assurance is seeded for self-link.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAuth } from '@ensemus/auth';
import { openAppDatabase, memberships, withTenantTx } from '@ensemus/database';
import {
  authorizeSsoIdentity,
  completeSsoSignIn,
  isSsoPrimaryCurrent,
  createSsoConnection,
  updateSsoConnection,
} from '@ensemus/application/sso';
import { inspectSsoProvider, verifySsoDomain } from '@ensemus/database/sso-operator';
import { fixtureCookies } from '../../packages/auth/test-support/mfa-router';
import {
  SAML_BROWSER_COOKIE,
  SAML_SELF_LINK_PREFIX,
} from '../../packages/auth/src/saml-browser-binding';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { generatedSamlIdp } from '../helpers/saml-idp';
import { urls } from '../helpers/stack';
const base = 'https://generated-ensemus.example.invalid',
  password = 'generated self link password with length';
describe('explicit native SAML self-link authority (0421)', () => {
  const app = openAppDatabase(urls.app()),
    authDriver = new pg.Client({ connectionString: urls.auth() });
  const completionRefusals = new Set<string>();
  const runtime = createAuth({
    databaseUrl: urls.auth(),
    secret: 'generated-native-self-link-test-key-never-real',
    baseURL: base,
    allowSignup: true,
    sso: {
      authorizeIdentity: (input) => authorizeSsoIdentity(app.db, input),
      completeIdentity: async (input) =>
        completionRefusals.has(input.userId)
          ? 'refused'
          : (await completeSsoSignIn(app.db, input)).outcome,
      currentPrimary: (input) => isSsoPrimaryCurrent(app.db, input),
    },
  });
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>,
    idp: Awaited<ReturnType<typeof generatedSamlIdp>>;
  beforeAll(async () => {
    await authDriver.connect();
    tenants = await makeTwoTenants(app.db);
    await proveSecondFactor(tenants.a.owner);
    idp = await generatedSamlIdp();
  });
  afterAll(async () => {
    await runtime.close();
    await app.close();
    await authDriver.end();
  });
  const request = (path: string, body: unknown, cookie = '') =>
    runtime.auth.handler(
      new Request(new URL(`/api/auth${path}`, base), {
        method: 'POST',
        headers: {
          origin: base,
          'content-type': 'application/json',
          cookie,
          'x-forwarded-for': `192.0.2.${1 + Math.floor(Math.random() * 200)}`,
        },
        body: JSON.stringify(body),
      }),
    );
  async function fixture(join = true) {
    const domain = `generated-${randomUUID()}.example.invalid`,
      email = `local-${randomUUID()}@${domain}`;
    const signup = await request('/sign-up/email', {
      name: 'Original local person',
      email,
      password,
    });
    expect(signup.status).toBe(200);
    const cookie = fixtureCookies(signup.headers.get('set-cookie')),
      native = await runtime.readInteractiveSession(new Headers({ cookie }));
    if (!native) throw new Error('NATIVE_SOURCE_REQUIRED');
    const owner = tenants.a.owner,
      proof = { sessionId: owner.sessionId };
    let connection = await createSsoConnection(app.db, owner.context, proof, {
      displayName: 'Generated explicit-link provider',
      domain,
    });
    expect(
      await runtime.sso.storeProvider({
        providerId: connection.providerId,
        domain,
        idpMetadataXml: idp.metadata,
      }),
    ).toBe('stored');
    const review = await inspectSsoProvider(urls.migrator(), connection.providerId);
    if (!review) throw new Error('GENERATED_REVIEW_REQUIRED');
    expect(
      await verifySsoDomain(urls.migrator(), {
        providerId: connection.providerId,
        expectedSha256: review.expectedSha256,
      }),
    ).toBe('verified');
    connection = await updateSsoConnection(
      app.db,
      owner.context,
      proof,
      { connectionId: connection.id, expectedVersion: connection.version, state: 'active' },
      { providerReady: async (provider) => (await runtime.sso.status(provider)).ready },
    );
    let membershipId: string | undefined;
    if (join) {
      const [row] = await withTenantTx(app.db, owner.context, (tx) =>
        tx
          .insert(memberships)
          .values({
            organizationId: owner.context.organizationId,
            userId: native.user.id,
            role: 'member',
            status: 'active',
          })
          .returning({ id: memberships.id }),
      );
      membershipId = row?.id;
      if (!membershipId) throw new Error('ACTUAL_MEMBERSHIP_REQUIRED');
    }
    const metadata = await runtime.auth.handler(
      new Request(`${base}/api/auth/sso/saml2/sp/metadata?providerId=${connection.providerId}`),
    );
    expect(metadata.status).toBe(200);
    return { email, cookie, native, connection, membershipId, metadata: await metadata.text() };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function start(f: Fixture) {
    const response = await request(
      '/sso/link-self',
      { password, consent: 'connect', callbackURL: `${base}/sso/complete` },
      f.cookie,
    );
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string },
      purpose = fixtureCookies(response.headers.get('set-cookie'));
    const encoded = purpose
      .split('; ')
      .find((value) => value.startsWith(`${SAML_BROWSER_COOKIE}=`))
      ?.slice(SAML_BROWSER_COOKIE.length + 1);
    if (!encoded) throw new Error('NATIVE_BROWSER_PROOF_REQUIRED');
    const { id } = JSON.parse(Buffer.from(encoded.split('.')[0]!, 'base64url').toString()) as {
      id: string;
    };
    const result = await authDriver.query<{
      id: string;
      identifier: string;
      value: string;
      created_at: Date;
      expires_at: Date;
    }>('select id,identifier,value,created_at,expires_at from identity.verifications where id=$1', [
      id,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('GUARDED_INTENT_REQUIRED');
    expect(row.identifier).toMatch(new RegExp(`^${SAML_SELF_LINK_PREFIX}`));
    expect(JSON.parse(row.value)).toMatchObject({
      mode: 'self_link',
      scopeAdmission: 'v1',
      organizationId: tenants.a.owner.context.organizationId,
      membershipId: f.membershipId,
    });
    return { url, id, row, cookie: `${f.cookie}; ${purpose}` };
  }
  type Attempt = Awaited<ReturnType<typeof start>>;
  async function callback(f: Fixture, attempt: Attempt, cookie = attempt.cookie) {
    const assertion = await idp.response(attempt.url, f.metadata, f.email);
    return runtime.auth.handler(
      new Request(`${base}/api/auth/sso/saml2/sp/acs/${f.connection.providerId}`, {
        method: 'POST',
        headers: {
          origin: new URL(idp.issuer).origin,
          'content-type': 'application/x-www-form-urlencoded',
          cookie,
        },
        body: new URLSearchParams(assertion),
      }),
    );
  }
  async function state(f: Fixture) {
    const result = await authDriver.query<{ count: string }>(
      'select count(*)::text as count from identity.accounts where user_id=$1 and provider_id=$2',
      [f.native.user.id, f.connection.providerId],
    );
    return Number(result.rows[0]?.count);
  }
  it('requires explicit consent, actual local proof, a live native session and confirmed membership before preparation', async () => {
    const f = await fixture();
    for (const [body, cookie] of [
      [{ password, consent: 'continue', callbackURL: `${base}/sso/complete` }, f.cookie],
      [
        { password: 'wrong-password', consent: 'connect', callbackURL: `${base}/sso/complete` },
        f.cookie,
      ],
      [{ password, consent: 'connect', callbackURL: `${base}/sso/complete` }, ''],
      [
        { password, consent: 'connect', callbackURL: `${base}/sso/complete`, userId: randomUUID() },
        f.cookie,
      ],
    ] as const) {
      expect((await request('/sso/link-self', body, cookie)).ok).toBe(false);
    }
    const outsider = await fixture(false);
    expect(
      (
        await request(
          '/sso/link-self',
          { password, consent: 'connect', callbackURL: `${base}/sso/complete` },
          outsider.cookie,
        )
      ).ok,
    ).toBe(false);
    expect(await state(f)).toBe(0);
  });
  it('links the original unverified local person through native Account/session finalization with preserved profile', async () => {
    const f = await fixture(),
      attempt = await start(f),
      response = await callback(f, attempt);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!, base).searchParams.has('error')).toBe(false);
    const current = await runtime.readInteractiveSession(
      new Headers({ cookie: fixtureCookies(response.headers.get('set-cookie')) }),
    );
    expect(current?.user).toMatchObject({
      id: f.native.user.id,
      email: f.email,
      name: 'Original local person',
      emailVerified: false,
    });
    expect(await state(f)).toBe(1);
    const consumed = await authDriver.query<{ value: string }>(
      'select value from identity.verifications where id=$1',
      [attempt.id],
    );
    expect(JSON.parse(consumed.rows[0]!.value)).toMatchObject({
      phase: 'consumed',
      finalizationAdmission: 'v1',
      signedEmail: f.email,
    });
    // A fresh explicit connection of the same exact subject is harmless; it never creates a duplicate.
    const repeated = await callback(f, await start(f));
    expect(new URL(repeated.headers.get('location')!, base).searchParams.has('error')).toBe(false);
    expect(await state(f)).toBe(1);
  });
  it('refuses an ordinary continue for the unverified password account, without changing global link policy', async () => {
    const f = await fixture(),
      response = await request('/sign-in/sso', {
        email: f.email,
        providerType: 'saml',
        callbackURL: `${base}/sso/complete`,
      });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    const assertion = await idp.response(url, f.metadata, f.email);
    const refused = await runtime.auth.handler(
      new Request(`${base}/api/auth/sso/saml2/sp/acs/${f.connection.providerId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: fixtureCookies(response.headers.get('set-cookie')),
        },
        body: new URLSearchParams(assertion),
      }),
    );
    expect(new URL(refused.headers.get('location')!, base).searchParams.get('error')).toBe(
      'account_not_linked',
    );
    expect(await state(f)).toBe(0);
  });
  it.each([
    'missing-browser',
    'other-native-person',
    'revoked-session',
    'disabled-member',
    'changed-config',
    'changed-primary',
  ] as const)('refuses %s after preparation without native account creation', async (kind) => {
    const f = await fixture(),
      attempt = await start(f);
    let cookie = attempt.cookie;
    if (kind === 'missing-browser') cookie = f.cookie;
    if (kind === 'other-native-person') {
      const other = await fixture(),
        otherAttempt = await start(other);
      cookie = otherAttempt.cookie;
    }
    if (kind === 'revoked-session')
      await authDriver.query('delete from identity.sessions where id=$1', [f.native.session.id]);
    if (kind === 'disabled-member')
      await withTenantTx(app.db, tenants.a.owner.context, (tx) =>
        tx
          .update(memberships)
          .set({ status: 'disabled' })
          .where(eq(memberships.id, f.membershipId!)),
      );
    if (kind === 'changed-config')
      await authDriver.query(
        "update identity.sso_providers set saml_config=saml_config||' ' where provider_id=$1",
        [f.connection.providerId],
      );
    if (kind === 'changed-primary')
      await authDriver.query(
        'update identity.accounts set password=$1 where user_id=$2 and provider_id=$3',
        ['generated-invalidated-hash', f.native.user.id, 'credential'],
      );
    const response = await callback(f, attempt, cookie);
    expect(response.status >= 300).toBe(true);
    expect(await state(f)).toBe(0);
  });
  it('rejects forged prepared inserts and caller finalization stamps on the actual auth role', async () => {
    const f = await fixture(),
      attempt = await start(f),
      body = JSON.parse(attempt.row.value);
    for (const alter of [
      () =>
        authDriver.query(
          'insert into identity.verifications(id,identifier,value,created_at,expires_at) values($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            attempt.row.identifier,
            JSON.stringify({ ...body, phase: 'prepared' }),
            attempt.row.created_at,
            attempt.row.expires_at,
          ],
        ),
      () =>
        authDriver.query('update identity.verifications set value=$1 where id=$2', [
          JSON.stringify({
            ...body,
            phase: 'consumed',
            subject: f.email,
            signedEmail: f.email,
            finalizationAdmission: 'v1',
            finalizationTransaction: '1',
          }),
          attempt.id,
        ]),
    ]) {
      await authDriver.query('begin');
      try {
        await expect(alter()).rejects.toMatchObject({ code: 'EN421' });
      } finally {
        await authDriver.query('rollback');
      }
    }
    expect(await state(f)).toBe(0);
  });
  it('keeps the metadata helper private, preserves trigger order and denies runtime trigger replacement', async () => {
    const rights = await authDriver.query<{
      temporary: boolean;
      create_public: boolean;
      trigger: boolean;
      helper: boolean;
      stamp: boolean;
    }>(`select
   has_database_privilege(current_user,current_database(),'TEMP') as temporary,
   has_schema_privilege(current_user,'public','CREATE') as create_public,
   has_table_privilege(current_user,'identity.verifications','TRIGGER') as trigger,
   has_function_privilege(current_user,'identity.lock_saml_self_link_member(text,uuid,text,text)','EXECUTE') as helper,
   has_function_privilege(current_user,'identity.guard_saml_self_link_scope()','EXECUTE') as stamp`);
    expect(rights.rows[0]).toEqual({
      temporary: false,
      create_public: false,
      trigger: false,
      helper: false,
      stamp: false,
    });
    const triggers = await authDriver.query<{ tgname: string }>(
      "select tgname from pg_catalog.pg_trigger where tgrelid='identity.verifications'::regclass and not tgisinternal order by tgname",
    );
    const names = triggers.rows.map((row) => row.tgname);
    expect(names.indexOf('verifications_0421a_self_link_native')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('verifications_0421b_self_link_scope')).toBeGreaterThan(
      names.indexOf('verifications_0421a_self_link_native'),
    );
    for (const command of [
      "select * from identity.lock_saml_self_link_member('generated',$1,'person@example.invalid',null)",
      'alter table identity.verifications disable trigger verifications_0421a_self_link_native',
      'create temporary table forbidden_saml_trigger(value text)',
      'create trigger forbidden_saml_stamp before insert on identity.verifications for each row execute function identity.guard_saml_self_link_scope()',
    ]) {
      await authDriver.query('begin');
      try {
        await expect(
          authDriver.query(command, command.includes('$1') ? [randomUUID()] : undefined),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await authDriver.query('rollback');
      }
    }
  });
  it('denies both prefix transitions and leaves genuinely unrelated verification rows unchanged', async () => {
    const f = await fixture(),
      attempt = await start(f),
      other = randomUUID(),
      identifier = `generated-unrelated:${randomUUID()}`;
    await authDriver.query(
      "insert into identity.verifications(id,identifier,value,expires_at) values($1,$2,$3,now()+interval '1 minute')",
      [other, identifier, 'unrelated-original'],
    );
    await authDriver.query('update identity.verifications set value=$1 where id=$2', [
      'unrelated-changed',
      other,
    ]);
    const unaffected = await authDriver.query<{ value: string }>(
      'select value from identity.verifications where id=$1',
      [other],
    );
    expect(unaffected.rows[0]?.value).toBe('unrelated-changed');
    for (const [id, target] of [
      [attempt.id, identifier],
      [other, attempt.row.identifier],
    ]) {
      await authDriver.query('begin');
      try {
        await expect(
          authDriver.query('update identity.verifications set identifier=$1 where id=$2', [
            target,
            id,
          ]),
        ).rejects.toMatchObject({ code: 'EN421' });
      } finally {
        await authDriver.query('rollback');
      }
    }
  });
  it('denies application/agent metadata and proof mutation, and expired preparations under the actual auth role', async () => {
    const f = await fixture(),
      attempt = await start(f),
      body = JSON.parse(attempt.row.value);
    for (const connectionString of [urls.app(), urls.agent()]) {
      const client = new pg.Client({ connectionString });
      await client.connect();
      try {
        await expect(
          client.query('update identity.verifications set value=$1 where id=$2', [
            attempt.row.value,
            attempt.id,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          client.query(
            "select * from identity.lock_saml_self_link_member('generated',$1,'person@example.invalid',null)",
            [f.native.user.id],
          ),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.end();
      }
    }
    await authDriver.query('begin');
    try {
      // This selector is deliberately not called password proof: it is the trusted native-verifier
      // handoff. SQL still refuses old timestamps even for an otherwise exact captured native tuple.
      await authDriver.query("select set_config('identity.saml_link_preparation',$1,true)", [
        JSON.stringify(body.source),
      ]);
      const {
        organizationId: _organization,
        membershipId: _membership,
        scopeAdmission: _scope,
        ...unprepared
      } = body;
      await expect(
        authDriver.query(
          "insert into identity.verifications(id,identifier,value,created_at,expires_at) values($1,$2,$3,clock_timestamp()-interval '6 minutes',clock_timestamp()-interval '1 minute')",
          [randomUUID(), attempt.row.identifier, JSON.stringify(unprepared)],
        ),
      ).rejects.toMatchObject({ code: 'EN421' });
    } finally {
      await authDriver.query('rollback');
    }
    expect(await state(f)).toBe(0);
  });
  it('keeps preparation unconsumed when native exact-account ownership collides', async () => {
    const f = await fixture(),
      first = await start(f);
    // A real fault after native finalization leaves a native account but no tenant link/session.
    // This reaches the SDK ownership collision instead of the earlier tenant-link collision guard.
    completionRefusals.add(f.native.user.id);
    await callback(f, first);
    completionRefusals.delete(f.native.user.id);
    expect(await state(f)).toBe(1);
    // The collision is reachable through actual native account ownership, not an Account seed:
    // another native person prepares under their own email, then the IdP asserts the first subject.
    const otherSignup = await request('/sign-up/email', {
      name: 'Other local person',
      email: `other-${randomUUID()}@${f.connection.domain}`,
      password,
    });
    expect(otherSignup.status).toBe(200);
    const cookie = fixtureCookies(otherSignup.headers.get('set-cookie')),
      native = await runtime.readInteractiveSession(new Headers({ cookie }));
    if (!native) throw new Error('NATIVE_OTHER_REQUIRED');
    const [m] = await withTenantTx(app.db, tenants.a.owner.context, (tx) =>
      tx
        .insert(memberships)
        .values({
          organizationId: tenants.a.owner.context.organizationId,
          userId: native.user.id,
          role: 'member',
          status: 'active',
        })
        .returning({ id: memberships.id }),
    );
    if (!m) throw new Error('MEMBERSHIP_REQUIRED');
    const other = { ...f, email: native.user.email, cookie, native, membershipId: m.id },
      attempt = await start(other),
      assertion = await idp.response(attempt.url, f.metadata, other.email, { subject: f.email });
    const response = await runtime.auth.handler(
      new Request(`${base}/api/auth/sso/saml2/sp/acs/${f.connection.providerId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: attempt.cookie },
        body: new URLSearchParams(assertion),
      }),
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!, base).searchParams.get('error')).toBe(
      'account_ownership_conflict',
    );
    expect(await state(other)).toBe(0);
    const check = await authDriver.query<{ value: string }>(
      'select value from identity.verifications where id=$1',
      [attempt.id],
    );
    expect(JSON.parse(check.rows[0]!.value).phase).toBe('prepared');
  });
});
