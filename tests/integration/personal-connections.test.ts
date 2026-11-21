// ADR-038 D5 against the real database and migrations 0563 and 0564: a member connects their own account only for
// what the organization allows, sees only their own, and revokes it; another member can neither see nor
// revoke it; an admin sees whose it is and its state, never what it reaches, and can revoke it; and a run
// one member started cannot use another member's connection, nor anyone a revoked one. Generated values
// only. Written, not yet run: owed to the first stack run.
import { randomUUID } from 'node:crypto';
import { AppError, type OAuthWebSide } from '@ensemus/application';
import { lockConnectionFacts } from '@ensemus/application/suite-connections';
import {
  getMemberCapabilities,
  listMemberConnections,
  listMyConnections,
  listMyUsableConnections,
  revokeMyConnection,
  setMemberCapabilities,
  startMyConnection,
} from '@ensemus/application/suite-settings';
import {
  auditEvents,
  connections,
  createOrganization,
  domainEvents,
  oauthAuthorizations,
  openAppDatabase,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { TOOL_MANIFESTS, type ToolManifest } from '@ensemus/domain/ai-tools';
import type { SuiteCapability } from '@ensemus/domain/workspace-suites';
import { decideConnectionUse } from '@ensemus/policy';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeSecret } from '@ensemus/secrets/seal';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { secret, urls } from '../helpers/stack';

const google = (scope: string) => `https://www.googleapis.com/auth/${scope}`;
const MAIL_SCOPES = [google('gmail.readonly'), google('gmail.compose'), google('gmail.send')];

const gmailSend = (TOOL_MANIFESTS as readonly ToolManifest[]).find(
  (tool) => tool.id === 'gmail.send',
)!;

describe('personal connections (ADR-038 D5)', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  /** Writes a member's own connection, which only a consent may make under the application roles. */
  let superuser: pg.Client;
  const db = () => app.db;

  /**
   * A superuser fixture write, bound to the row's tenant the way every tenant trigger requires, as the
   * other suites do (tests/helpers/fixture-tenant.ts). Reads stay plain superuser queries.
   */
  const fixture = <R extends pg.QueryResultRow = pg.QueryResultRow>(
    organizationId: string,
    text: string,
    values: unknown[],
  ) => inFixtureTenant(superuser, organizationId, () => superuser.query<R>(text, values));

  const publicKeyPem = secret('sealing_public_key.pem');
  /**
   * The web tier's port for this member, sealing for real in their tenant: the attempt's sealed IDs are
   * foreign keys, so an ID that names no sealed value is refused as a foreign reference.
   */
  const webFor = (context: TenantContext): OAuthWebSide => ({
    seal: async (purpose, plaintext) =>
      (
        await storeSecret(db(), context, {
          publicKeyPem,
          purpose,
          plaintext: plaintext.toString('utf8'),
        })
      ).secretRef,
    redirectUri: 'https://ensemus.example.invalid/api/v1/oauth/callback',
    platformClientId: () => 'generated-client.apps.example.invalid',
  });

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    superuser = new pg.Client({ connectionString: urls.superuser() });
    await auth.connect();
    await superuser.connect();
  });
  afterAll(async () => {
    await auth.end();
    await superuser.end();
    await app.close();
  });

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  /** An owner, two members, a mail connection of each member's own, and one of the organization's. */
  async function tenant() {
    const ownerUser = await makeUser('owner');
    const { organizationId } = await createOrganization(db(), {
      userId: ownerUser,
      name: 'Generated Ltd',
      commercialMode: 'byom',
    });
    const owner = await resolveTenantContext(db(), ownerUser, organizationId);
    const member = async (label: string) => {
      const user = await makeUser(label);
      await withTenantTx(db(), owner, (tx) =>
        tx.execute(
          sql`insert into org.memberships (organization_id, id, user_id, role)
              values (${organizationId}, ${randomUUID()}, ${user}, 'member')`,
        ),
      );
      return resolveTenantContext(db(), user, organizationId);
    };
    const alex = await member('alex');
    const sam = await member('sam');
    const connection = async (ownerId: string | null, name: string, scopes: string[]) => {
      const id = randomUUID();
      await fixture(
        organizationId,
        `insert into integrations.connections
           (organization_id, id, connector_type, display_name, state, granted_scopes, owner_membership_id)
         values ($1, $2, 'google_workspace', $3, 'active', $4, $5)`,
        [organizationId, id, name, scopes, ownerId],
      );
      return id;
    };
    const alexMail = await connection(alex.membershipId, 'Alex private mailbox', MAIL_SCOPES);
    const samMail = await connection(sam.membershipId, 'Sam private mailbox', MAIL_SCOPES);
    const orgFiles = await connection(null, 'Company files', [google('drive.metadata.readonly')]);
    return { organizationId, owner, alex, sam, alexMail, samMail, orgFiles };
  }

  const start = (context: TenantContext, capabilities: SuiteCapability[]) =>
    startMyConnection(
      db(),
      context,
      { connectorType: 'google_workspace', displayName: 'My account', capabilities },
      webFor(context),
    );

  const stateOf = async (context: TenantContext, connectionId: string) => {
    const [row] = await withTenantTx(db(), context, (tx) =>
      tx
        .select({ state: connections.state })
        .from(connections)
        .where(eq(connections.id, connectionId)),
    );
    return row?.state;
  };

  /** What the gateway's rule says about this member's run using this connection to send mail. */
  const decide = async (context: TenantContext, connectionId: string) => {
    const facts = await withTenantTx(db(), context, (tx) => lockConnectionFacts(tx, connectionId));
    return decideConnectionUse({
      rule: gmailSend.connection! as Parameters<typeof decideConnectionUse>[0]['rule'],
      toolClass: gmailSend.class,
      initiatorMembershipId: context.membershipId,
      dataClass: 'internal',
      connection: facts,
      resource: null,
    });
  };

  describe('connecting their own account', () => {
    it('starts a consent for what the organization allows members, owned by that member alone', async () => {
      const t = await tenant();
      expect([...(await getMemberCapabilities(db(), t.alex))].sort()).toEqual(['calendar', 'mail']);
      const started = await start(t.alex, ['mail', 'calendar']);
      const [row] = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .select()
          .from(oauthAuthorizations)
          .where(eq(oauthAuthorizations.id, started.authorizationId)),
      );
      expect(row?.ownerMembershipId).toBe(t.alex.membershipId);
      expect([...(row?.requestedCapabilities ?? [])].sort()).toEqual(['calendar', 'mail']);
      expect(row?.clientKind).toBe('platform');
      expect(new URL(started.authorizeUrl).protocol).toBe('https:');
    });

    it('refuses a capability the organization does not allow members, in plain words, and keeps nothing', async () => {
      const t = await tenant();
      const refused = await start(t.alex, ['documents']).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({ code: 'MEMBER_CAPABILITY_NOT_ALLOWED' });
      expect((refused as AppError).message).toBe(
        'Your organization does not let members connect that kind of access, so nothing was connected. Ask an administrator to allow it.',
      );
      // A capability only the organization may own is not a member's to ask for at all.
      await expect(start(t.alex, ['files'])).rejects.toMatchObject({
        code: 'OAUTH_CAPABILITY_UNAVAILABLE',
      });
      const kept = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .select({ id: oauthAuthorizations.id })
          .from(oauthAuthorizations)
          .where(eq(oauthAuthorizations.startedByMembershipId, t.alex.membershipId)),
      );
      expect(kept).toEqual([]);
    });

    it('follows the admin’s setting both ways, and refuses a member changing it', async () => {
      const t = await tenant();
      await setMemberCapabilities(db(), t.owner, ['mail', 'calendar', 'documents']);
      await expect(start(t.alex, ['documents'])).resolves.toMatchObject({
        authorizationId: expect.any(String),
      });
      await setMemberCapabilities(db(), t.owner, ['calendar']);
      expect(await getMemberCapabilities(db(), t.sam)).toEqual(['calendar']);
      await expect(start(t.alex, ['mail'])).rejects.toMatchObject({
        code: 'MEMBER_CAPABILITY_NOT_ALLOWED',
      });
      await expect(setMemberCapabilities(db(), t.alex, ['mail'])).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(setMemberCapabilities(db(), t.owner, ['files'])).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });
  });

  describe('who sees a member’s own connection', () => {
    it('shows the member their own, as capabilities and never scopes, and nobody else’s', async () => {
      const t = await tenant();
      const mine = await listMyConnections(db(), t.alex);
      expect(mine.map((connection) => connection.id)).toEqual([t.alexMail]);
      expect(mine[0]).toMatchObject({ state: 'active', capabilities: ['mail'] });
      expect(JSON.stringify(mine)).not.toContain('googleapis.com/auth');
      expect(JSON.stringify(mine)).not.toContain('Sam private mailbox');
      // The organization's own connection is not the member's either.
      expect(mine.map((connection) => connection.id)).not.toContain(t.orgFiles);
    });

    it('shows an admin whose each is and its state, never its name or what it reaches', async () => {
      const t = await tenant();
      const listed = await listMemberConnections(db(), t.owner);
      const alex = listed.find((connection) => connection.id === t.alexMail);
      expect(alex).toMatchObject({
        ownerMembershipId: t.alex.membershipId,
        ownerName: 'alex',
        state: 'active',
      });
      expect(Object.keys(alex ?? {}).sort()).toEqual([
        'connectorType',
        'createdAt',
        'id',
        'ownerMembershipId',
        'ownerName',
        'state',
      ]);
      expect(listed.map((connection) => connection.id)).not.toContain(t.orgFiles);
      const text = JSON.stringify(listed);
      expect(text).not.toContain('private mailbox');
      expect(text).not.toContain('googleapis.com/auth');
      await expect(listMemberConnections(db(), t.alex)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  describe('revoking a member’s own connection', () => {
    it('lets another member neither revoke it nor learn it exists', async () => {
      const t = await tenant();
      await expect(
        revokeMyConnection(db(), t.sam, { connectionId: t.alexMail }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // The same answer as for a connection that never was.
      await expect(
        revokeMyConnection(db(), t.sam, { connectionId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await stateOf(t.owner, t.alexMail)).toBe('active');
    });

    it('never revokes the organization’s own connection, for a member or an admin', async () => {
      const t = await tenant();
      for (const context of [t.alex, t.owner]) {
        await expect(
          revokeMyConnection(db(), context, { connectionId: t.orgFiles }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(await stateOf(t.owner, t.orgFiles)).toBe('active');
    });

    it('lets the owner revoke it: revoked at once, emitted, audited, and once only', async () => {
      const t = await tenant();
      await revokeMyConnection(db(), t.alex, { connectionId: t.alexMail });
      expect(await stateOf(t.owner, t.alexMail)).toBe('revoked');
      await withTenantTx(db(), t.owner, async (tx) => {
        const events = await tx
          .select({ eventType: domainEvents.eventType })
          .from(domainEvents)
          .where(eq(domainEvents.aggregateId, t.alexMail));
        expect(events.map((event) => event.eventType)).toEqual(['connection.revoked']);
        const audit = await tx
          .select({ action: auditEvents.action, actorId: auditEvents.actorId })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.targetRef, `connection:${t.alexMail}`),
              eq(auditEvents.decision, 'allow'),
            ),
          );
        expect(audit).toEqual([{ action: 'connection.revoked', actorId: t.alex.membershipId }]);
      });
      await expect(
        revokeMyConnection(db(), t.alex, { connectionId: t.alexMail }),
      ).rejects.toMatchObject({ code: 'CONNECTION_NOT_ACTIVE' });
    });

    it('lets an admin revoke it without reading through it, and the listing still shows no content', async () => {
      const t = await tenant();
      await revokeMyConnection(db(), t.owner, { connectionId: t.alexMail });
      expect(await stateOf(t.owner, t.alexMail)).toBe('revoked');
      const listed = await listMemberConnections(db(), t.owner);
      expect(listed.find((connection) => connection.id === t.alexMail)?.state).toBe('revoked');
      expect(JSON.stringify(listed)).not.toContain('private mailbox');
      // The member sees it revoked on their own page.
      const mine = await listMyConnections(db(), t.alex);
      expect(mine.find((connection) => connection.id === t.alexMail)?.state).toBe('revoked');
    });

    it('lets the owner change nothing else about it, under 0564’s guard', async () => {
      const t = await tenant();
      const refused = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .update(connections)
          .set({ grantedScopes: [...MAIL_SCOPES, google('drive.readonly')] })
          .where(eq(connections.id, t.alexMail)),
      ).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(Error);
      const reopened = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .update(connections)
          .set({ displayName: 'Renamed' })
          .where(eq(connections.id, t.alexMail)),
      ).catch((error: unknown) => error);
      expect(reopened).toBeInstanceOf(Error);
      // A revoke that also changes anything else, its last error included, is not the owner's to make.
      const [before] = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .select({ version: connections.version })
          .from(connections)
          .where(eq(connections.id, t.alexMail)),
      );
      const widened = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .update(connections)
          .set({
            state: 'revoked',
            revokedAt: new Date(),
            version: before!.version + 1,
            lastErrorCode: 'GENERATED',
          })
          .where(eq(connections.id, t.alexMail)),
      ).catch((error: unknown) => error);
      expect(widened).toBeInstanceOf(Error);
      const skipped = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .update(connections)
          .set({ state: 'revoked', revokedAt: new Date(), version: before!.version + 5 })
          .where(eq(connections.id, t.alexMail)),
      ).catch((error: unknown) => error);
      expect(skipped).toBeInstanceOf(Error);
      expect(await stateOf(t.owner, t.alexMail)).toBe('active');
    });
  });

  describe('which connection a run may use', () => {
    it('never offers or allows one member’s connection to a run another member started', async () => {
      const t = await tenant();
      const usable = await listMyUsableConnections(db(), t.alex);
      const ids = usable.map((connection) => connection.id);
      expect(ids).toContain(t.alexMail);
      expect(ids).not.toContain(t.samMail);
      expect(usable.find((connection) => connection.id === t.alexMail)?.owner).toBe('yours');
      expect(await decide(t.alex, t.alexMail)).toMatchObject({ ok: true, ownerKind: 'member' });
      expect(await decide(t.alex, t.samMail)).toMatchObject({
        ok: false,
        code: 'CONNECTION_NOT_YOURS',
      });
    });

    it('stops offering or allowing a connection once it is revoked', async () => {
      const t = await tenant();
      await revokeMyConnection(db(), t.alex, { connectionId: t.alexMail });
      const usable = await listMyUsableConnections(db(), t.alex);
      expect(usable.map((connection) => connection.id)).not.toContain(t.alexMail);
      expect(await decide(t.alex, t.alexMail)).toMatchObject({
        ok: false,
        auditAs: 'CONNECTION_NOT_ACTIVE',
      });
    });
  });
});
