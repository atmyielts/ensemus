// Real restricted roles + real pinned SAML parser/signatures. Authored, not executed until joined PG.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { createAuth } from '@ensemus/auth';
import { parseSamlMetadata } from '@ensemus/auth/sso';
import {
  createSsoConnection,
  listSsoConnections,
  updateSsoConnection,
  prepareSsoMetadata,
  issueScimToken,
  revokeScimToken,
  authorizeSsoIdentity,
  completeSsoSignIn,
  isSsoPrimaryCurrent,
  scimListUsers,
  scimGetUser,
  scimDeprovisionUser,
  scimReactivateUser,
  assertTenantSignIn,
} from '@ensemus/application/sso';
import { getSecurityPolicy, updateSecurityPolicy } from '@ensemus/application/security-policy';
import { createTeam } from '@ensemus/application';
import { assertInteractivePrivilege, withPrivilegeTx } from '@ensemus/application/privileged';
import {
  memberships,
  openAppDatabase,
  resolveTenantContext,
  resolveInteractiveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { inspectSsoProvider, verifySsoDomain } from '@ensemus/database/sso-operator';
import { createPrimaryAuthentication } from '../../packages/auth/src/mfa-primary';
import { openAuthDatabase } from '@ensemus/database/auth';
import { fixtureCookies, privateFactorRouter } from '../../packages/auth/test-support/mfa-router';
import { createMfaOperations, MFA_ACCOUNT_LOCKOUT } from '../../packages/auth/src/mfa';
import { createMfaAdmission } from '../../packages/auth/src/mfa-admission';
import {
  recordSessionAssurance,
  recordSsoAssurance,
  reserveMfaAttempt,
  revokeSessionAssurances,
  readMfaEnrollmentState,
} from '@ensemus/database/auth';
import { sessionAssurances, ssoProviders } from '@ensemus/database/product';
import { totpFromUri } from '../helpers/totp';
import { generatedSamlIdp, tamperSaml } from '../helpers/saml-idp';
import { makePerson, makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';
// The native SAML start binds its browser proof in a Secure __Host- cookie and refuses a
// non-HTTPS installation (saml-browser-flow bindStart), so this runtime uses an HTTPS origin.
const baseURL = 'https://generated-ensemus-sso.example.invalid',
  secret = 'generated-sso-auth-key-that-is-never-a-real-installation';
const incoming = (cookie = '') =>
  new Headers({
    cookie,
    'x-forwarded-for': `192.0.2.${1 + Math.floor(Math.random() * 200)}`,
    'user-agent': 'Generated SAML conformance',
  });
describe('SAML admission, company isolation and SCIM on actual roles', () => {
  const database = openAppDatabase(urls.app()),
    authority = openAuthDatabase(urls.auth()),
    authDriver = new pg.Client({ connectionString: urls.auth() }),
    driver = new pg.Client({ connectionString: urls.superuser() });
  const callbacks = {
    authorizeIdentity: (input: Parameters<typeof authorizeSsoIdentity>[1]) =>
      authorizeSsoIdentity(database.db, input),
    completeIdentity: async (input: Parameters<typeof completeSsoSignIn>[1]) =>
      (await completeSsoSignIn(database.db, input)).outcome,
    currentPrimary: (input: Parameters<typeof isSsoPrimaryCurrent>[1]) =>
      isSsoPrimaryCurrent(database.db, input),
  };
  const runtime = createAuth({
    databaseUrl: urls.auth(),
    baseURL,
    secret,
    allowSignup: false,
    sso: callbacks,
  });
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>,
    idp: Awaited<ReturnType<typeof generatedSamlIdp>>;
  beforeAll(async () => {
    await authDriver.connect();
    await driver.connect();
    tenants = await makeTwoTenants(database.db);
    await proveSecondFactor(tenants.a.owner);
    await proveSecondFactor(tenants.b.owner);
    idp = await generatedSamlIdp();
  });
  afterAll(async () => {
    await runtime.close();
    await database.close();
    await authority.close();
    await authDriver.end();
    await driver.end();
  });
  const proof = (person = tenants.a.owner) => ({ sessionId: person.sessionId });
  async function verify(providerId: string) {
    const reviewed = await inspectSsoProvider(urls.migrator(), providerId);
    expect(reviewed).not.toBeNull();
    return verifySsoDomain(urls.migrator(), {
      providerId,
      expectedSha256: reviewed!.expectedSha256,
    });
  }
  async function connection(active = true, owner = tenants.a.owner) {
    const domain = `generated-${randomUUID()}.example.invalid`;
    let row = await createSsoConnection(database.db, owner.context, proof(owner), {
      displayName: 'Generated company sign-in',
      domain,
    });
    expect(
      await runtime.sso.storeProvider({
        providerId: row.providerId,
        domain,
        idpMetadataXml: idp.metadata,
      }),
    ).toBe('stored');
    if (active) {
      expect(await verify(row.providerId)).toBe('verified');
      row = await updateSsoConnection(
        database.db,
        owner.context,
        proof(owner),
        { connectionId: row.id, expectedVersion: row.version, state: 'active' },
        { providerReady: async (providerId) => (await runtime.sso.status(providerId)).ready },
      );
    }
    return { ...row, owner };
  }
  async function person(
    f: Awaited<ReturnType<typeof connection>>,
    join = true,
    role: 'member' | 'owner' | 'admin' = 'member',
  ) {
    const current = await makePerson('generated-sso-person'),
      email = `person-${current.userId}@${f.domain}`;
    // An existing person whose address is already verified, the established seed for a real
    // account. Native SAML links only to a verified local email; an unverified one stays refused.
    await authDriver.query('update identity.users set email=$1, email_verified=true where id=$2', [
      email,
      current.userId,
    ]);
    if (join)
      await withTenantTx(database.db, f.owner.context, (tx) =>
        tx.insert(memberships).values({
          organizationId: f.owner.context.organizationId,
          userId: current.userId,
          role,
          status: 'active',
        }),
      );
    return {
      ...current,
      email,
      subject: `generated-subject-${randomUUID()}`,
      context: join
        ? await resolveTenantContext(database.db, current.userId, f.owner.context.organizationId)
        : null,
    };
  }
  const identity = (
    f: Awaited<ReturnType<typeof connection>>,
    p: Awaited<ReturnType<typeof person>>,
  ) => ({
    providerId: f.providerId,
    issuer: idp.issuer,
    externalSubject: p.subject,
    email: p.email,
    userId: p.userId,
  });
  async function link(
    f: Awaited<ReturnType<typeof connection>>,
    p: Awaited<ReturnType<typeof person>>,
  ) {
    expect((await completeSsoSignIn(database.db, identity(f, p))).outcome).toBe('member');
    return p.context!;
  }
  async function token(f: Awaited<ReturnType<typeof connection>>) {
    const value = await issueScimToken(database.db, f.owner.context, proof(f.owner), {
      connectionId: f.id,
    });
    return { ...value, hash: createHash('sha256').update(value.token).digest('hex') };
  }
  async function begin(f: Awaited<ReturnType<typeof connection>>, email: string) {
    const response = await runtime.auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/sso`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: baseURL,
          ...Object.fromEntries(incoming()),
        },
        body: JSON.stringify({
          providerId: f.providerId,
          providerType: 'saml',
          email,
          callbackURL: `${baseURL}/sso/complete`,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const metadata = await runtime.auth.handler(
      new Request(`${baseURL}/api/auth/sso/saml2/sp/metadata?providerId=${f.providerId}`),
    );
    expect(metadata.status).toBe(200);
    return {
      url: body.url,
      metadata: await metadata.text(),
      cookie: fixtureCookies(response.headers.get('set-cookie')),
    };
  }
  async function assertion(
    f: Awaited<ReturnType<typeof connection>>,
    p: Awaited<ReturnType<typeof person>>,
    options: Parameters<Awaited<ReturnType<typeof generatedSamlIdp>>['response']>[3] = {},
  ) {
    const flow = await begin(f, p.email),
      response = await idp.response(flow.url, flow.metadata, p.email, {
        subject: p.subject,
        ...options,
      });
    return { flow, response };
  }
  async function post(
    f: Awaited<ReturnType<typeof connection>>,
    flow: { cookie: string },
    response: { SAMLResponse: string; RelayState: string },
  ) {
    return runtime.auth.handler(
      new Request(`${baseURL}/api/auth/sso/saml2/sp/acs/${f.providerId}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: flow.cookie,
          origin: 'https://generated-idp.example.invalid',
        },
        body: new URLSearchParams({
          SAMLResponse: response.SAMLResponse,
          RelayState: response.RelayState,
        }),
      }),
    );
  }
  async function accepted(
    f: Awaited<ReturnType<typeof connection>>,
    p: Awaited<ReturnType<typeof person>>,
  ) {
    const input = await assertion(f, p),
      response = await post(f, input.flow, input.response);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).not.toContain('error=');
    const headers = incoming(fixtureCookies(response.headers.get('set-cookie'))),
      session = await runtime.auth.api.getSession({ headers });
    expect(session?.user.id).toBe(p.userId);
    return {
      input,
      response,
      headers,
      session: session!,
      identity: { sessionId: session!.session.id, userId: session!.user.id },
    };
  }
  async function enrolledSaml(f: Awaited<ReturnType<typeof connection>>) {
    const p = await person(f),
      signed = await accepted(f, p),
      setup = await runtime.mfa.enable({ password: '' }, signed.identity, signed.headers);
    expect(setup.outcome).toBe('verified');
    expect(
      (
        await runtime.mfa.confirmEnrollment(
          { code: totpFromUri(setup.totpURI!, Date.now() - 30000) },
          signed.identity,
          signed.headers,
        )
      ).outcome,
    ).toBe('verified');
    return { ...p, uri: setup.totpURI! };
  }
  async function samlChallenge(
    f: Awaited<ReturnType<typeof connection>>,
    p: Awaited<ReturnType<typeof enrolledSaml>>,
  ) {
    const input = await assertion(f, p),
      response = await post(f, input.flow, input.response),
      headers = incoming(fixtureCookies(response.headers.get('set-cookie')));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/sign-in/two-factor?');
    expect(await runtime.auth.api.getSession({ headers })).toBeNull();
    expect(headers.get('cookie')).toMatch(/better-auth\.two_factor=2fa-idp-[0-9a-f]{32}\./);
    const rows = (
      await authDriver.query(
        'select id,value from identity.verifications where identifier like $1 and value like $2',
        ['ensemus-idp-factor:v1:%', `%${p.userId}%`],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].value).not.toContain(p.subject);
    expect(rows[0].value).not.toContain(p.email);
    expect(rows[0].value).not.toContain(input.response.SAMLResponse);
    return {
      headers,
      bridgeId: rows[0].id as string,
      payload: JSON.parse(rows[0].value) as {
        sourceSessionId: string;
        authenticatedAt: number;
        payloadSha256: string;
      },
    };
  }
  async function blockedBy(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await driver.query(
        'select exists(select 1 from pg_stat_activity a where $1=any(pg_blocking_pids(a.pid))) as blocked',
        [pid],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('GENERATED_DATABASE_BARRIER_NOT_REACHED');
  }
  async function humanTx(client: pg.Client, context: TenantContext, actorType = 'user') {
    await client.query('begin');
    for (const [key, value] of Object.entries({
      'app.organization_id': context.organizationId,
      'app.user_id': context.userId,
      'app.membership_id': context.membershipId,
      'app.actor_type': actorType,
    }))
      await client.query('select set_config($1,$2,true)', [key, value]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `member_changes:${context.organizationId}`,
    ]);
  }

  it('requires a fresh manager and real session proof, refuses member/service/cross-tenant changes', async () => {
    for (const context of [
      tenants.a.member.context,
      createServiceContext(tenants.a.organizationId),
    ])
      await expect(listSsoConnections(database.db, context)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    await expect(
      createSsoConnection(database.db, tenants.a.owner.context, null, {
        displayName: 'Generated',
        domain: 'example.invalid',
      }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    const f = await connection();
    await expect(
      updateSsoConnection(database.db, tenants.b.owner.context, proof(tenants.b.owner), {
        connectionId: f.id,
        expectedVersion: f.version,
        state: 'disabled',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await listSsoConnections(database.db, tenants.b.owner.context)).some(
        (row) => row.id === f.id,
      ),
    ).toBe(false);
  });
  it('refuses unverified activation, missing auth readiness and stale settings', async () => {
    const f = await connection(false);
    await expect(
      updateSsoConnection(
        database.db,
        f.owner.context,
        proof(),
        { connectionId: f.id, expectedVersion: f.version, state: 'active' },
        { providerReady: async () => false },
      ),
    ).rejects.toMatchObject({ code: 'SSO_DOMAIN_NOT_VERIFIED' });
    await verify(f.providerId);
    await expect(
      updateSsoConnection(database.db, f.owner.context, proof(), {
        connectionId: f.id,
        expectedVersion: f.version,
        state: 'active',
      }),
    ).rejects.toMatchObject({ code: 'SSO_DOMAIN_NOT_VERIFIED' });
    const updated = await updateSsoConnection(
      database.db,
      f.owner.context,
      proof(),
      { connectionId: f.id, expectedVersion: f.version, state: 'active' },
      { providerReady: async (id) => (await runtime.sso.status(id)).ready },
    );
    await expect(
      updateSsoConnection(database.db, f.owner.context, proof(), {
        connectionId: f.id,
        expectedVersion: f.version,
        state: 'disabled',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(updated.state).toBe('active');
  });
  it('lets only the operator verify a domain, and atomically resets trust after metadata changes', async () => {
    const f = await connection();
    const application = new pg.Client({ connectionString: urls.app() });
    await application.connect();
    try {
      await expect(
        application.query("update org.sso_connections set domain_state='verified' where id=$1", [
          f.id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await application.end();
    }
    const replacement = await generatedSamlIdp();
    await prepareSsoMetadata(database.db, f.owner.context, proof(), {
      connectionId: f.id,
      expectedVersion: f.version,
    });
    expect(
      await runtime.sso.storeProvider({
        providerId: f.providerId,
        domain: f.domain,
        idpMetadataXml: replacement.metadata,
      }),
    ).toBe('stored');
    expect((await runtime.sso.status(f.providerId)).ready).toBe(false);
    const [row] = await listSsoConnections(database.db, f.owner.context);
    expect(row).toBeDefined();
    await expect(
      runtime.auth.handler(
        new Request(`${baseURL}/api/auth/sso/verify-domain`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: baseURL },
          body: JSON.stringify({ providerId: f.providerId }),
        }),
      ),
    ).resolves.toMatchObject({ status: 404 });
  });
  it('pins an operator-reviewed configuration hash and refuses a replacement committed while verification waits', async () => {
    const f = await connection(false),
      reviewed = await inspectSsoProvider(urls.migrator(), f.providerId);
    expect(reviewed?.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(reviewed)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(reviewed)).not.toContain('BEGIN CERTIFICATE');
    expect(
      await verifySsoDomain(urls.migrator(), { providerId: f.providerId, expectedSha256: '' }),
    ).toBe('review_required');
    const replacement = await generatedSamlIdp(),
      parsed = parseSamlMetadata(replacement.metadata, baseURL, f.providerId)!;
    const control = new pg.Client({ connectionString: urls.auth() });
    await control.connect();
    let verification: Promise<unknown> | undefined;
    try {
      await control.query('begin');
      const pid = (await control.query('select pg_backend_pid() as pid')).rows[0].pid;
      await control.query(
        'update identity.sso_providers set issuer=$1,saml_config=$2,domain_verified=false where provider_id=$3',
        [parsed.samlConfig.issuer, JSON.stringify(parsed.samlConfig), f.providerId],
      );
      verification = verifySsoDomain(urls.migrator(), {
        providerId: f.providerId,
        expectedSha256: reviewed!.expectedSha256,
      });
      await blockedBy(pid);
      await control.query('commit');
      expect(await verification).toBe('configuration_changed');
      expect((await runtime.sso.status(f.providerId)).ready).toBe(false);
      expect(
        (await listSsoConnections(database.db, f.owner.context)).find((row) => row.id === f.id)
          ?.domainState,
      ).toBe('unverified');
      expect(await verify(f.providerId)).toBe('verified');
    } finally {
      await control.query('rollback');
      await control.end();
      await verification?.catch(() => {});
    }
  });
  it('returns no_membership by default and auto-joins only a member, ignoring asserted roles', async () => {
    const f = await connection(),
      p = await person(f, false);
    expect(await completeSsoSignIn(database.db, identity(f, p))).toEqual({
      outcome: 'no_membership',
    });
    await updateSsoConnection(database.db, f.owner.context, proof(), {
      connectionId: f.id,
      expectedVersion: f.version,
      autoJoin: true,
    });
    expect((await completeSsoSignIn(database.db, identity(f, p))).outcome).toBe('member');
    expect(
      (await resolveTenantContext(database.db, p.userId, f.owner.context.organizationId)).role,
    ).toBe('member');
  });
  it('keeps provider+issuer+subject separate and refuses changed subjects, outside domains and disabled membership', async () => {
    const f = await connection(),
      p = await person(f);
    await link(f, p);
    expect(
      await authorizeSsoIdentity(database.db, { ...identity(f, p), email: 'person@other.invalid' }),
    ).toBe(false);
    expect(
      (
        await completeSsoSignIn(database.db, {
          ...identity(f, p),
          issuer: 'https://other-issuer.invalid',
        })
      ).outcome,
    ).toBe('refused');
    await withTenantTx(database.db, f.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, p.context!.membershipId)),
    );
    expect(await authorizeSsoIdentity(database.db, identity(f, p))).toBe(false);
    expect((await completeSsoSignIn(database.db, identity(f, p))).outcome).toBe('refused');
  });
  it('scopes hashed, revocable provisioning tokens to one connection, not arbitrary tenant users', async () => {
    const f = await connection(),
      p = await person(f),
      unlinked = await person(f);
    await link(f, p);
    const key = await token(f);
    const stored = (
      await driver.query('select token_hash from org.scim_tokens where id=$1', [key.tokenId])
    ).rows[0];
    expect(stored.token_hash).toBe(key.hash);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(key.token);
    const listed = await scimListUsers(database.db, key.hash, { startIndex: 1, count: 100 });
    expect(listed?.users.map((user) => user.id)).toEqual([p.context!.membershipId]);
    expect(await scimGetUser(database.db, key.hash, unlinked.context!.membershipId)).toBe(
      'not_found',
    );
    expect(
      await scimDeprovisionUser(database.db, key.hash, {
        membershipId: tenants.b.member.context.membershipId,
      }),
    ).toBe('not_found');
    expect(
      await scimListUsers(database.db, '0'.repeat(64), { startIndex: 1, count: 0 }),
    ).toBeNull();
    await revokeScimToken(database.db, f.owner.context, proof(), { tokenId: key.tokenId });
    expect(await scimListUsers(database.db, key.hash, { startIndex: 1, count: 0 })).toBeNull();
  });
  it('deprovisions once, refuses the next company request, and preserves another company', async () => {
    const f = await connection(),
      p = await person(f);
    await link(f, p);
    await withTenantTx(database.db, tenants.b.owner.context, (tx) =>
      tx.insert(memberships).values({
        organizationId: tenants.b.organizationId,
        userId: p.userId,
        role: 'member',
        status: 'active',
      }),
    );
    const key = await token(f);
    expect(
      await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('done');
    expect(
      await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('done');
    await expect(
      resolveTenantContext(database.db, p.userId, f.owner.context.organizationId),
    ).rejects.toBeDefined();
    expect((await resolveTenantContext(database.db, p.userId, tenants.b.organizationId)).role).toBe(
      'member',
    );
    expect((await completeSsoSignIn(database.db, identity(f, p))).outcome).toBe('refused');
    expect(await isSsoPrimaryCurrent(database.db, identity(f, p))).toBe(false);
    const events = await driver.query(
      "select count(*) from platform.domain_events where event_type='member.deprovisioned' and aggregate_id=$1",
      [p.context!.membershipId],
    );
    expect(Number(events.rows[0].count)).toBe(1);
    expect(
      await scimReactivateUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('done');
  });
  it('never revives a membership disabled by a human administrator', async () => {
    const f = await connection(),
      p = await person(f);
    await link(f, p);
    const key = await token(f);
    await withTenantTx(database.db, f.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, p.context!.membershipId)),
    );
    expect(
      await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('done');
    expect(
      await scimReactivateUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('refused');
  });
  it('invalidates the SCIM reactivation receipt when a human explicitly re-disables the same person', async () => {
    const f = await connection(),
      p = await person(f);
    await link(f, p);
    const key = await token(f);
    expect(
      await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('done');
    await withTenantTx(database.db, f.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, p.context!.membershipId)),
    );
    expect(
      await scimReactivateUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('refused');
  });
  it('serializes a human re-disable ahead of concurrent SCIM reactivation and preserves other people’s receipts', async () => {
    const f = await connection(),
      p = await person(f),
      other = await person(f);
    await link(f, p);
    await link(f, other);
    const key = await token(f);
    await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId });
    await scimDeprovisionUser(database.db, key.hash, { membershipId: other.context!.membershipId });
    const control = new pg.Client({ connectionString: urls.app() });
    await control.connect();
    let activation: Promise<unknown> | undefined;
    try {
      await humanTx(control, f.owner.context);
      const pid = (await control.query('select pg_backend_pid() as pid')).rows[0].pid;
      await control.query("update org.memberships set status='disabled' where id=$1", [
        p.context!.membershipId,
      ]);
      activation = scimReactivateUser(database.db, key.hash, {
        membershipId: p.context!.membershipId,
      });
      await blockedBy(pid);
      await control.query('commit');
      expect(await activation).toBe('refused');
      expect(
        await scimReactivateUser(database.db, key.hash, {
          membershipId: other.context!.membershipId,
        }),
      ).toBe('done');
    } finally {
      await control.query('rollback');
      await control.end();
      await activation?.catch(() => {});
    }
  });
  it('does not let a member, absent membership, agent or service manufacture a human re-disable intent', async () => {
    const f = await connection(),
      p = await person(f);
    await link(f, p);
    const key = await token(f);
    await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId });
    const control = new pg.Client({ connectionString: urls.app() });
    await control.connect();
    try {
      for (const current of [
        tenants.a.member.context,
        { ...tenants.a.owner.context, membershipId: randomUUID() },
      ]) {
        await humanTx(control, current);
        await expect(
          control.query("update org.memberships set status='disabled' where id=$1", [
            p.context!.membershipId,
          ]),
        ).rejects.toMatchObject({ code: '42501' });
        await control.query('rollback');
      }
      for (const actor of ['agent', 'service']) {
        await humanTx(control, f.owner.context, actor);
        // 0404 org.guard_membership_management: a non-user actor holds no member.manage
        // privilege, so the change itself is refused and no human intent can be recorded.
        await expect(
          control.query("update org.memberships set status='disabled' where id=$1", [
            p.context!.membershipId,
          ]),
        ).rejects.toMatchObject({ code: 'EN405', message: 'MFA_REQUIRED' });
        await control.query('rollback');
        const receipt = await driver.query(
          'select deprovisioned_at from org.sso_member_links where organization_id=$1 and membership_id=$2',
          [f.owner.context.organizationId, p.context!.membershipId],
        );
        expect(receipt.rows[0].deprovisioned_at).not.toBeNull();
      }
      expect(
        await scimReactivateUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
      ).toBe('done');
    } finally {
      await control.query('rollback');
      await control.end();
    }
  });
  it('records no human re-disable when a non-human disable actually reaches the receipt trigger', async () => {
    // The refused agent/service updates above roll back, so they cannot show what 0403's receipt
    // trigger does for a non-human actor. Here the change commits: 0404's guard admits a role other
    // than ensemus_app/ensemus_agent (the path the restore reconcile takes), so only 0403's
    // org.invalidate_scim_reactivation decides, on the bound actor type alone.
    const f = await connection(),
      p = await person(f);
    await link(f, p);
    const key = await token(f),
      membershipId = p.context!.membershipId;
    const receipt = async () =>
      (
        await driver.query<{ deprovisioned_at: Date | null; state: string }>(
          'select deprovisioned_at,state from org.sso_member_links where organization_id=$1 and membership_id=$2',
          [f.owner.context.organizationId, membershipId],
        )
      ).rows[0];
    const disableAs = async (actor: string) => {
      await humanTx(driver, f.owner.context, actor);
      try {
        const changed = await driver.query(
          "update org.memberships set status='disabled' where id=$1 and organization_id=$2",
          [membershipId, f.owner.context.organizationId],
        );
        expect(changed.rowCount).toBe(1);
        await driver.query('commit');
      } catch (error) {
        await driver.query('rollback');
        throw error;
      }
    };
    expect(await scimDeprovisionUser(database.db, key.hash, { membershipId })).toBe('done');
    const deprovisioned = (await receipt())!.deprovisioned_at;
    expect(deprovisioned).not.toBeNull();
    for (const actor of ['agent', 'service']) {
      await disableAs(actor);
      expect(await receipt()).toEqual({ deprovisioned_at: deprovisioned, state: 'deprovisioned' });
    }
    expect(await scimReactivateUser(database.db, key.hash, { membershipId })).toBe('done');
    // The same committed path with the human owner bound does invalidate the receipt.
    expect(await scimDeprovisionUser(database.db, key.hash, { membershipId })).toBe('done');
    expect((await receipt())!.deprovisioned_at).not.toBeNull();
    await disableAs('user');
    expect((await receipt())!.deprovisioned_at).toBeNull();
    expect(await scimReactivateUser(database.db, key.hash, { membershipId })).toBe('refused');
  });
  it('keeps and audits the last owner under the same membership-change serialization', async () => {
    const f = await connection();
    const p = {
      ...f.owner,
      email: `generated-owner@${f.domain}`,
      subject: `generated-owner-${randomUUID()}`,
      context: f.owner.context,
    };
    expect((await completeSsoSignIn(database.db, identity(f, p))).outcome).toBe('member');
    const key = await token(f);
    expect(
      await scimDeprovisionUser(database.db, key.hash, {
        membershipId: f.owner.context.membershipId,
      }),
    ).toBe('last_owner');
    expect(
      (await resolveTenantContext(database.db, f.owner.userId, f.owner.context.organizationId))
        .role,
    ).toBe('owner');
    expect(
      (
        await driver.query(
          "select safe_reason from governance.audit_events where action='sso.deprovision_refused' and target_ref=$1",
          [`membership:${f.owner.context.membershipId}`],
        )
      ).rows,
    ).toContainEqual({ safe_reason: 'LAST_OWNER' });
  });
  it('accepts an actual signed response, binds the authoritative session and ignores a signed owner claim', async () => {
    const f = await connection(),
      p = await person(f),
      result = await accepted(f, p);
    expect(
      (await resolveTenantContext(database.db, p.userId, f.owner.context.organizationId)).role,
    ).toBe('member');
    expect(await runtime.sso.verifiedSession(result.identity)).toMatchObject(identity(f, p));
    expect(
      (
        await authDriver.query(
          'select kind,sso_provider_id from identity.session_assurances where session_id=$1',
          [result.identity.sessionId],
        )
      ).rows,
    ).toContainEqual({ kind: 'sso_saml', sso_provider_id: f.providerId });
  });
  it.each([
    'unsigned',
    'wrongKey',
    'tampered',
    'wrapping',
    'unknownRequest',
    'missingRequest',
    'wrongAudience',
    'expired',
    'sha1',
    'outsideDomain',
  ] as const)(
    'refuses cryptographic/request/domain failure before account or session finalization: %s',
    async (kind) => {
      const f = await connection(),
        p = await person(f);
      const input = await assertion(f, p, {
        ...(kind === 'unsigned' ? { unsigned: true } : {}),
        ...(kind === 'unknownRequest' ? { requestId: `_${randomUUID()}` } : {}),
        ...(kind === 'missingRequest' ? { noInResponseTo: true } : {}),
        ...(kind === 'wrongAudience' ? { audience: 'https://other-sp.invalid' } : {}),
        ...(kind === 'expired' ? { expired: true } : {}),
        ...(kind === 'sha1' ? { algorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1' } : {}),
      });
      if (kind === 'wrongKey') {
        const other = await generatedSamlIdp({ issuer: idp.issuer });
        input.response = await other.response(input.flow.url, input.flow.metadata, p.email, {
          subject: p.subject,
        });
      }
      if (kind === 'outsideDomain')
        input.response = await idp.response(
          input.flow.url,
          input.flow.metadata,
          'person@outside.invalid',
          { subject: p.subject },
        );
      if (kind === 'tampered')
        input.response.SAMLResponse = tamperSaml(input.response.SAMLResponse, (xml) =>
          xml.replace(p.email, 'tampered@outside.invalid'),
        );
      if (kind === 'wrapping')
        input.response.SAMLResponse = tamperSaml(input.response.SAMLResponse, (xml) =>
          xml.replace(
            '</samlp:Response>',
            '<saml:Assertion ID="_wrapped" Version="2.0"><saml:Issuer>https://outside.invalid</saml:Issuer></saml:Assertion></samlp:Response>',
          ),
        );
      const response = await post(f, input.flow, input.response);
      expect(
        response.status >= 400 || (response.headers.get('location') ?? '').includes('error='),
      ).toBe(true);
      expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token=');
      expect(
        (
          await authDriver.query(
            'select id from identity.accounts where provider_id=$1 and user_id=$2',
            [f.providerId, p.userId],
          )
        ).rows,
      ).toHaveLength(0);
    },
  );
  it('admits only one copy of the same assertion across two web instances sharing real request/replay rows', async () => {
    const f = await connection(),
      p = await person(f),
      input = await assertion(f, p),
      replica = createAuth({
        databaseUrl: urls.auth(),
        baseURL,
        secret,
        allowSignup: false,
        sso: callbacks,
      });
    try {
      const request = () =>
        new Request(`${baseURL}/api/auth/sso/saml2/sp/acs/${f.providerId}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            cookie: input.flow.cookie,
          },
          body: new URLSearchParams({
            SAMLResponse: input.response.SAMLResponse,
            RelayState: input.response.RelayState,
          }),
        });
      const responses = await Promise.all([
        runtime.auth.handler(request()),
        replica.auth.handler(request()),
      ]);
      expect(
        responses.filter((response) =>
          (response.headers.get('set-cookie') ?? '').includes('session_token='),
        ),
      ).toHaveLength(1);
    } finally {
      await replica.close();
    }
  });
  it('refuses an unverified provider and provider B cannot answer provider A’s tracked request', async () => {
    const f = await connection(false);
    const refused = await runtime.auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/sso`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({
          providerId: f.providerId,
          providerType: 'saml',
          callbackURL: `${baseURL}/sso/complete`,
        }),
      }),
    );
    expect(refused.status).toBe(401);
    const a = await connection(),
      b = await connection(true, tenants.b.owner),
      member = await person(a),
      input = await assertion(a, member),
      response = await post(b, input.flow, input.response);
    expect(response.headers.get('location') ?? '').toMatch(/error=/);
    expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token=');
  });
  it('does not mint primary evidence from a password/ordinary session, a GET ACS or supplied identity fields', async () => {
    const f = await connection(),
      p = await person(f);
    expect(
      await runtime.sso.verifiedSession({ sessionId: p.sessionId, userId: p.userId }),
    ).toBeNull();
    const response = await runtime.auth.handler(
      new Request(
        `${baseURL}/api/auth/sso/saml2/sp/acs/${f.providerId}?RelayState=/sso/complete&userId=${p.userId}`,
      ),
    );
    expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token=');
    expect(
      await runtime.sso.verifiedSession({ sessionId: p.sessionId, userId: p.userId }),
    ).toBeNull();
  });
  it('uses actual SAML primary time for passwordless enrollment and refuses changed configuration/deprovisioned setup', async () => {
    const f = await connection(),
      p = await person(f),
      result = await accepted(f, p);
    const setup = await runtime.mfa.enable(
      { password: '', maxAgeSeconds: 900 },
      result.identity,
      result.headers,
    );
    expect(setup.outcome).toBe('verified');
    const gate = createPrimaryAuthentication(authority.db, secret, undefined, callbacks);
    expect(await gate.enrollmentCurrent({ ...result.identity, maxAgeSeconds: 900 })).toBe(true);
    const key = await token(f);
    await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId });
    expect(await gate.enrollmentCurrent({ ...result.identity, maxAgeSeconds: 900 })).toBe(false);
    const another = await person(f),
      current = await accepted(f, another);
    expect(
      (await runtime.mfa.enable({ password: '' }, current.identity, current.headers)).outcome,
    ).toBe('verified');
    const replacement = await generatedSamlIdp();
    await runtime.sso.storeProvider({
      providerId: f.providerId,
      domain: f.domain,
      idpMetadataXml: replacement.metadata,
    });
    expect(await gate.enrollmentCurrent({ ...current.identity, maxAgeSeconds: 900 })).toBe(false);
    expect(
      (await runtime.mfa.enable({ password: '' }, current.identity, current.headers)).outcome,
    ).toBe('primary_required');
  });
  it('requires a real local factor for an enrolled native SAML callback, then binds SSO and recent MFA to the actual resulting session', async () => {
    const f = await connection(),
      p = await enrolledSaml(f),
      pending = await samlChallenge(f, p);
    expect(
      (
        await authDriver.query('select id from identity.sessions where id=$1', [
          pending.payload.sourceSessionId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      await runtime.sso.verifiedSession({
        userId: p.userId,
        sessionId: pending.payload.sourceSessionId,
      }),
    ).toBeNull();
    const replica = createAuth({
      databaseUrl: urls.auth(),
      baseURL,
      secret,
      allowSignup: false,
      sso: callbacks,
    });
    try {
      const code = totpFromUri(p.uri),
        done = await replica.mfa.completeSignIn({ kind: 'totp', code }, pending.headers);
      expect(done.outcome).toBe('verified');
      const headers = incoming(fixtureCookies(done.setCookie)),
        session = await replica.auth.api.getSession({ headers });
      expect(session?.user.id).toBe(p.userId);
      const actual = { userId: p.userId, sessionId: session!.session.id };
      expect(await replica.sso.verifiedSession(actual)).toMatchObject({
        providerId: f.providerId,
        userId: p.userId,
        externalSubject: p.subject,
      });
      expect(
        (
          await authDriver.query(
            'select kind from identity.session_assurances where session_id=$1',
            [actual.sessionId],
          )
        ).rows
          .map((row) => row.kind)
          .sort(),
      ).toEqual(['mfa_totp', 'sso_saml']);
      expect(
        (
          await authDriver.query('select id from identity.verifications where id=$1', [
            pending.bridgeId,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (await replica.mfa.completeSignIn({ kind: 'totp', code }, pending.headers)).outcome,
      ).toBe('refused');
    } finally {
      await replica.close();
    }
  });
  it.each([
    'configuration',
    'deprovision',
    'missing-bridge',
    'expired-bridge',
    'unlinked-account',
  ] as const)(
    'withholds SAML factor-completed cookie and proof after the pending handoff loses %s authority',
    async (mode) => {
      const f = await connection(),
        p = await enrolledSaml(f),
        pending = await samlChallenge(f, p),
        before = (
          await authDriver.query(
            'select session_id,kind from identity.session_assurances where user_id=$1',
            [p.userId],
          )
        ).rows;
      if (mode === 'configuration') {
        const other = await generatedSamlIdp();
        await runtime.sso.storeProvider({
          providerId: f.providerId,
          domain: f.domain,
          idpMetadataXml: other.metadata,
        });
      }
      if (mode === 'deprovision') {
        const scim = await token(f);
        expect(
          await scimDeprovisionUser(database.db, scim.hash, {
            membershipId: p.context!.membershipId,
          }),
        ).toBe('done');
      }
      if (mode === 'missing-bridge')
        await authDriver.query('delete from identity.verifications where id=$1', [
          pending.bridgeId,
        ]);
      if (mode === 'expired-bridge')
        await authDriver.query(
          "update identity.verifications set expires_at=now()-interval '1 second' where id=$1",
          [pending.bridgeId],
        );
      if (mode === 'unlinked-account')
        await authDriver.query(
          'delete from identity.accounts where user_id=$1 and provider_id=$2',
          [p.userId, f.providerId],
        );
      const beforeComplete = (
          await authDriver.query(
            'select session_id,kind from identity.session_assurances where user_id=$1',
            [p.userId],
          )
        ).rows,
        done = await runtime.mfa.completeSignIn(
          { kind: 'totp', code: totpFromUri(p.uri) },
          pending.headers,
        );
      expect(done).toMatchObject({ outcome: 'primary_required', setCookie: null });
      expect(
        (
          await authDriver.query(
            'select session_id,kind from identity.session_assurances where user_id=$1',
            [p.userId],
          )
        ).rows,
      ).toEqual(beforeComplete);
      expect(beforeComplete.length).toBeLessThanOrEqual(before.length);
    },
  );
  it.each(['configuration', 'deprovision'] as const)(
    'withholds the actual rotated session and MFA proof when %s changes during confirmation',
    async (kind) => {
      const f = await connection(),
        p = await person(f),
        signed = await accepted(f, p),
        setup = await runtime.mfa.enable({ password: '' }, signed.identity, signed.headers);
      expect(setup.outcome).toBe('verified');
      const key = await token(f),
        gate = createPrimaryAuthentication(authority.db, secret, undefined, callbacks),
        privateCore = privateFactorRouter(authority.db, secret, baseURL);
      let reached!: () => void, release!: () => void;
      const barrier = new Promise<void>((resolve) => {
          reached = resolve;
        }),
        unblock = new Promise<void>((resolve) => {
          release = resolve;
        });
      const operations = createMfaOperations({
        baseURL,
        enrollmentState: (userId) => readMfaEnrollmentState(authority.db, userId),
        managementHandler: privateCore.handler,
        handler: async (request) => {
          const response = await privateCore.handler(request);
          if (
            request.method === 'POST' &&
            new URL(request.url).pathname.endsWith('/verify-totp') &&
            response.status === 200
          ) {
            reached();
            await unblock;
          }
          return response;
        },
        record: (input) => recordSessionAssurance(authority.db, input),
        reserveAttempt: (userId) => reserveMfaAttempt(authority.db, userId, MFA_ACCOUNT_LOCKOUT),
        admit: createMfaAdmission(authority.db, secret),
        revoke: (userId) => revokeSessionAssurances(authority.db, userId),
        prepareEnrollment: (input) => gate.prepareEnrollment(input),
        recordEnrollment: (input, value) => gate.recordEnrollment(input, value),
        enrollmentCurrent: (input) => gate.enrollmentCurrent(input),
        enrollmentCurrentAfterRotation: (input) => gate.enrollmentCurrentAfterRotation(input),
        completePrimaryAfterFactor: async () => true,
      });
      const pending = operations.confirmEnrollment(
        { code: totpFromUri(setup.totpURI!, Date.now() - 30000) },
        signed.identity,
        signed.headers,
      );
      try {
        await Promise.race([
          barrier,
          pending.then(() => {
            throw new Error('GENERATED_CONFIRMATION_DID_NOT_REACH_BARRIER');
          }),
        ]);
        if (kind === 'configuration') {
          const replacement = await generatedSamlIdp();
          await runtime.sso.storeProvider({
            providerId: f.providerId,
            domain: f.domain,
            idpMetadataXml: replacement.metadata,
          });
        } else
          expect(
            await scimDeprovisionUser(database.db, key.hash, {
              membershipId: p.context!.membershipId,
            }),
          ).toBe('done');
        release();
        expect(await pending).toMatchObject({ outcome: 'primary_required', setCookie: null });
        expect(
          (
            await authDriver.query(
              "select kind from identity.session_assurances where user_id=$1 and kind in ('mfa_totp','mfa_backup_code')",
              [p.userId],
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        release();
        await pending.catch(() => {});
      }
    },
  );
  it.each(['old', 'missing', 'future', 'futureWithinSkew'] as const)(
    'never substitutes callback time for signed SAML authentication time: %s',
    async (kind) => {
      const f = await connection(),
        p = await person(f),
        authenticatedAt =
          kind === 'missing'
            ? null
            : Date.now() + (kind === 'old' ? -3600000 : kind === 'future' ? 120000 : 30000),
        input = await assertion(f, p, { authenticatedAt });
      const response = await post(f, input.flow, input.response);
      if (kind === 'future') {
        expect(response.status).toBe(400);
        expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token=');
        return;
      }
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).not.toContain('error=');
      const headers = incoming(fixtureCookies(response.headers.get('set-cookie'))),
        session = await runtime.auth.api.getSession({ headers });
      expect(session).not.toBeNull();
      const current = { sessionId: session!.session.id, userId: session!.user.id };
      expect(
        (await runtime.mfa.enable({ password: '', maxAgeSeconds: 900 }, current, headers)).outcome,
      ).toBe('primary_required');
      const receipts = (
        await authDriver.query('select value from identity.verifications where value like $1', [
          'saml:%',
        ])
      ).rows.map((row) => JSON.parse(row.value.slice(5)) as { authenticatedAt: number | null });
      expect(receipts.some((receipt) => receipt.authenticatedAt === authenticatedAt)).toBe(true);
    },
  );
  it('keeps required SSO tenant-specific, leaves owners in and releases members when the active connection is disabled', async () => {
    const f = await connection(),
      p = await person(f);
    await updateSecurityPolicy(database.db, f.owner.context, proof(), {
      expectedVersion: 1,
      mfaForAdministration: false,
      mfaMaxAgeSeconds: 900,
      ssoEnforcement: 'required',
    });
    await expect(
      assertTenantSignIn(database.db, p.context!, { sessionId: p.sessionId }),
    ).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
    await expect(
      assertTenantSignIn(database.db, f.owner.context, proof()),
    ).resolves.toBeUndefined();
    const current = await accepted(f, p);
    await expect(
      assertTenantSignIn(database.db, p.context!, { sessionId: current.identity.sessionId }),
    ).resolves.toBeUndefined();
    await updateSsoConnection(database.db, f.owner.context, proof(), {
      connectionId: f.id,
      expectedVersion: f.version,
      state: 'disabled',
    });
    await expect(
      assertTenantSignIn(database.db, p.context!, { sessionId: p.sessionId }),
    ).resolves.toBeUndefined();
  });
  it('denies a late SSO receipt after SCIM disable and human re-enable while the actual provider link remains deprovisioned', async () => {
    const f = await connection(),
      p = await person(f),
      signed = await accepted(f, p),
      key = await token(f),
      reviewed = await inspectSsoProvider(urls.migrator(), f.providerId);
    await updateSecurityPolicy(database.db, f.owner.context, proof(), {
      expectedVersion: 1,
      mfaForAdministration: false,
      mfaMaxAgeSeconds: 900,
      ssoEnforcement: 'required',
    });
    await expect(
      assertTenantSignIn(database.db, p.context!, { sessionId: signed.identity.sessionId }),
    ).resolves.toBeUndefined();
    expect(
      await scimDeprovisionUser(database.db, key.hash, { membershipId: p.context!.membershipId }),
    ).toBe('done');
    // Reproduce the real cross-role gap: auth can finish an already accepted assertion after SCIM
    // commits. Its receipt is real, yet it must not carry current tenant authority.
    expect(
      await recordSsoAssurance(authority.db, {
        sessionId: signed.identity.sessionId,
        userId: p.userId,
        providerId: f.providerId,
        externalSubject: p.subject,
        expectedSha256: reviewed!.expectedSha256,
      }),
    ).toBe(true);
    expect(
      await withTenantTx(database.db, p.context!, (tx) =>
        tx
          .select({ sessionId: sessionAssurances.sessionId })
          .from(sessionAssurances)
          .where(eq(sessionAssurances.sessionId, signed.identity.sessionId)),
      ),
    ).toEqual([]);
    await withTenantTx(database.db, f.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ status: 'active' })
        .where(eq(memberships.id, p.context!.membershipId)),
    );
    const restored = await resolveTenantContext(
      database.db,
      p.userId,
      f.owner.context.organizationId,
    );
    expect(
      await withTenantTx(database.db, restored, (tx) =>
        tx
          .select({ sessionId: sessionAssurances.sessionId })
          .from(sessionAssurances)
          .where(eq(sessionAssurances.sessionId, signed.identity.sessionId)),
      ),
    ).toEqual([]);
    await expect(
      assertTenantSignIn(database.db, restored, { sessionId: signed.identity.sessionId }),
    ).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
  });
  it('rechecks actual provider trust and live session metadata without exposing provider configuration or session tokens to the app', async () => {
    const f = await connection(),
      p = await person(f),
      signed = await accepted(f, p),
      other = await connection(true, tenants.b.owner);
    await updateSecurityPolicy(database.db, f.owner.context, proof(), {
      expectedVersion: 1,
      mfaForAdministration: false,
      mfaMaxAgeSeconds: 900,
      ssoEnforcement: 'required',
    });
    expect(
      await withTenantTx(database.db, p.context!, (tx) =>
        tx
          .select({ providerId: ssoProviders.providerId, verified: ssoProviders.domainVerified })
          .from(ssoProviders)
          .where(eq(ssoProviders.providerId, other.providerId)),
      ),
    ).toEqual([]);
    await authDriver.query(
      'update identity.sso_providers set domain_verified=false where provider_id=$1',
      [f.providerId],
    );
    await expect(
      assertTenantSignIn(database.db, p.context!, { sessionId: signed.identity.sessionId }),
    ).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
    await authDriver.query(
      'update identity.sso_providers set domain_verified=true where provider_id=$1',
      [f.providerId],
    );
    await authDriver.query(
      "update identity.sessions set expires_at=now()-interval '1 second' where id=$1",
      [signed.identity.sessionId],
    );
    await expect(
      assertTenantSignIn(database.db, p.context!, { sessionId: signed.identity.sessionId }),
    ).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
    const app = new pg.Client({ connectionString: urls.app() });
    await app.connect();
    try {
      await expect(app.query('select token from identity.sessions')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(
        app.query('select saml_config from identity.sso_providers'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
  });

  //0410 joins the actual signed native callback above to actual privileged effects. No test mints a
  // fake SSO assurance: only the separate MFA fixture is auth-role seeded, as explicitly named below.
  describe('required company sign-in remains current through the effect transaction', () => {
    async function effectPerson(required = true) {
      const own = await makeTwoTenants(database.db);
      await proveSecondFactor(own.a.owner);
      const f = await connection(true, own.a.owner),
        p = await person(f, true, 'admin'),
        signed = await accepted(f, p);
      await proveSecondFactor(signed.identity);
      const current = await runtime.readInteractiveSession(signed.headers);
      expect(current).toBeTruthy();
      const context = await resolveInteractiveTenantContext(
        database.db,
        current!.identity,
        own.a.organizationId,
      );
      if (required) {
        const policy = await getSecurityPolicy(database.db, own.a.owner.context);
        await updateSecurityPolicy(database.db, own.a.owner.context, proof(own.a.owner), {
          expectedVersion: policy.version,
          mfaForAdministration: false,
          mfaMaxAgeSeconds: 900,
          ssoEnforcement: 'required',
        });
      }
      const rows = await authDriver.query<{ primary_account_id: string }>(
        'select primary_account_id from identity.session_assurances where session_id=$1 and kind=$2',
        [signed.identity.sessionId, 'sso_saml'],
      );
      expect(rows.rows[0]?.primary_account_id).toBeTruthy();
      return {
        f,
        p,
        signed,
        context,
        accountId: rows.rows[0]!.primary_account_id,
        organizationId: own.a.organizationId,
      };
    }
    async function blockedBy(pid: number) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const state = await driver.query<{ blocked: boolean }>(
          "select exists(select 1 from pg_stat_activity where usename='ensemus_app' and $1=any(pg_blocking_pids(pid))) as blocked",
          [pid],
        );
        if (state.rows[0]?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('TEST_EXPECTED_SSO_DATABASE_LOCK_WAIT');
    }
    const effect = (input: Awaited<ReturnType<typeof effectPerson>>) =>
      createTeam(database.db, input.context, { name: `Generated effect ${randomUUID()}` });
    it('binds a real native SAML account proof and permits the actual admin effect', async () => {
      const input = await effectPerson();
      await assertTenantSignIn(database.db, input.context, {
        sessionId: input.signed.identity.sessionId,
      });
      expect(await effect(input)).toMatchObject({ organizationId: input.organizationId });
    });
    it('does not expose the opaque primary-account control column through the app role', async () => {
      const input = await effectPerson(),
        app = new pg.Client({ connectionString: urls.app() });
      await app.connect();
      try {
        await expect(
          app.query('select primary_account_id from identity.session_assurances'),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await app.end();
      }
      expect(input.accountId).toBeTruthy();
    });
    it('refuses a legacy unbound SSO row at both the existing read gate and the effect', async () => {
      const input = await effectPerson();
      await authDriver.query(
        'update identity.session_assurances set primary_account_id=null where session_id=$1 and kind=$2',
        [input.signed.identity.sessionId, 'sso_saml'],
      );
      await expect(
        assertTenantSignIn(database.db, input.context, {
          sessionId: input.signed.identity.sessionId,
        }),
      ).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
      await expect(effect(input)).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
    });
    it('rejects an account deleted after request admission while preserving its local factor proof', async () => {
      const input = await effectPerson();
      await assertTenantSignIn(database.db, input.context, {
        sessionId: input.signed.identity.sessionId,
      });
      await authDriver.query('delete from identity.accounts where id=$1', [input.accountId]);
      expect(
        (
          await authDriver.query<{ kind: string }>(
            'select kind from identity.session_assurances where session_id=$1',
            [input.signed.identity.sessionId],
          )
        ).rows.map((row) => row.kind),
      ).toEqual(['mfa_totp']);
      await expect(effect(input)).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
    });
    it('invalidates only the SSO proof for a changed account identity', async () => {
      const input = await effectPerson(),
        other = await effectPerson();
      await authDriver.query(
        "update identity.accounts set account_id=account_id||'-changed' where id=$1",
        [input.accountId],
      );
      await expect(effect(input)).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
      expect(await effect(other)).toMatchObject({ organizationId: other.organizationId });
      expect(
        (
          await authDriver.query(
            'select count(*)::int as n from identity.session_assurances where session_id=$1 and kind=$2',
            [input.signed.identity.sessionId, 'mfa_totp'],
          )
        ).rows[0]?.n,
      ).toBe(1);
    });
    it('retains a valid SSO receipt for an unrelated account token refresh', async () => {
      const input = await effectPerson();
      await authDriver.query(
        'update identity.accounts set updated_at=clock_timestamp() where id=$1',
        [input.accountId],
      );
      expect(await effect(input)).toMatchObject({ organizationId: input.organizationId });
    });
    it('refuses provider trust removal after the earlier request gate succeeded', async () => {
      const input = await effectPerson();
      await assertTenantSignIn(database.db, input.context, {
        sessionId: input.signed.identity.sessionId,
      });
      await authDriver.query(
        'update identity.sso_providers set domain_verified=false where provider_id=$1',
        [input.f.providerId],
      );
      await expect(effect(input)).rejects.toMatchObject({ code: 'SSO_REQUIRED' });
    });
    it('keeps optional SSO optional despite a missing receipt', async () => {
      const input = await effectPerson(false);
      await authDriver.query(
        'delete from identity.session_assurances where session_id=$1 and kind=$2',
        [input.signed.identity.sessionId, 'sso_saml'],
      );
      expect(await effect(input)).toMatchObject({ organizationId: input.organizationId });
    });
    it('preserves the documented owner recovery path', async () => {
      const input = await effectPerson();
      await authDriver.query(
        'update identity.sso_providers set domain_verified=false where provider_id=$1',
        [input.f.providerId],
      );
      expect(
        await createTeam(database.db, input.f.owner.context, { name: 'Owner recovery' }),
      ).toMatchObject({ organizationId: input.organizationId });
    });
    it('preserves the documented no-active-connection recovery path', async () => {
      const input = await effectPerson();
      await updateSsoConnection(
        database.db,
        input.f.owner.context,
        proof(input.f.owner),
        { connectionId: input.f.id, expectedVersion: input.f.version, state: 'disabled' },
        { providerReady: async () => false },
      );
      expect(await effect(input)).toMatchObject({ organizationId: input.organizationId });
    });
    for (const revocation of ['provider trust', 'primary account', 'SSO receipt'] as const) {
      it(`waits for concurrent ${revocation} revocation and then refuses the actual effect`, async () => {
        const input = await effectPerson(),
          pid = (await authDriver.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!
            .pid;
        await authDriver.query('begin');
        let attempted: Promise<unknown> | undefined;
        try {
          if (revocation === 'provider trust')
            await authDriver.query(
              'update identity.sso_providers set domain_verified=false where provider_id=$1',
              [input.f.providerId],
            );
          else if (revocation === 'primary account')
            await authDriver.query('delete from identity.accounts where id=$1', [input.accountId]);
          else
            await authDriver.query(
              'delete from identity.session_assurances where session_id=$1 and kind=$2',
              [input.signed.identity.sessionId, 'sso_saml'],
            );
          attempted = effect(input).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await blockedBy(pid);
          await authDriver.query('commit');
          expect(await attempted).toMatchObject({ error: { code: 'SSO_REQUIRED' } });
        } finally {
          await authDriver.query('rollback');
          await attempted;
        }
      });
    }
    it('waits for a control-plane link revocation even when its membership remains active', async () => {
      const input = await effectPerson(),
        pid = (await driver.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await driver.query('begin');
      let attempted: Promise<unknown> | undefined;
      try {
        // Trusted fixture isolates the link state left by an explicit member re-enable; actual SCIM
        // also disables the member, which the existing current-person guard independently denies.
        await driver.query(
          "update org.sso_member_links set state='deprovisioned',deprovisioned_at=clock_timestamp() where organization_id=$1 and membership_id=$2",
          [input.organizationId, input.context.membershipId],
        );
        attempted = effect(input).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await blockedBy(pid);
        await driver.query('commit');
        expect(await attempted).toMatchObject({ error: { code: 'SSO_REQUIRED' } });
      } finally {
        await driver.query('rollback');
        await attempted;
      }
    });
    it('serializes an optional-to-required policy change before the actual admin effect', async () => {
      const input = await effectPerson(false),
        owner = input.f.owner,
        control = new pg.Client({ connectionString: urls.app() });
      await authDriver.query(
        'delete from identity.session_assurances where session_id=$1 and kind=$2',
        [input.signed.identity.sessionId, 'sso_saml'],
      );
      await control.connect();
      await control.query('begin');
      let attempted: Promise<unknown> | undefined;
      try {
        await control.query(
          "select set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true),set_config('app.membership_id',$3,true),set_config('app.actor_type','user',true),set_config('app.interactive_session_id',$4,true)",
          [input.organizationId, owner.userId, owner.context.membershipId, owner.sessionId],
        );
        await control.query(
          "insert into org.security_policies(organization_id,mfa_for_administration,mfa_max_age_seconds,sso_enforcement,version,updated_by_membership_id) values($1,false,900,'required',2,$2)",
          [input.organizationId, owner.context.membershipId],
        );
        const pid = (await control.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0]!.pid;
        attempted = effect(input).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await blockedBy(pid);
        await control.query('commit');
        expect(await attempted).toMatchObject({ error: { code: 'SSO_REQUIRED' } });
      } finally {
        await control.query('rollback');
        await attempted;
        await control.end();
      }
    });
    it('rolls back a successful authority check with its transaction and restores private scope', async () => {
      const input = await effectPerson(),
        failure = new Error('TEST_SSO_ROLLBACK');
      await expect(
        withPrivilegeTx(database.db, input.context, async (tx) => {
          const before = await tx.execute(
            sql`select current_setting('identity.mfa_guard_active',true) as active,current_setting('identity.mfa_guard_user',true) as person,current_setting('identity.mfa_guard_session',true) as session`,
          );
          await assertInteractivePrivilege(tx, input.context, 'member.manage');
          const after = await tx.execute(
            sql`select current_setting('identity.mfa_guard_active',true) as active,current_setting('identity.mfa_guard_user',true) as person,current_setting('identity.mfa_guard_session',true) as session`,
          );
          const normalized = (rows: typeof before.rows) =>
            rows.map((row) =>
              Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? ''])),
            );
          expect(normalized(after.rows)).toEqual(normalized(before.rows));
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await effect(input)).toMatchObject({ organizationId: input.organizationId });
    });
  });
});
