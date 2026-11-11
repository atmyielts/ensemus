// CONNECT-07, the web half (ADR-038 D1, D2): starting a consent and storing what the provider sends back,
// on real roles, RLS and 0561's triggers, with two tenants of the same name. Every failure of the callback
// is the same OAUTH_STATE_INVALID, nothing secret reaches a view, and each sealed value carries its own
// purpose. Generated values only: no real account, client, code or token. Owed: not yet run (no Docker).
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAuthorization,
  listAuthorizations,
  receiveCallback,
  startAuthorization,
  type OAuthAuthorizationView,
  type OAuthWebSide,
  type StartAuthorizationInput,
} from '@ensemus/application';
import { updateSecurityPolicy } from '@ensemus/application/security-policy';
import { openAppDatabase, type TenantContext } from '@ensemus/database';
import {
  formatOAuthState,
  OAUTH_AUTHORIZATION_CODE_RECEIVED,
  oauthStateSha256,
  parseOAuthState,
  SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE,
  SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT,
  SECRET_PURPOSE_OAUTH_PKCE_VERIFIER,
} from '@ensemus/domain/workspace-suites';
import { storeSecret } from '@ensemus/secrets/seal';
import { makeTwoTenants, proveSecondFactor, type TestPerson } from '../helpers/product';
import { secret, urls } from '../helpers/stack';

const REDIRECT = 'https://ensemus.example.invalid/api/v1/oauth/callback';
const GOOGLE_CLIENT = 'generated-platform.apps.googleusercontent.com';
const MICROSOFT_CLIENT = randomUUID();
const CUSTOMER_SECRET = `CANARY-client-secret-${randomUUID()}`;
const CODE = `CANARY-code-${randomUUID()}`;
const code = (name: string) => expect.objectContaining({ code: name });

const VIEW_KEYS = [
  'capabilities',
  'clientKind',
  'connectionId',
  'connectorType',
  'createdAt',
  'displayName',
  'errorCode',
  'expiresAt',
  'id',
  'ownerMembershipId',
  'scopes',
  'startedByMembershipId',
  'status',
  'updatedAt',
];

describe('consent attempts, the web half', () => {
  const app = openAppDatabase(urls.app(), { max: 4 });
  const observer = new pg.Client({ connectionString: urls.superuser() });
  const db = () => app.db;
  const publicKeyPem = secret('sealing_public_key.pem');
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  const sealed: { purpose: string; id: string }[] = [];

  /** The web tier's port, sealing for real, and remembering what it sealed and why. */
  function webSide(context: TenantContext, platform: string | null = GOOGLE_CLIENT): OAuthWebSide {
    return {
      async seal(purpose, plaintext) {
        const { secretRef } = await storeSecret(db(), context, {
          publicKeyPem,
          purpose,
          plaintext: plaintext.toString('utf8'),
        });
        sealed.push({ purpose, id: secretRef });
        return secretRef;
      },
      redirectUri: REDIRECT,
      platformClientId: (provider) =>
        platform === null ? null : provider === 'google' ? platform : MICROSOFT_CLIENT,
    };
  }

  const googleStart = (
    overrides: Partial<StartAuthorizationInput> = {},
  ): StartAuthorizationInput => ({
    connectorType: 'google_workspace',
    displayName: 'Generated workspace',
    config: {},
    capabilities: ['files', 'directory'],
    client: { kind: 'platform' },
    ...overrides,
  });

  async function start(person: TestPerson, overrides: Partial<StartAuthorizationInput> = {}) {
    const started = await startAuthorization(
      db(),
      person.context,
      googleStart(overrides),
      webSide(person.context),
    );
    const state = new URL(started.authorizeUrl).searchParams.get('state');
    if (!state) throw new Error('no state in the authorize URL');
    return { ...started, state };
  }

  const row = async (id: string) =>
    (
      await observer.query<{
        status: string;
        error_code: string | null;
        state_sha256: string;
        verifier_secret_id: string;
        code_secret_id: string | null;
        customer_client_secret_id: string | null;
        started_by_membership_id: string;
        client_kind: string;
        client_id: string;
      }>('select * from integrations.oauth_authorizations where id=$1', [id])
    ).rows[0]!;

  const purposeOf = async (secretId: string) =>
    (
      await observer.query<{ purpose: string }>(
        'select purpose from secrets.sealed_secrets where id=$1',
        [secretId],
      )
    ).rows[0]?.purpose;

  const eventsFor = async (id: string) =>
    (
      await observer.query<{ event_type: string; in_outbox: boolean }>(
        `select e.event_type, exists(select 1 from platform.outbox_events o
                                      where o.organization_id=e.organization_id and o.event_id=e.id) as in_outbox
           from platform.domain_events e where e.aggregate_id=$1`,
        [id],
      )
    ).rows;

  /** Moves an attempt's window into the past, as only a test may: no role can change it otherwise. */
  async function ageOut(id: string) {
    await observer.query('begin');
    try {
      await observer.query("set local session_replication_role = 'replica'");
      await observer.query(
        `update integrations.oauth_authorizations
            set created_at=now()-interval '11 minutes', expires_at=now()-interval '1 minute'
          where id=$1`,
        [id],
      );
      await observer.query('commit');
    } catch (error) {
      await observer.query('rollback');
      throw error;
    }
  }

  const callback = (person: TestPerson, input: Parameters<typeof receiveCallback>[2]) =>
    receiveCallback(db(), person.context, input, webSide(person.context));

  beforeAll(async () => {
    await observer.connect();
    tenants = await makeTwoTenants(db());
  });

  afterAll(async () => {
    await app.close();
    await observer.end();
  });

  describe('starting', () => {
    it('inserts a pending attempt with only the state’s hash, and seals the verifier', async () => {
      const before = sealed.length;
      const started = await start(tenants.a.owner);
      const stored = await row(started.authorizationId);
      expect(stored).toMatchObject({
        status: 'pending',
        client_kind: 'platform',
        client_id: GOOGLE_CLIENT,
        code_secret_id: null,
        customer_client_secret_id: null,
        started_by_membership_id: tenants.a.owner.context.membershipId,
      });
      expect(stored.state_sha256).toBe(oauthStateSha256(started.state));
      expect(parseOAuthState(started.state)).toEqual({
        organizationId: tenants.a.organizationId,
        authorizationId: started.authorizationId,
      });
      expect(sealed.slice(before)).toEqual([
        { purpose: SECRET_PURPOSE_OAUTH_PKCE_VERIFIER, id: stored.verifier_secret_id },
      ]);
      expect(await purposeOf(stored.verifier_secret_id)).toBe(SECRET_PURPOSE_OAUTH_PKCE_VERIFIER);
      const url = new URL(started.authorizeUrl);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.has('include_granted_scopes')).toBe(false);
    });

    it('needs connection.manage: a member is refused and nothing is sealed or written', async () => {
      const before = sealed.length;
      await expect(start(tenants.a.member)).rejects.toEqual(code('FORBIDDEN'));
      expect(sealed.length).toBe(before);
      const { rows } = await observer.query(
        'select 1 from integrations.oauth_authorizations where started_by_membership_id=$1',
        [tenants.a.member.context.membershipId],
      );
      expect(rows).toEqual([]);
    });

    it('needs the interactive privilege when the organization asks for a recent second factor', async () => {
      const { a: fresh } = await makeTwoTenants(db());
      await proveSecondFactor(fresh.owner);
      await updateSecurityPolicy(
        db(),
        fresh.owner.context,
        { sessionId: fresh.owner.sessionId },
        {
          expectedVersion: 1,
          mfaForAdministration: true,
          mfaMaxAgeSeconds: 600,
          ssoEnforcement: 'optional',
        },
      );
      const before = sealed.length;
      await expect(start(fresh.admin)).rejects.toEqual(code('MFA_REQUIRED'));
      expect(sealed.length).toBe(before);
      await proveSecondFactor(fresh.admin);
      await expect(start(fresh.admin)).resolves.toMatchObject({
        authorizationId: expect.any(String),
      });
    });

    it('seals a customer’s own client as one value with its own purpose, and shows none of it', async () => {
      const started = await startAuthorization(
        db(),
        tenants.a.admin.context,
        googleStart({
          connectorType: 'microsoft_365',
          client: {
            kind: 'customer',
            clientId: 'generated-customer-client',
            clientSecret: CUSTOMER_SECRET,
            tenant: randomUUID(),
          },
        }),
        webSide(tenants.a.admin.context, null),
      );
      const stored = await row(started.authorizationId);
      expect(stored.client_kind).toBe('customer');
      expect(stored.customer_client_secret_id).not.toBeNull();
      expect(await purposeOf(stored.customer_client_secret_id!)).toBe(
        SECRET_PURPOSE_OAUTH_CUSTOMER_CLIENT,
      );
      const { rows } = await observer.query<{ text: string }>(
        `select row_to_json(s)::text as text from secrets.sealed_secrets s where id=$1`,
        [stored.customer_client_secret_id],
      );
      expect(rows[0]!.text).not.toContain(CUSTOMER_SECRET);
      const view = await getAuthorization(db(), tenants.a.admin.context, {
        authorizationId: started.authorizationId,
      });
      expect(JSON.stringify(view)).not.toContain(CUSTOMER_SECRET);
      expect(started.authorizeUrl).not.toContain(CUSTOMER_SECRET);
    });

    it('refuses the operator’s app when this deployment has none', async () => {
      const before = sealed.length;
      await expect(
        startAuthorization(
          db(),
          tenants.a.owner.context,
          googleStart(),
          webSide(tenants.a.owner.context, null),
        ),
      ).rejects.toEqual(code('OAUTH_CLIENT_NOT_CONFIGURED'));
      expect(sealed.length).toBe(before);
    });
  });

  describe('the callback', () => {
    it('seals the code, moves to code_received and emits the event, all at once', async () => {
      const started = await start(tenants.a.admin);
      const before = sealed.length;
      await expect(
        callback(tenants.a.admin, { state: started.state, code: CODE }),
      ).resolves.toEqual({ authorizationId: started.authorizationId, status: 'code_received' });
      const stored = await row(started.authorizationId);
      expect(stored.status).toBe('code_received');
      expect(sealed.slice(before)).toEqual([
        { purpose: SECRET_PURPOSE_OAUTH_AUTHORIZATION_CODE, id: stored.code_secret_id },
      ]);
      expect(await eventsFor(started.authorizationId)).toEqual([
        { event_type: OAUTH_AUTHORIZATION_CODE_RECEIVED, in_outbox: true },
      ]);
      const { rows } = await observer.query<{ text: string }>(
        `select coalesce(string_agg(row_to_json(e)::text, ''), '') as text
           from platform.domain_events e where e.aggregate_id=$1`,
        [started.authorizationId],
      );
      expect(rows[0]!.text).not.toContain(CODE);
      expect(rows[0]!.text).not.toContain(started.state);
    });

    it('refuses a state used once already, and seals nothing the second time', async () => {
      const started = await start(tenants.a.admin);
      await callback(tenants.a.admin, { state: started.state, code: CODE });
      const before = sealed.length;
      await expect(
        callback(tenants.a.admin, { state: started.state, code: `${CODE}-again` }),
      ).rejects.toEqual(code('OAUTH_STATE_INVALID'));
      expect(sealed.length).toBe(before);
      expect(await eventsFor(started.authorizationId)).toHaveLength(1);
    });

    it('refuses another member’s session, and leaves the attempt for the one who started it', async () => {
      const started = await start(tenants.a.owner);
      for (const other of [tenants.a.admin, tenants.a.member]) {
        await expect(callback(other, { state: started.state, code: CODE })).rejects.toEqual(
          code('OAUTH_STATE_INVALID'),
        );
      }
      expect((await row(started.authorizationId)).status).toBe('pending');
      await expect(
        callback(tenants.a.owner, { state: started.state, code: CODE }),
      ).resolves.toMatchObject({ status: 'code_received' });
    });

    it('refuses another tenant’s state, read in either tenant', async () => {
      const started = await start(tenants.a.owner);
      // Tenant B's owner, with tenant A's state: the tenant does not match the session's.
      await expect(callback(tenants.b.owner, { state: started.state, code: CODE })).rejects.toEqual(
        code('OAUTH_STATE_INVALID'),
      );
      // The same attempt's ID under tenant B's ID: RLS finds no such row there.
      const forged = formatOAuthState(
        tenants.b.organizationId,
        started.authorizationId,
        randomBytes(32),
      );
      await expect(callback(tenants.b.owner, { state: forged, code: CODE })).rejects.toEqual(
        code('OAUTH_STATE_INVALID'),
      );
      expect((await row(started.authorizationId)).status).toBe('pending');
    });

    it('refuses a tampered state, and the real one still works', async () => {
      const started = await start(tenants.a.owner);
      const last = started.state.at(-1) === 'A' ? 'B' : 'A';
      const tampered = `${started.state.slice(0, -1)}${last}`;
      const otherNonce = formatOAuthState(
        tenants.a.organizationId,
        started.authorizationId,
        randomBytes(32),
      );
      for (const state of [tampered, otherNonce, `${started.state}x`, started.state.slice(1)]) {
        await expect(callback(tenants.a.owner, { state, code: CODE })).rejects.toEqual(
          code('OAUTH_STATE_INVALID'),
        );
      }
      expect((await row(started.authorizationId)).status).toBe('pending');
      await expect(
        callback(tenants.a.owner, { state: started.state, code: CODE }),
      ).resolves.toMatchObject({ status: 'code_received' });
    });

    it('refuses an expired attempt with the same answer, and records that it expired', async () => {
      const started = await start(tenants.a.owner);
      await ageOut(started.authorizationId);
      const before = sealed.length;
      await expect(callback(tenants.a.owner, { state: started.state, code: CODE })).rejects.toEqual(
        code('OAUTH_STATE_INVALID'),
      );
      expect(sealed.length).toBe(before);
      expect((await row(started.authorizationId)).status).toBe('expired');
    });

    it('ends denied with a fixed code on a provider error, and keeps none of its text', async () => {
      const providerText = `CANARY-provider-text-${randomUUID()}`;
      for (const [error, expected] of [
        ['access_denied', 'OAUTH_DENIED'],
        ['invalid_scope', 'OAUTH_SCOPE_REFUSED'],
        [providerText, 'OAUTH_PROVIDER_ERROR'],
      ] as const) {
        const started = await start(tenants.a.owner);
        const before = sealed.length;
        await expect(callback(tenants.a.owner, { state: started.state, error })).resolves.toEqual({
          authorizationId: started.authorizationId,
          status: 'denied',
        });
        expect(sealed.length).toBe(before);
        const stored = await row(started.authorizationId);
        expect(stored).toMatchObject({
          status: 'denied',
          error_code: expected,
          code_secret_id: null,
        });
        const { rows } = await observer.query<{ text: string }>(
          `select (select row_to_json(a)::text from integrations.oauth_authorizations a where id=$1)
                  || coalesce((select string_agg(row_to_json(e)::text, '') from governance.audit_events e
                                where e.target_ref=$2), '') as text`,
          [started.authorizationId, `oauth_authorization:${started.authorizationId}`],
        );
        expect(rows[0]!.text).not.toContain(providerText);
        // A denied attempt is over: its state cannot be used again, even with a code.
        await expect(
          callback(tenants.a.owner, { state: started.state, code: CODE }),
        ).rejects.toEqual(code('OAUTH_STATE_INVALID'));
      }
    });

    it('counts Microsoft’s admin consent refused as needing an administrator', async () => {
      const started = await start(tenants.a.owner, { connectorType: 'microsoft_365' });
      await callback(tenants.a.owner, { state: started.state, adminConsent: false });
      expect((await row(started.authorizationId)).error_code).toBe('OAUTH_CONSENT_REQUIRED');
    });
  });

  describe('reading attempts', () => {
    it('shows nothing secret: no state, hash, verifier, code or client reference', async () => {
      const started = await start(tenants.a.owner);
      await callback(tenants.a.owner, { state: started.state, code: CODE });
      const stored = await row(started.authorizationId);
      const view = await getAuthorization(db(), tenants.a.owner.context, {
        authorizationId: started.authorizationId,
      });
      expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
      const text = JSON.stringify(view);
      for (const hidden of [
        started.state,
        stored.state_sha256,
        stored.verifier_secret_id,
        stored.code_secret_id!,
        CODE,
      ]) {
        expect(text).not.toContain(hidden);
      }
    });

    it('lets the starter and those who manage connections see one, and nobody else', async () => {
      const started = await start(tenants.a.admin);
      const read = (person: TestPerson) =>
        getAuthorization(db(), person.context, { authorizationId: started.authorizationId });
      await expect(read(tenants.a.admin)).resolves.toMatchObject({ id: started.authorizationId });
      await expect(read(tenants.a.owner)).resolves.toMatchObject({ id: started.authorizationId });
      await expect(read(tenants.a.member)).rejects.toEqual(code('NOT_FOUND'));
      await expect(read(tenants.b.owner)).rejects.toEqual(code('NOT_FOUND'));
    });

    it('lists only this tenant’s attempts, for those who manage connections', async () => {
      const ids = (rows: readonly OAuthAuthorizationView[]) => rows.map((item) => item.id);
      const started = await start(tenants.a.owner);
      expect(ids(await listAuthorizations(db(), tenants.a.admin.context))).toContain(
        started.authorizationId,
      );
      expect(ids(await listAuthorizations(db(), tenants.b.owner.context))).not.toContain(
        started.authorizationId,
      );
      await expect(listAuthorizations(db(), tenants.a.member.context)).rejects.toEqual(
        code('FORBIDDEN'),
      );
    });
  });
});
