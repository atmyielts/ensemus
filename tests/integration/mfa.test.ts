// Real auth/app roles. Generated identities only; these tests are authored until the M7 DB gate runs.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { memberships, openAppDatabase, withTenantTx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import {
  openAuthDatabase,
  recordSessionAssurance,
  revokeSessionAssurances,
  reserveMfaAttempt,
  readMfaEnrollmentState,
} from '@ensemus/database/auth';
import { sessionAssurances } from '@ensemus/database/product';
import {
  getSecurityPolicy,
  updateSecurityPolicy,
  listMemberSecondFactors,
} from '@ensemus/application/security-policy';
import { assertRecentMfa } from '@ensemus/application/privileged';
import { createMfaAdmission } from '../../packages/auth/src/mfa-admission';
import { createAuth } from '@ensemus/auth';
import { createMfaOperations, MFA_ACCOUNT_LOCKOUT } from '../../packages/auth/src/mfa';
import {
  privateFactorRouter,
  fixtureCookies,
  fixturePasswordHash,
} from '../../packages/auth/test-support/mfa-router';
import { createPrimaryAuthentication } from '../../packages/auth/src/mfa-primary';
import { totpFromUri } from '../helpers/totp';
import { makePerson, makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

describe('recent MFA and tenant security policy on restricted roles', () => {
  const application = openAppDatabase(urls.app()),
    authentication = openAuthDatabase(urls.auth());
  const authClient = new pg.Client({ connectionString: urls.auth() });
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    await authClient.connect();
    tenants = await makeTwoTenants(application.db);
  });
  afterAll(async () => {
    await Promise.all([application.close(), authentication.close(), authClient.end()]);
  });
  const policy = {
    expectedVersion: 1,
    mfaForAdministration: true,
    mfaMaxAgeSeconds: 600,
    ssoEnforcement: 'optional' as const,
  };
  const change = (person = tenants.a.owner, sessionId = person.sessionId) =>
    updateSecurityPolicy(application.db, person.context, { sessionId }, policy);
  it('refuses a member, an admin and a service context before policy mutation', async () => {
    for (const person of [tenants.a.member, tenants.a.admin]) {
      await proveSecondFactor(person);
      await expect(change(person)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    await expect(
      updateSecurityPolicy(
        application.db,
        createServiceContext(tenants.a.organizationId),
        null,
        policy,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('refuses no proof, an old proof, another session and another person', async () => {
    const owner = tenants.a.owner;
    await expect(
      updateSecurityPolicy(application.db, owner.context, null, policy),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await proveSecondFactor(owner, new Date(Date.now() - 901000));
    await expect(change()).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await proveSecondFactor(tenants.a.member);
    await expect(change(owner, tenants.a.member.sessionId)).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
    await expect(change(owner, randomUUID())).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('uses one live session proof for the effect, audits a versioned policy, and rejects stale repeats', async () => {
    await proveSecondFactor(tenants.a.owner);
    const changed = await change();
    expect(changed).toMatchObject({
      mfaForAdministration: true,
      mfaMaxAgeSeconds: 600,
      ssoEnforcement: 'optional',
      version: 2,
    });
    await expect(change()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await getSecurityPolicy(application.db, tenants.b.owner.context)).toMatchObject({
      mfaForAdministration: false,
      mfaMaxAgeSeconds: 900,
      ssoEnforcement: 'optional',
      version: 1,
    });
    expect(await getSecurityPolicy(application.db, tenants.a.member.context)).toEqual(changed);
  });
  it('checks the fresh membership role and status instead of a cached owner context', async () => {
    await proveSecondFactor(tenants.b.owner);
    // An additional owner avoids last-owner protection while exercising a stale cached context.
    await withTenantTx(application.db, tenants.b.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'owner' })
        .where(eq(memberships.id, tenants.b.admin.context.membershipId)),
    );
    await withTenantTx(application.db, tenants.b.owner.context, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.id, tenants.b.owner.context.membershipId)),
    );
    await expect(change(tenants.b.owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      listMemberSecondFactors(application.db, tenants.b.owner.context),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('shows only enrollment status to active member managers and never factor secrets', async () => {
    await expect(
      listMemberSecondFactors(application.db, tenants.a.member.context),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const people = await listMemberSecondFactors(application.db, tenants.a.admin.context);
    expect(people).toHaveLength(3);
    expect(
      people.every(
        (person) => Object.keys(person).sort().join(',') === 'enrolled,membershipId,name',
      ),
    ).toBe(true);
    expect(
      people.some((person) => person.membershipId === tenants.b.owner.context.membershipId),
    ).toBe(false);
  });
  it('denies app-role assurance insertion/update and service proof use', async () => {
    await expect(
      withTenantTx(application.db, tenants.a.owner.context, (tx) =>
        tx.insert(sessionAssurances).values({
          sessionId: tenants.a.owner.sessionId,
          userId: tenants.a.owner.userId,
          kind: 'mfa_totp',
          verifiedAt: new Date(),
        }),
      ),
    ).rejects.toBeDefined();
    await expect(
      withTenantTx(application.db, tenants.a.owner.context, (tx) =>
        tx
          .update(sessionAssurances)
          .set({ verifiedAt: new Date() })
          .where(eq(sessionAssurances.sessionId, tenants.a.owner.sessionId)),
      ),
    ).rejects.toBeDefined();
    await expect(
      withTenantTx(application.db, createServiceContext(tenants.a.organizationId), (tx) =>
        assertRecentMfa(
          tx,
          createServiceContext(tenants.a.organizationId),
          'security_policy.change',
          { sessionId: tenants.a.owner.sessionId },
        ),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('admits one successful account code across concurrent auth-role transactions and stores no plaintext', async () => {
    const user = await makePerson('replay-admission');
    const code = '123456',
      key = 'synthetic-admission-key-' + randomUUID();
    const admit = createMfaAdmission(authentication.db, key);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => admit({ userId: user.userId, kind: 'mfa_totp', code })),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await admit({ userId: user.userId, kind: 'mfa_totp', code })).toBe(false);
    const other = await makePerson('other-admission');
    expect(await admit({ userId: other.userId, kind: 'mfa_totp', code })).toBe(true);
    const rows = await authClient.query(
      "select identifier,value from identity.verifications where identifier like 'ensemus-mfa-admit:v1:%'",
    );
    expect(JSON.stringify(rows.rows)).not.toContain(code);
    expect(JSON.stringify(rows.rows)).not.toContain(user.userId);
  });
  it('invalidates all MFA assurances on factor removal while preserving SSO and other people', async () => {
    const person = await makePerson('remove-second-factor'),
      other = await makePerson('keep-second-factor');
    const secondSession = randomUUID();
    await authClient.query(
      'update identity.users set two_factor_enabled=true where id=any($1::uuid[])',
      [[person.userId, other.userId]],
    );
    await authClient.query(
      "insert into identity.sessions(id,user_id,token,expires_at) values($1,$2,$3,now()+interval '1 hour')",
      [secondSession, person.userId, randomUUID()],
    );
    await recordSessionAssurance(authentication.db, { ...person, kind: 'mfa_totp' });
    await recordSessionAssurance(authentication.db, {
      sessionId: secondSession,
      userId: person.userId,
      kind: 'mfa_backup_code',
    });
    await recordSessionAssurance(authentication.db, {
      ...person,
      kind: 'sso_saml',
      ssoProviderId: 'generated-provider',
    });
    await recordSessionAssurance(authentication.db, { ...other, kind: 'mfa_totp' });
    await revokeSessionAssurances(authentication.db, person.userId);
    expect(
      (
        await authClient.query('select kind from identity.session_assurances where user_id=$1', [
          person.userId,
        ])
      ).rows,
    ).toEqual([{ kind: 'sso_saml' }]);
    expect(
      (
        await authClient.query('select kind from identity.session_assurances where user_id=$1', [
          other.userId,
        ])
      ).rows,
    ).toEqual([{ kind: 'mfa_totp' }]);
    // Cascading sign-out removes even the remaining SSO proof for that exact session.
    await authClient.query('delete from identity.sessions where id=$1', [person.sessionId]);
    expect(
      (
        await authClient.query('select kind from identity.session_assurances where session_id=$1', [
          person.sessionId,
        ])
      ).rows,
    ).toEqual([]);
  });
  it('refuses trusted proof minting for disabled, expired and mismatched sessions', async () => {
    const person = await makePerson('proof-current'),
      other = await makePerson('proof-other');
    await expect(
      recordSessionAssurance(authentication.db, { ...person, kind: 'mfa_totp' }),
    ).rejects.toThrow('MFA_PROOF_NOT_CURRENT');
    await authClient.query('update identity.users set two_factor_enabled=true where id=$1', [
      person.userId,
    ]);
    await expect(
      recordSessionAssurance(authentication.db, {
        userId: person.userId,
        sessionId: other.sessionId,
        kind: 'mfa_totp',
      }),
    ).rejects.toThrow('MFA_PROOF_NOT_CURRENT');
    await authClient.query(
      "update identity.sessions set expires_at=now()-interval '1 second' where id=$1",
      [person.sessionId],
    );
    await expect(
      recordSessionAssurance(authentication.db, { ...person, kind: 'mfa_totp' }),
    ).rejects.toThrow('MFA_PROOF_NOT_CURRENT');
  });
  it('denies a stale proof if disable committed but revoke-all has not run yet', async () => {
    const person = tenants.a.owner;
    await proveSecondFactor(person);
    await authClient.query('update identity.users set two_factor_enabled=false where id=$1', [
      person.userId,
    ]);
    expect(
      (
        await authClient.query('select kind from identity.session_assurances where session_id=$1', [
          person.sessionId,
        ])
      ).rows.length,
    ).toBeGreaterThan(0);
    await expect(
      withTenantTx(application.db, person.context, (tx) =>
        assertRecentMfa(tx, person.context, 'security_policy.change', {
          sessionId: person.sessionId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('serializes a concurrent disable before proof admission and cannot recreate the revoked proof', async () => {
    const person = await makePerson('proof-race');
    await authClient.query('update identity.users set two_factor_enabled=true where id=$1', [
      person.userId,
    ]);
    const label = `mfa-proof-${randomUUID()}`,
      writing = new pg.Client({ connectionString: urls.auth() });
    await writing.connect();
    await writing.query("select set_config('application_name',$1,false)", [label]);
    await authClient.query('begin');
    await authClient.query('update identity.users set two_factor_enabled=false where id=$1', [
      person.userId,
    ]);
    const attempt = recordSessionAssurance(
      drizzle(writing, { casing: 'snake_case' }) as unknown as Parameters<
        typeof recordSessionAssurance
      >[0],
      { ...person, kind: 'mfa_totp' },
    ).then(
      () => null,
      (error) => error as Error,
    );
    try {
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked =
          (
            await authClient.query(
              "select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
              [label],
            )
          ).rows.length > 0;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      await authClient.query('commit');
      expect((await attempt)?.message).toBe('MFA_PROOF_NOT_CURRENT');
      expect(
        (
          await authClient.query(
            'select kind from identity.session_assurances where session_id=$1',
            [person.sessionId],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await authClient.query('rollback');
      await writing.end();
    }
  });
});

describe('pinned Better Auth factor routing, enrollment and actual code verification', () => {
  const secret = `generated-mfa-auth-${randomUUID()}-${randomUUID()}`;
  const runtime = createAuth({
    databaseUrl: urls.auth(),
    secret,
    baseURL: 'http://127.0.0.1:3997',
    allowSignup: true,
  });
  const driver = new pg.Client({ connectionString: urls.auth() });
  const authority = openAuthDatabase(urls.auth());
  const privateCore = privateFactorRouter(authority.db, secret, 'http://127.0.0.1:3997');
  beforeAll(() => driver.connect());
  afterAll(async () => {
    await runtime.close();
    await authority.close();
    await driver.end();
  });
  let client = 1;
  const incoming = (cookie = '') =>
    new Headers({
      cookie,
      'x-forwarded-for': `192.0.${Math.floor(client / 250)}.${(client++ % 250) + 1}`,
      'user-agent': 'Generated MFA conformance',
    });
  const cookies = fixtureCookies;
  async function account() {
    const email = `${randomUUID()}@example.invalid`,
      password = `Generated-password-${randomUUID()}`;
    const signed = await runtime.submitCredentials(
      { path: '/sign-up/email', body: { email, password, name: 'Generated factor holder' } },
      incoming(),
    );
    expect(signed.outcome).toBe('accepted');
    const headers = incoming(cookies(signed.setCookie)),
      current = await runtime.auth.api.getSession({ headers });
    expect(current).toBeTruthy();
    return {
      email,
      password,
      headers,
      session: { userId: current!.user.id, sessionId: current!.session.id },
    };
  }
  async function enrolled() {
    const user = await account();
    const setup = await runtime.mfa.enable({ password: user.password }, user.session, user.headers);
    expect(setup.outcome).toBe('verified');
    expect(setup.backupCodes).toHaveLength(10);
    expect(
      (
        await driver.query('select two_factor_enabled from identity.users where id=$1', [
          user.session.userId,
        ])
      ).rows[0]?.two_factor_enabled,
    ).toBe(false);
    const confirmed = await runtime.mfa.confirmEnrollment(
      { code: totpFromUri(setup.totpURI!, Date.now() - 30000) },
      user.session,
      incoming(user.headers.get('cookie')!),
    );
    expect(confirmed.outcome).toBe('verified');
    const headers = incoming(cookies(confirmed.setCookie)),
      session = await runtime.auth.api.getSession({ headers });
    expect(session?.session.id).not.toBe(user.session.sessionId);
    return {
      ...user,
      headers,
      session: { userId: session!.user.id, sessionId: session!.session.id },
      uri: setup.totpURI!,
      backupCodes: setup.backupCodes!,
    };
  }
  async function noCredential() {
    const user = await account(),
      providerId = `generated-primary-${randomUUID()}`,
      subject = randomUUID();
    await driver.query(
      "delete from identity.accounts where user_id=$1 and provider_id='credential'",
      [user.session.userId],
    );
    await driver.query(
      'insert into identity.accounts(id,user_id,account_id,provider_id) values($1,$2,$3,$4)',
      [randomUUID(), user.session.userId, subject, providerId],
    );
    // Explicit test-only trust/receipt fixture. Real signed-token validation has its own OIDC suite.
    const trust = {
      providerId,
      issuer: 'https://generated-primary.example.invalid',
      sourceConfigSha256: createHash('sha256').update(providerId).digest('hex'),
    };
    const gate = createPrimaryAuthentication(
      authority.db,
      secret,
      providerId,
      undefined,
      async () => trust,
    );
    const primary = {
      isFresh: gate.isFresh,
      record: (input: typeof user.session & { authenticatedAt?: number }, now?: Date) =>
        gate.recordOidc(
          {
            ...input,
            ...trust,
            subject,
            authenticatedAt: input.authenticatedAt ?? null,
            tokenSha256: createHash('sha256')
              .update(`generated-id-token:${providerId}`)
              .digest('hex'),
          },
          now,
        ),
    };
    const operations = (provider: string | null = providerId) => {
      const gate = createPrimaryAuthentication(
        authority.db,
        secret,
        provider ?? undefined,
        undefined,
        async () => (provider === providerId ? trust : null),
      );
      return createMfaOperations({
        baseURL: 'http://127.0.0.1:3997',
        enrollmentState: (userId) => readMfaEnrollmentState(authority.db, userId),
        handler: (request) => privateCore.handler(request),
        managementHandler: (request) => privateCore.handler(request),
        admit: createMfaAdmission(authority.db, secret),
        record: (input) => recordSessionAssurance(authority.db, input),
        reserveAttempt: (userId) => reserveMfaAttempt(authority.db, userId, MFA_ACCOUNT_LOCKOUT),
        revoke: (userId) => revokeSessionAssurances(authority.db, userId),
        prepareEnrollment: (input) => gate.prepareEnrollment(input),
        recordEnrollment: (input, candidate) => gate.recordEnrollment(input, candidate),
        enrollmentCurrent: (input) => gate.enrollmentCurrent(input),
        enrollmentCurrentAfterRotation: (input) => gate.enrollmentCurrentAfterRotation(input),
        completePrimaryAfterFactor: async () => true,
      });
    };
    return { ...user, providerId, primary, operations };
  }
  it('withholds a confirmed rotated session and proof when the credential changes during confirmation', async () => {
    const user = await account(),
      setup = await runtime.mfa.enable({ password: user.password }, user.session, user.headers);
    expect(setup.outcome).toBe('verified');
    const gate = createPrimaryAuthentication(authority.db, secret, undefined);
    let reached!: () => void, release!: () => void;
    const barrier = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      unblock = new Promise<void>((resolve) => {
        release = resolve;
      });
    const operations = createMfaOperations({
      baseURL: 'http://127.0.0.1:3997',
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
      user.session,
      user.headers,
    );
    try {
      await Promise.race([
        barrier,
        pending.then(() => {
          throw new Error('GENERATED_CONFIRMATION_DID_NOT_REACH_BARRIER');
        }),
      ]);
      await driver.query(
        "update identity.accounts set password=$1 where user_id=$2 and provider_id='credential'",
        [
          await fixturePasswordHash(`Changed-generated-password-${randomUUID()}`),
          user.session.userId,
        ],
      );
      release();
      expect(await pending).toMatchObject({ outcome: 'primary_required', setCookie: null });
      expect(
        (
          await driver.query(
            "select kind from identity.session_assurances where user_id=$1 and kind in ('mfa_totp','mfa_backup_code')",
            [user.session.userId],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      release();
      await pending.catch(() => {});
    }
  });
  it('keeps unconfirmed enrollment off, rotates on confirmation, and writes the actual resulting session proof', async () => {
    const user = await enrolled();
    expect(
      (
        await driver.query(
          'select session_id,kind from identity.session_assurances where user_id=$1',
          [user.session.userId],
        )
      ).rows,
    ).toEqual([{ session_id: user.session.sessionId, kind: 'mfa_totp' }]);
    const stored = (
      await driver.query('select secret,backup_codes from identity.two_factors where user_id=$1', [
        user.session.userId,
      ])
    ).rows[0];
    expect(stored.secret).not.toContain(new URL(user.uri).searchParams.get('secret'));
    expect(stored.backup_codes).not.toContain(user.backupCodes[0]);
  });
  it('admits one concurrent initial setup and preserves its actual key through later pending/already-enrolled refusals', async () => {
    const user = await account();
    const setup = await Promise.all(
      Array.from({ length: 6 }, () =>
        runtime.mfa.enable(
          { password: user.password },
          user.session,
          incoming(user.headers.get('cookie')!),
        ),
      ),
    );
    const winners = setup.filter((result) => result.outcome === 'verified');
    expect(winners).toHaveLength(1);
    expect(setup.filter((result) => result.outcome === 'setup_conflict')).toHaveLength(5);
    for (const loser of setup.filter((result) => result.outcome !== 'verified')) {
      expect(loser.totpURI).toBeUndefined();
      expect(loser.backupCodes).toBeUndefined();
    }
    const rows = (
      await driver.query('select secret,backup_codes from identity.two_factors where user_id=$1', [
        user.session.userId,
      ])
    ).rows;
    expect(rows).toHaveLength(1);
    const first = rows[0];
    expect(
      (
        await runtime.mfa.enable(
          { password: user.password },
          user.session,
          incoming(user.headers.get('cookie')!),
        )
      ).outcome,
    ).toBe('setup_conflict');
    expect(
      (
        await driver.query(
          'select secret,backup_codes from identity.two_factors where user_id=$1',
          [user.session.userId],
        )
      ).rows,
    ).toEqual([first]);
    const confirmed = await runtime.mfa.confirmEnrollment(
      { code: totpFromUri(winners[0]!.totpURI!, Date.now() - 30000) },
      user.session,
      incoming(user.headers.get('cookie')!),
    );
    expect(confirmed.outcome).toBe('verified');
    const headers = incoming(cookies(confirmed.setCookie)),
      current = await runtime.auth.api.getSession({ headers });
    const identity = { userId: current!.user.id, sessionId: current!.session.id };
    expect(
      (
        await runtime.mfa.enable(
          { password: user.password },
          identity,
          incoming(headers.get('cookie')!),
        )
      ).outcome,
    ).toBe('already_enrolled');
    expect(
      (
        await driver.query('select secret from identity.two_factors where user_id=$1', [
          user.session.userId,
        ])
      ).rows,
    ).toEqual([{ secret: first.secret }]);
    const regenerated = await runtime.mfa.regenerateBackupCodes(
      { password: user.password, kind: 'backup_code', code: winners[0]!.backupCodes![0]! },
      identity,
      incoming(headers.get('cookie')!),
    );
    expect(regenerated.outcome).toBe('verified');
    expect(regenerated.backupCodes).toHaveLength(10);
    expect(
      (
        await driver.query('select secret from identity.two_factors where user_id=$1', [
          user.session.userId,
        ])
      ).rows,
    ).toEqual([{ secret: first.secret }]);
  });
  it('stops0402 with a sanitized review-required error when existing duplicates need operator review', async () => {
    const user = await account(),
      control = new pg.Client({ connectionString: urls.superuser() });
    await control.connect();
    const marker = `generated-secret-${randomUUID()}`;
    try {
      await control.query('begin');
      await control.query('set local role ensemus_migrator');
      // Rehearse the prior index inside a rollback-only transaction; production data is not chosen,
      // rewritten or deleted by this migration. All duplicate values are generated test fixtures.
      await control.query('drop index identity.two_factors_one_per_user');
      await control.query('create index two_factors_user_idx on identity.two_factors(user_id)');
      await control.query('set local role ensemus_auth');
      await control.query(
        'insert into identity.two_factors(id,user_id,secret,backup_codes,verified) values($1,$2,$3,$4,false),($5,$2,$6,$4,false)',
        [
          randomUUID(),
          user.session.userId,
          marker,
          'generated-encrypted-backup-fixture',
          randomUUID(),
          `${marker}-other`,
        ],
      );
      await control.query('set local role ensemus_migrator');
      const migration = readFileSync(
        new URL(
          '../../packages/database/migrations/0402_second_factor_uniqueness.sql',
          import.meta.url,
        ),
        'utf8',
      );
      let refusal: unknown;
      try {
        await control.query(migration);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        code: 'EN402',
        message: 'SECOND_FACTOR_DUPLICATES_REVIEW_REQUIRED',
      });
      expect(String(refusal)).not.toContain(user.session.userId);
      expect(String(refusal)).not.toContain(marker);
    } finally {
      await control.query('rollback');
      await control.end();
    }
    expect(
      (
        await driver.query('select user_id from identity.two_factors where user_id=$1', [
          user.session.userId,
        ])
      ).rows,
    ).toEqual([]);
  });
  it('keeps the password mandatory for a credential account even when the UI field is optional', async () => {
    const user = await account();
    expect((await runtime.mfa.enable({ password: '' }, user.session, user.headers)).outcome).toBe(
      'refused',
    );
    expect(
      (
        await driver.query('select user_id from identity.two_factors where user_id=$1', [
          user.session.userId,
        ])
      ).rows,
    ).toEqual([]);
  });
  it('does not promote an unknown provider authentication time or callback time into recent primary authority', async () => {
    const user = await noCredential();
    await user.primary.record(user.session);
    expect(await user.primary.isFresh({ ...user.session, maxAgeSeconds: 900 })).toBe(false);
    expect(
      (await user.operations().enable({ password: '' }, user.session, user.headers)).outcome,
    ).toBe('primary_required');
    await user.primary.record({ ...user.session, authenticatedAt: Date.now() + 120000 });
    expect(await user.primary.isFresh({ ...user.session, maxAgeSeconds: 900 })).toBe(false);
  });
  it('enrolls an actual no-credential account only after a trusted current primary receipt (explicit provider boundary fixture)', async () => {
    const user = await noCredential(),
      mfa = user.operations();
    expect(
      (await mfa.enable({ password: '', maxAgeSeconds: 60 }, user.session, user.headers)).outcome,
    ).toBe('primary_required');
    // This is the explicit auth-role boundary fixture, not evidence of a hosted provider assertion.
    // The pinned OIDC adapter exposes no validated auth_time to its callback, so runtime bootstrap
    // stays closed. Only this explicit trusted auth-role fixture supplies generated signed time.
    await user.primary.record({ ...user.session, authenticatedAt: Date.now() });
    const setup = await mfa.enable(
      { password: '', maxAgeSeconds: 60 },
      user.session,
      incoming(user.headers.get('cookie')!),
    );
    expect(setup.outcome).toBe('verified');
    const confirmation = await mfa.confirmEnrollment(
      { code: totpFromUri(setup.totpURI!, Date.now() - 30000), maxAgeSeconds: 60 },
      user.session,
      incoming(user.headers.get('cookie')!),
    );
    expect(confirmation.outcome).toBe('verified');
  });
  it('does not treat a young/rotated session or a repeated old receipt as fresh primary authentication', async () => {
    const user = await noCredential();
    await user.primary.record({ ...user.session, authenticatedAt: Date.now() - 120000 });
    await user.primary.record({ ...user.session, authenticatedAt: Date.now() });
    expect(await user.primary.isFresh({ ...user.session, maxAgeSeconds: 60 })).toBe(false);
    expect(await user.primary.isFresh({ ...user.session, maxAgeSeconds: 900 })).toBe(true);
    const rotated = randomUUID();
    await driver.query(
      "insert into identity.sessions(id,user_id,token,expires_at) values($1,$2,$3,now()+interval '1 hour')",
      [rotated, user.session.userId, randomUUID()],
    );
    expect(
      await user.primary.isFresh({
        sessionId: rotated,
        userId: user.session.userId,
        maxAgeSeconds: 900,
      }),
    ).toBe(false);
  });
  it('refuses revoked provider/account/session enrollment and rechecks the provider before confirming a pending factor', async () => {
    const user = await noCredential();
    await user.primary.record({ ...user.session, authenticatedAt: Date.now() });
    expect(
      (await user.operations(null).enable({ password: '' }, user.session, user.headers)).outcome,
    ).toBe('primary_required');
    const setup = await user
      .operations()
      .enable({ password: '' }, user.session, incoming(user.headers.get('cookie')!));
    expect(setup.outcome).toBe('verified');
    await driver.query('delete from identity.accounts where user_id=$1 and provider_id=$2', [
      user.session.userId,
      user.providerId,
    ]);
    expect(
      (
        await user
          .operations()
          .confirmEnrollment(
            { code: totpFromUri(setup.totpURI!) },
            user.session,
            incoming(user.headers.get('cookie')!),
          )
      ).outcome,
    ).toBe('primary_required');
    expect(
      (
        await driver.query('select two_factor_enabled from identity.users where id=$1', [
          user.session.userId,
        ])
      ).rows[0].two_factor_enabled,
    ).toBe(false);
    await driver.query('delete from identity.sessions where id=$1', [user.session.sessionId]);
    expect(await user.primary.isFresh({ ...user.session, maxAgeSeconds: 900 })).toBe(false);
  });
  it('closes every raw public factor-management and verification route', async () => {
    const user = await enrolled();
    for (const path of [
      '/enable',
      '/disable',
      '/generate-backup-codes',
      '/view-backup-codes',
      '/get-totp-uri',
      '/verify-totp',
      '/verify-backup-code',
    ]) {
      const response = await runtime.auth.handler(
        new Request(`http://127.0.0.1:3997/api/auth/two-factor${path}`, {
          method: 'POST',
          headers: new Headers({
            ...Object.fromEntries(user.headers),
            origin: 'http://127.0.0.1:3997',
            'content-type': 'application/json',
          }),
          body: JSON.stringify({
            password: user.password,
            code: totpFromUri(user.uri),
            userId: user.session.userId,
          }),
        }),
      );
      expect(response.status, path).toBe(404);
    }
  });
  it('requires a challenge code after password sign-in, forwards its cookie only after durable proof, and refuses replay', async () => {
    const user = await enrolled();
    const signIn = await runtime.submitCredentials(
      { path: '/sign-in/email', body: { email: user.email, password: user.password } },
      incoming(),
    );
    expect(signIn.outcome).toBe('two_factor');
    const challenge = incoming(cookies(signIn.setCookie));
    expect(await runtime.auth.api.getSession({ headers: challenge })).toBeNull();
    const code = totpFromUri(user.uri);
    const accepted = await runtime.mfa.completeSignIn({ kind: 'totp', code }, challenge);
    expect(accepted.outcome).toBe('verified');
    const headers = incoming(cookies(accepted.setCookie)),
      current = await runtime.auth.api.getSession({ headers });
    expect(current).toBeTruthy();
    expect(
      await runtime.mfa.verifyStepUp(
        { kind: 'totp', code },
        { userId: current!.user.id, sessionId: current!.session.id },
        headers,
      ),
    ).toBe('refused');
    expect(
      (
        await driver.query('select kind from identity.session_assurances where session_id=$1', [
          current!.session.id,
        ])
      ).rows,
    ).toEqual([{ kind: 'mfa_totp' }]);
  });
  it('consumes a recovery code once and factor removal revokes every MFA assurance', async () => {
    const user = await enrolled();
    const code = user.backupCodes[0]!;
    expect(
      await runtime.mfa.verifyStepUp(
        { kind: 'backup_code', code },
        user.session,
        incoming(user.headers.get('cookie')!),
      ),
    ).toBe('verified');
    expect(
      await runtime.mfa.verifyStepUp(
        { kind: 'backup_code', code },
        user.session,
        incoming(user.headers.get('cookie')!),
      ),
    ).toBe('refused');
    const removed = await runtime.mfa.disable(
      { password: user.password, kind: 'backup_code', code: user.backupCodes[1]! },
      user.session,
      incoming(user.headers.get('cookie')!),
    );
    expect(removed.outcome).toBe('verified');
    expect(
      (
        await driver.query(
          "select kind from identity.session_assurances where user_id=$1 and kind like 'mfa_%'",
          [user.session.userId],
        )
      ).rows,
    ).toEqual([]);
  });
  it('cannot revive another session old-factor proof after a disable crash and later re-enrollment', async () => {
    const user = await enrolled(),
      otherSession = randomUUID();
    await driver.query(
      "insert into identity.sessions(id,user_id,token,expires_at) values($1,$2,$3,now()+interval '1 hour')",
      [otherSession, user.session.userId, randomUUID()],
    );
    await recordSessionAssurance(authority.db, {
      sessionId: otherSession,
      userId: user.session.userId,
      kind: 'mfa_totp',
    });
    // Exact crash shape: flag/factor are gone, revoke-all never ran, other session still exists.
    await driver.query('update identity.users set two_factor_enabled=false where id=$1', [
      user.session.userId,
    ]);
    await driver.query('delete from identity.two_factors where user_id=$1', [user.session.userId]);
    const setup = await runtime.mfa.enable(
      { password: user.password },
      user.session,
      incoming(user.headers.get('cookie')!),
    );
    expect(setup.outcome).toBe('verified');
    const oldCodes = new Set(
      [-1, 0, 1].map((offset) => totpFromUri(user.uri, Date.now() + offset * 30000)),
    );
    const freshCode = [-1, 0, 1]
      .map((offset) => totpFromUri(setup.totpURI!, Date.now() + offset * 30000))
      .find((value) => !oldCodes.has(value))!;
    expect(
      (
        await runtime.mfa.confirmEnrollment(
          { code: freshCode },
          user.session,
          incoming(user.headers.get('cookie')!),
        )
      ).outcome,
    ).toBe('verified');
    expect(
      (
        await driver.query('select kind from identity.session_assurances where session_id=$1', [
          otherSession,
        ])
      ).rows,
    ).toEqual([]);
  });
  it('atomically reserves only the native account budget across replicas and resets it only with an admitted proof', async () => {
    const user = await enrolled();
    const attempts = await Promise.all(
      Array.from({ length: 24 }, () =>
        reserveMfaAttempt(authority.db, user.session.userId, MFA_ACCOUNT_LOCKOUT),
      ),
    );
    expect(attempts.filter((attempt) => attempt.outcome === 'reserved')).toHaveLength(
      MFA_ACCOUNT_LOCKOUT.maxFailedAttempts,
    );
    expect(attempts.filter((attempt) => attempt.outcome === 'locked')).toHaveLength(
      24 - MFA_ACCOUNT_LOCKOUT.maxFailedAttempts,
    );
    expect(
      await runtime.mfa.verifyStepUp(
        { kind: 'totp', code: totpFromUri(user.uri) },
        user.session,
        incoming(user.headers.get('cookie')!),
      ),
    ).toBe('rate_limited');
    const [locked] = (
      await driver.query(
        'select failed_verification_count,locked_until from identity.two_factors where user_id=$1',
        [user.session.userId],
      )
    ).rows;
    expect(locked.failed_verification_count).toBe(10);
    expect(new Date(locked.locked_until).getTime()).toBeGreaterThan(Date.now());
    await driver.query(
      "update identity.two_factors set locked_until=now()-interval '1 second' where user_id=$1",
      [user.session.userId],
    );
    expect(
      await runtime.mfa.verifyStepUp(
        { kind: 'totp', code: totpFromUri(user.uri) },
        user.session,
        incoming(user.headers.get('cookie')!),
      ),
    ).toBe('verified');
    expect(
      (
        await driver.query(
          'select failed_verification_count,locked_until from identity.two_factors where user_id=$1',
          [user.session.userId],
        )
      ).rows,
    ).toEqual([{ failed_verification_count: 0, locked_until: null }]);
  });
  it('meters concurrent bad signed-in codes across client addresses without minting or resetting proof', async () => {
    const user = await enrolled(),
      valid = new Set(
        [-1, 0, 1].map((offset) => totpFromUri(user.uri, Date.now() + offset * 30000)),
      );
    let wrong = '000000';
    while (valid.has(wrong)) wrong = String(Number(wrong) + 1).padStart(6, '0');
    const before = (
      await driver.query(
        'select verified_at from identity.session_assurances where session_id=$1',
        [user.session.sessionId],
      )
    ).rows[0].verified_at;
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, () =>
        runtime.mfa.verifyStepUp(
          { kind: 'totp', code: wrong },
          user.session,
          incoming(user.headers.get('cookie')!),
        ),
      ),
    );
    expect(outcomes.every((outcome) => outcome === 'refused' || outcome === 'rate_limited')).toBe(
      true,
    );
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(10);
    expect(
      (
        await driver.query(
          'select failed_verification_count from identity.two_factors where user_id=$1',
          [user.session.userId],
        )
      ).rows[0].failed_verification_count,
    ).toBe(10);
    expect(
      (
        await driver.query(
          'select verified_at from identity.session_assurances where session_id=$1',
          [user.session.sessionId],
        )
      ).rows[0].verified_at,
    ).toEqual(before);
  });
  it('locks an account after repeated bad sign-in codes even across changing client addresses', async () => {
    const user = await enrolled();
    const valid = new Set(
      [-1, 0, 1].map((offset) => totpFromUri(user.uri, Date.now() + offset * 30000)),
    );
    let wrong = '000000';
    while (valid.has(wrong)) wrong = String(Number(wrong) + 1).padStart(6, '0');
    for (let attempt = 0; attempt < 10; attempt++) {
      const signIn = await runtime.submitCredentials(
        { path: '/sign-in/email', body: { email: user.email, password: user.password } },
        incoming(),
      );
      expect(signIn.outcome).toBe('two_factor');
      expect(
        (
          await runtime.mfa.completeSignIn(
            { kind: 'totp', code: wrong },
            incoming(cookies(signIn.setCookie)),
          )
        ).outcome,
      ).toBe('refused');
    }
    const signIn = await runtime.submitCredentials(
      { path: '/sign-in/email', body: { email: user.email, password: user.password } },
      incoming(),
    );
    expect(
      (
        await runtime.mfa.completeSignIn(
          { kind: 'totp', code: totpFromUri(user.uri) },
          incoming(cookies(signIn.setCookie)),
        )
      ).outcome,
    ).toBe('rate_limited');
    const [factor] = (
      await driver.query(
        'select failed_verification_count,locked_until from identity.two_factors where user_id=$1',
        [user.session.userId],
      )
    ).rows;
    expect(factor.failed_verification_count).toBeGreaterThanOrEqual(10);
    expect(new Date(factor.locked_until).getTime()).toBeGreaterThan(Date.now());
  });
});
