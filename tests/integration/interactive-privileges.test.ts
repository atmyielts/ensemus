// 0404: native identity provenance and actual transaction-time authority, generated identities only.
// These are real-role regression SOURCES until the joined migration/integration gate executes them.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createAuth } from '@ensemus/auth';
import {
  acceptInvitation,
  confirmInvitation,
  createInvitation,
  createTeam,
} from '@ensemus/application';
import {
  agentSpecSha256,
  DEFAULT_AGENT_POLICY_VERSION,
  publishAgentVersion,
} from '@ensemus/application/ai-agents';
import {
  createModelProfile,
  disableModelProfile,
  requestModelProbe,
  updateModelProfile,
} from '@ensemus/application/ai-model-profiles';
import { loadProfileForProbe } from '@ensemus/application/ai-model-probe-store';
import {
  assertInteractivePrivilege,
  assertRecentMfa,
  withPrivilegeTx,
} from '@ensemus/application/privileged';
import { updateSecurityPolicy } from '@ensemus/application/security-policy';
import {
  agentSpecV1Schema,
  type CreateModelProfile,
  type EvaluationReport,
} from '@ensemus/contracts/ai';
import {
  createOrganization,
  interactiveSessionOf,
  memberships,
  modelProfiles,
  openAppDatabase,
  resolveInteractiveTenantContext,
  resolveTenantContext,
  teams,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { openAgentDatabase } from '@ensemus/database/agent';
import { createServiceContext } from '@ensemus/database/service';
import { fixtureCookies } from '../../packages/auth/test-support/mfa-router';
import { makePerson, nativePersonContext, proveSecondFactor } from '../helpers/product';
import { testAgentSpec } from '../helpers/ai/fixtures';
import { totpFromUri } from '../helpers/totp';
import { urls } from '../helpers/stack';

const privateOrigin = 'http://generated-model.example.invalid:8080';
const settings = { privateEndpoints: [privateOrigin] };
const localProfile = (): CreateModelProfile => ({
  provider_kind: 'local_openai_compatible',
  model_id: 'generated-mfa-probe',
  alias: `generated-${randomUUID()}`,
  endpoint_url: `${privateOrigin}/v1`,
  billing_owner: 'customer',
  region: null,
  capabilities: ['text'],
  limits: { max_input_tokens: 4096, max_output_tokens: 256 },
  allowed_classes: ['public', 'internal'],
  allowed_purposes: ['reason'],
  retention_basis: 'self_hosted',
  contract_ref: null,
  fallback_profile_ids: [],
});
type Person = { userId: string; sessionId: string; organizationId: string; context: TenantContext };

describe('interactive privilege authority inside the actual effect transaction', () => {
  const app = openAppDatabase(urls.app(), { max: 3 }),
    agent = openAgentDatabase(urls.agent(), { max: 1 });
  const auth = new pg.Client({ connectionString: urls.auth() }),
    observer = new pg.Client({ connectionString: urls.superuser() });
  beforeAll(async () => {
    await auth.connect();
    await observer.connect();
  });
  afterAll(async () => {
    await app.close();
    await agent.close();
    await auth.end();
    await observer.end();
  });
  async function fresh(proved = true, administration = false): Promise<Person> {
    const person = await makePerson('interactive-owner');
    const { organizationId } = await createOrganization(app.db, {
      userId: person.userId,
      name: 'Generated interactive tenant',
      commercialMode: 'byom',
    });
    const context = await nativePersonContext(app.db, person, organizationId);
    if (proved) await proveSecondFactor(person);
    const owner = { ...person, organizationId, context };
    if (administration) await enableAdministration(owner);
    return owner;
  }
  function enableAdministration(person: Person) {
    return updateSecurityPolicy(
      app.db,
      person.context,
      { sessionId: person.sessionId },
      {
        expectedVersion: 1,
        mfaForAdministration: true,
        mfaMaxAgeSeconds: 600,
        ssoEnforcement: 'optional',
      },
    );
  }
  const draft = (person: Person) =>
    createModelProfile(app.db, person.context, localProfile(), settings);
  const probe = (person: Person, id: string) =>
    requestModelProbe(app.db, person.context, { profileId: id, expectedVersion: 1 });
  const readProfile = (person: Person, id: string) =>
    withTenantTx(
      app.db,
      person.context,
      async (tx) => (await tx.select().from(modelProfiles).where(eq(modelProfiles.id, id)))[0]!,
    );
  const modelInput = (person: Person, id: string) => ({
    organizationId: person.organizationId,
    profileId: id,
  });
  const reportFor = (spec: unknown): EvaluationReport => ({
    report_version: 1,
    spec_sha256: agentSpecSha256(agentSpecV1Schema.parse(spec)),
    policy_version: DEFAULT_AGENT_POLICY_VERSION,
    suite_ref: 'evaluations/agents/work-brief',
    dataset_version: 'generated-mfa-regression',
    model_label: 'scripted',
    pass_rate: 1,
    cases: 3,
    passed: true,
    scripted_model: true,
  });
  async function waitBlockedBy(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = await observer.query<{ blocked: boolean }>(
        "select exists(select 1 from pg_stat_activity where usename='ensemus_app' and $1=any(pg_blocking_pids(pid))) as blocked",
        [pid],
      );
      if (found.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('TEST_EXPECTED_ACTUAL_DATABASE_LOCK_WAIT');
  }

  it('installs the fixed guard under the non-bypassing migrator without auth-role membership', async () => {
    const result = await observer.query<{
      owner: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      auth_member: boolean;
      prosecdef: boolean;
      proconfig: string[];
    }>(`select r.rolname as owner,r.rolsuper,r.rolbypassrls,p.prosecdef,p.proconfig,
      pg_has_role(r.oid,'ensemus_auth','member') as auth_member
      from pg_proc p join pg_roles r on r.oid=p.proowner
      where p.oid='identity.lock_recent_interactive_mfa(uuid,uuid,integer)'::regprocedure`);
    expect(result.rows[0]).toMatchObject({
      owner: 'ensemus_migrator',
      rolsuper: false,
      rolbypassrls: false,
      auth_member: false,
      prosecdef: true,
    });
    expect(result.rows[0]?.proconfig).toContain('search_path=pg_catalog');
  });

  it('uses actual password sign-up, factor verification and rotated native session for probe admission', async () => {
    const runtime = createAuth({
      databaseUrl: urls.auth(),
      secret: `generated-native-${randomUUID()}-${randomUUID()}`,
      baseURL: 'http://127.0.0.1:3995',
      allowSignup: true,
    });
    try {
      const email = `${randomUUID()}@example.invalid`,
        password = `Generated-password-${randomUUID()}`;
      const signed = await runtime.submitCredentials(
        { path: '/sign-up/email', body: { email, password, name: 'Generated native owner' } },
        new Headers({ 'x-forwarded-for': '192.0.2.95' }),
      );
      expect(signed.outcome).toBe('accepted');
      const headers = new Headers({ cookie: fixtureCookies(signed.setCookie) }),
        initial = await runtime.readInteractiveSession(headers);
      expect(initial).toBeTruthy();
      const session = { userId: initial!.user.id, sessionId: initial!.session.id };
      const setup = await runtime.mfa.enable({ password }, session, headers);
      expect(setup.outcome).toBe('verified');
      const confirmed = await runtime.mfa.confirmEnrollment(
        { code: totpFromUri(setup.totpURI!, Date.now() - 30000) },
        session,
        headers,
      );
      expect(confirmed.outcome).toBe('verified');
      const current = await runtime.readInteractiveSession(
        new Headers({ cookie: fixtureCookies(confirmed.setCookie) }),
      );
      expect(current?.session.id).not.toBe(session.sessionId);
      const { organizationId } = await createOrganization(app.db, {
        userId: session.userId,
        name: 'Native factor holder',
        commercialMode: 'byom',
      });
      const context = await resolveInteractiveTenantContext(
          app.db,
          current!.identity,
          organizationId,
        ),
        person = {
          userId: session.userId,
          sessionId: current!.session.id,
          organizationId,
          context,
        };
      const profile = await draft(person);
      await probe(person, profile.id);
      expect(await readProfile(person, profile.id)).toMatchObject({
        status: 'probing',
        probeAuthorizedProfileVersion: 1,
        probeAuthorizedMembershipId: context.membershipId,
        probeAuthorizedSessionId: current!.session.id,
      });
      expect(await loadProfileForProbe(agent.db, modelInput(person, profile.id))).toBeTruthy();
    } finally {
      await runtime.close();
    }
  });

  it('preserves default administration access without requiring a new factor', async () => {
    const owner = await fresh(false),
      plain = await resolveTenantContext(app.db, owner.userId, owner.organizationId);
    expect(await createTeam(app.db, plain, { name: 'Default policy team' })).toMatchObject({
      organizationId: owner.organizationId,
    });
  });
  it('requires MFA on opted-in administration and leaves no partial team', async () => {
    const owner = await fresh(true, true);
    await auth.query('delete from identity.session_assurances where session_id=$1', [
      owner.sessionId,
    ]);
    const name = `denied-team-${randomUUID()}`;
    await expect(createTeam(app.db, owner.context, { name })).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
    const rows = await withTenantTx(app.db, owner.context, (tx) =>
      tx.select().from(teams).where(eq(teams.name, name)),
    );
    expect(rows).toHaveLength(0);
  });
  it('always requires a native MFA proof for publication despite default administration being off', async () => {
    const owner = await fresh(false),
      spec = testAgentSpec({ id: `mfa-${randomUUID().slice(0, 8)}` }),
      input = {
        spec,
        evaluationReport: reportFor(spec),
        policyVersion: DEFAULT_AGENT_POLICY_VERSION,
      };
    await expect(publishAgentVersion(app.db, owner.context, input)).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
    await proveSecondFactor(owner);
    expect(await publishAgentVersion(app.db, owner.context, input)).toMatchObject({
      version_number: 1,
    });
  });
  it('refuses a readable session UUID on a plain context even when that session proved MFA', async () => {
    const owner = await fresh(),
      plain = await resolveTenantContext(app.db, owner.userId, owner.organizationId);
    await expect(
      withTenantTx(app.db, plain, (tx) =>
        assertRecentMfa(tx, plain, 'agent.publish', { sessionId: owner.sessionId }),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('refuses another proved session of the same account', async () => {
    const owner = await fresh(),
      second = randomUUID();
    await auth.query(
      "insert into identity.sessions(id,user_id,token,expires_at) values($1,$2,$3,clock_timestamp()+interval '1 hour')",
      [second, owner.userId, randomUUID()],
    );
    await proveSecondFactor({ ...owner, sessionId: second });
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        assertRecentMfa(tx, owner.context, 'agent.publish', { sessionId: second }),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('refuses a foreign account session and a tenant with no current membership', async () => {
    const owner = await fresh(),
      other = await fresh();
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        assertRecentMfa(tx, owner.context, 'agent.publish', { sessionId: other.sessionId }),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await expect(nativePersonContext(app.db, owner, other.organizationId)).rejects.toMatchObject({
      name: 'TenantAccessDenied',
    });
  });
  it('rechecks a revoked session despite a cached native context', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await auth.query('delete from identity.sessions where id=$1', [owner.sessionId]);
    await expect(probe(owner, profile.id)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect((await readProfile(owner, profile.id)).status).toBe('draft');
  });
  it('rechecks expiry against the database clock', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await auth.query(
      "update identity.sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [owner.sessionId],
    );
    await expect(probe(owner, profile.id)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('refuses old assurance even if a caller supplies an old Date', async () => {
    const owner = await fresh();
    await proveSecondFactor(owner, new Date(Date.now() - 1000 * 3601));
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        assertRecentMfa(
          tx,
          owner.context,
          'agent.publish',
          { sessionId: owner.sessionId },
          new Date(Date.now() - 1000 * 3601),
        ),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('refuses assurance timestamps in the future', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await proveSecondFactor(owner, new Date(Date.now() + 300_000));
    await expect(probe(owner, profile.id)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('refuses stale proofs after factor disable even before a revoke-all cleanup', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await auth.query('update identity.users set two_factor_enabled=false where id=$1', [
      owner.userId,
    ]);
    await expect(probe(owner, profile.id)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('clears native identity from service, agent and delegated transactions', async () => {
    const owner = await fresh();
    for (const context of [
      createServiceContext(owner.organizationId),
      { ...owner.context, actorType: 'agent' as const, agentRunId: randomUUID() },
      { ...owner.context, actorType: 'delegated' as const },
    ]) {
      expect(interactiveSessionOf(context)).toBeNull();
      expect(
        await withTenantTx(
          app.db,
          context,
          async (tx) =>
            (
              await tx.execute<{ session: string | null }>(
                sql`select app.current_interactive_session_id() as session`,
              )
            ).rows[0]?.session,
        ),
      ).toBeNull();
      await expect(
        withTenantTx(app.db, context, (tx) =>
          assertInteractivePrivilege(tx, context, 'agent.publish'),
        ),
      ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    }
  });
  it('does not transfer native identity when a copied context names a different user', async () => {
    const owner = await fresh(),
      other = await fresh(),
      forged = { ...owner.context, userId: other.userId };
    expect(interactiveSessionOf(forged)).toBeNull();
    await expect(
      withTenantTx(app.db, forged, (tx) => assertInteractivePrivilege(tx, forged, 'agent.publish')),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('cannot turn private guard-scope settings into foreign session authority', async () => {
    const owner = await fresh(),
      other = await fresh();
    const result = await withTenantTx(app.db, owner.context, async (tx) => {
      await tx.execute(
        sql`select set_config('identity.mfa_guard_active','v1',true),set_config('identity.mfa_guard_user',${other.userId},true),set_config('identity.mfa_guard_session',${other.sessionId},true)`,
      );
      const checked = await tx.execute<{ allowed: boolean }>(
        sql`select identity.lock_recent_interactive_mfa(${other.userId}::uuid,${other.sessionId}::uuid,900) as allowed`,
      );
      return checked.rows[0]?.allowed;
    });
    expect(result).toBe(false);
  });
  it('restores private metadata guard scope after a successful check', async () => {
    const owner = await fresh();
    await withTenantTx(app.db, owner.context, async (tx) => {
      await tx.execute(sql`select set_config('identity.mfa_guard_active','original',true)`);
      await assertInteractivePrivilege(tx, owner.context, 'agent.publish');
      expect(
        (
          await tx.execute<{ value: string }>(
            sql`select current_setting('identity.mfa_guard_active',true) as value`,
          )
        ).rows[0]?.value,
      ).toBe('original');
    });
  });
  it('keeps opted-in administrative writes behind the SQL backstop', async () => {
    const owner = await fresh(true, true),
      plain = await resolveTenantContext(app.db, owner.userId, owner.organizationId);
    await expect(
      withTenantTx(app.db, plain, (tx) =>
        tx
          .insert(teams)
          .values({
            organizationId: owner.organizationId,
            name: 'Direct SQL without native identity',
          }),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN405' } });
  });
  it('cannot stamp an admission through application-role UPDATE or INSERT', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        tx.execute(
          sql`update ai.model_profiles set probe_authorized_profile_version=1 where id=${profile.id}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        tx.execute(
          sql`insert into ai.model_profiles select (jsonb_populate_record(null::ai.model_profiles,to_jsonb(p)||jsonb_build_object('id',${randomUUID()}::text,'alias',${randomUUID()}::text,'probe_authorized_profile_version',1,'probe_authorized_membership_id',${owner.context.membershipId}::text,'probe_authorized_session_id',${owner.sessionId}::text,'probe_authorized_at',clock_timestamp()))).* from ai.model_profiles p where p.id=${profile.id}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
  it('does not let an agent connection inherit a person by SET ROLE', async () => {
    const owner = await fresh();
    const result = await withTenantTx(agent.db, owner.context, async (tx) => {
      await tx.execute(sql`set local role ensemus_app`);
      return (
        await tx.execute<{ allowed: boolean }>(
          sql`select app.interactive_privilege_allowed('agent.publish') as allowed`,
        )
      ).rows[0]?.allowed;
    });
    expect(result).toBe(false);
  });
  it('retains only metadata visibility and cannot read tokens, factor secrets or mint assurances', async () => {
    const owner = await fresh();
    for (const query of [
      sql`select token from identity.sessions where id=${owner.sessionId}::uuid`,
      sql`select secret from identity.two_factors where user_id=${owner.userId}::uuid`,
      sql`insert into identity.session_assurances(session_id,kind,user_id,verified_at) values(${owner.sessionId}::uuid,'mfa_totp',${owner.userId}::uuid,clock_timestamp())`,
    ])
      await expect(
        withTenantTx(app.db, owner.context, (tx) => tx.execute(query)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
  it('keeps an admitted exact-version probe usable after actual logout without a session FK', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await probe(owner, profile.id);
    await auth.query('delete from identity.sessions where id=$1', [owner.sessionId]);
    expect(await loadProfileForProbe(agent.db, modelInput(owner, profile.id))).toBeTruthy();
    await expect(probe(owner, profile.id)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('keeps prior probe admission after expiry, without using it as a new person proof', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await probe(owner, profile.id);
    await auth.query(
      "update identity.sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [owner.sessionId],
    );
    expect(await loadProfileForProbe(agent.db, modelInput(owner, profile.id))).toBeTruthy();
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        assertInteractivePrivilege(tx, owner.context, 'model_workload.approve'),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('invalidates pending admission on a configuration/version change', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await probe(owner, profile.id);
    await updateModelProfile(
      app.db,
      owner.context,
      {
        profileId: profile.id,
        patch: { expected_version: 1, model_id: `changed-${randomUUID()}` },
      },
      settings,
    );
    expect(await loadProfileForProbe(agent.db, modelInput(owner, profile.id))).toBeNull();
    expect(await readProfile(owner, profile.id)).toMatchObject({
      version: 2,
      probeAuthorizedProfileVersion: null,
      probeAuthorizedSessionId: null,
    });
  });
  it('invalidates admission on an actual disable', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await probe(owner, profile.id);
    await disableModelProfile(app.db, owner.context, { profileId: profile.id, expectedVersion: 1 });
    expect(await loadProfileForProbe(agent.db, modelInput(owner, profile.id))).toBeNull();
    expect(await readProfile(owner, profile.id)).toMatchObject({
      status: 'disabled',
      probeAuthorizedProfileVersion: null,
      probeAuthorizedSessionId: null,
    });
  });
  it('fails closed on a legacy pending row with unknown admission and allows a real fresh retest', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    await probe(owner, profile.id);
    // A trusted fixture models pre-0404 history. It never marks a model qualified or disables a trigger.
    await observer.query(
      'update ai.model_profiles set probe_authorized_profile_version=null,probe_authorized_membership_id=null,probe_authorized_session_id=null,probe_authorized_at=null where organization_id=$1 and id=$2',
      [owner.organizationId, profile.id],
    );
    expect(await loadProfileForProbe(agent.db, modelInput(owner, profile.id))).toBeNull();
    await probe(owner, profile.id);
    expect(await loadProfileForProbe(agent.db, modelInput(owner, profile.id))).toBeTruthy();
  });
  it('rolls admission back with a failed effect transaction', async () => {
    const owner = await fresh(),
      profile = await draft(owner),
      failure = new Error('TEST_ROLLBACK');
    await expect(
      withPrivilegeTx(app.db, owner.context, async (tx) => {
        await assertInteractivePrivilege(tx, owner.context, 'model_profile.activate');
        await tx
          .update(modelProfiles)
          .set({ status: 'probing', probeRequestedByMembershipId: owner.context.membershipId })
          .where(eq(modelProfiles.id, profile.id));
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await readProfile(owner, profile.id)).toMatchObject({
      status: 'draft',
      probeAuthorizedSessionId: null,
    });
    expect(await loadProfileForProbe(agent.db, modelInput(owner, profile.id))).toBeNull();
  });

  for (const revocation of ['factor disable', 'session expiry', 'proof deletion'] as const) {
    it(`waits for a concurrent ${revocation} and then refuses the protected effect`, async () => {
      const owner = await fresh(),
        profile = await draft(owner),
        blocker = (await auth.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!
          .pid;
      await auth.query('begin');
      let attempted: Promise<{ error: unknown } | { value: void }> | undefined;
      try {
        if (revocation === 'factor disable')
          await auth.query('update identity.users set two_factor_enabled=false where id=$1', [
            owner.userId,
          ]);
        else if (revocation === 'session expiry')
          await auth.query(
            "update identity.sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1",
            [owner.sessionId],
          );
        else
          await auth.query('delete from identity.session_assurances where session_id=$1', [
            owner.sessionId,
          ]);
        attempted = probe(owner, profile.id).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await waitBlockedBy(blocker);
        await auth.query('commit');
        expect(await attempted).toMatchObject({ error: { code: 'MFA_REQUIRED' } });
        expect((await readProfile(owner, profile.id)).status).toBe('draft');
      } finally {
        await auth.query('rollback');
        await attempted;
      }
    });
  }
  it('takes policy serialization through the effect so a concurrent opt-in cannot fall between check and write', async () => {
    const owner = await fresh(),
      plain = await resolveTenantContext(app.db, owner.userId, owner.organizationId);
    let checked!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => {
        checked = resolve;
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    let pid = 0;
    const first = withPrivilegeTx(app.db, plain, async (tx) => {
      await assertInteractivePrivilege(tx, plain, 'member.manage');
      pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      checked();
      await barrier;
      await tx
        .insert(teams)
        .values({ organizationId: owner.organizationId, name: 'Admitted before policy changed' });
    });
    await Promise.race([reached, first]);
    const second = enableAdministration(owner).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await waitBlockedBy(pid);
    } finally {
      release();
    }
    await first;
    expect(await second).toMatchObject({ value: { mfaForAdministration: true } });
    await expect(
      createTeam(app.db, plain, { name: 'Attempt after policy changed' }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('rechecks current membership instead of the role cached with a native session', async () => {
    const owner = await fresh(),
      profile = await draft(owner);
    // Trusted fixture changes membership state to model an already-committed revocation.
    await observer.query(
      "update org.memberships set status='disabled' where organization_id=$1 and id=$2",
      [owner.organizationId, owner.context.membershipId],
    );
    await expect(probe(owner, profile.id)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
  it('keeps the last-owner SQL backstop on a direct human write', async () => {
    const owner = await fresh(false);
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        tx
          .update(memberships)
          .set({ role: 'member' })
          .where(eq(memberships.id, owner.context.membershipId)),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN001' } });
  });
  it('preserves verified-recipient durable invitation acceptance after administration opts in', async () => {
    const owner = await fresh(true, true),
      recipient = await makePerson('invited-without-mfa');
    const result = await auth.query<{ email: string }>(
      'update identity.users set email_verified=true where id=$1 returning email',
      [recipient.userId],
    );
    const invitation = await createInvitation(app.db, owner.context, {
      email: result.rows[0]!.email,
      role: 'member',
    });
    expect(
      await acceptInvitation(app.db, {
        token: invitation.token,
        userId: recipient.userId,
        email: result.rows[0]!.email,
        emailVerified: true,
      }),
    ).toEqual({ status: 'joined', organizationId: owner.organizationId });
    expect((await resolveTenantContext(app.db, recipient.userId, owner.organizationId)).role).toBe(
      'member',
    );
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        tx.execute(
          sql`update org.invitations set accepted_at=clock_timestamp() where id=${invitation.id}::uuid`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      acceptInvitation(app.db, {
        token: invitation.token,
        userId: recipient.userId,
        email: result.rows[0]!.email,
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  });
  it('preserves unverified-recipient claims and requires the manager own current proof to confirm', async () => {
    const owner = await fresh(true, true),
      recipient = await makePerson('claim-without-mfa');
    const result = await auth.query<{ email: string }>(
      'select email from identity.users where id=$1',
      [recipient.userId],
    );
    const invitation = await createInvitation(app.db, owner.context, {
      email: result.rows[0]!.email,
      role: 'member',
    });
    expect(
      await acceptInvitation(app.db, {
        token: invitation.token,
        userId: recipient.userId,
        email: result.rows[0]!.email,
        emailVerified: false,
      }),
    ).toEqual({ status: 'awaiting_confirmation' });
    const plain = await resolveTenantContext(app.db, owner.userId, owner.organizationId);
    await expect(
      confirmInvitation(app.db, plain, { invitationId: invitation.id }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await confirmInvitation(app.db, owner.context, { invitationId: invitation.id });
    expect((await resolveTenantContext(app.db, recipient.userId, owner.organizationId)).role).toBe(
      'member',
    );
  });
  it('cannot mint workload approval authority with the default administration policy switched off', async () => {
    const owner = await fresh(false);
    await expect(
      withTenantTx(app.db, owner.context, (tx) =>
        assertInteractivePrivilege(tx, owner.context, 'model_workload.approve'),
      ),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await proveSecondFactor(owner);
    await withTenantTx(app.db, owner.context, (tx) =>
      assertInteractivePrivilege(tx, owner.context, 'model_workload.approve'),
    );
  });
});
