// ADR-038 D5 and D6 against the real database and migrations 0563 and 0565: the connection rule on M3's
// intent path and again at the send, drafts that ask nobody, a file's class across every connection that
// syncs it, the suite read table nobody but the agent role and the connector worker can see, the members'
// capability setting, and a member's own consent and the connection its exchange makes. Generated values
// only. Written, not yet run: owed to the first stack run.
import { randomUUID } from 'node:crypto';
import {
  beginAttempt,
  createWorkUnit,
  decideApproval,
  pgCode,
  proposeDraftActionInTx,
  proposeExternalActionInTx,
  startAuthorization,
  type OAuthWebSide,
} from '@ensemus/application';
import { listUsableConnections } from '@ensemus/application/suite-connections';
import { sourceClassesInTenant } from '@ensemus/application/suite-reads';
import {
  connections,
  createOrganization,
  externalActions,
  oauthAuthorizations,
  openAppDatabase,
  resolveTenantContext,
  suiteReads,
  suiteSettings,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inFixtureTenant } from '../helpers/fixture-tenant';
import { urls } from '../helpers/stack';

const google = (scope: string) => `https://www.googleapis.com/auth/${scope}`;
const message = { to: ['someone@example.invalid'], subject: 'Hello', text_body: 'Synthetic.' };

describe('suite tools (ADR-038 D6)', () => {
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

  /** An owner, two members, and a Google connection of each kind. */
  async function tenant() {
    const ownerUser = await makeUser('owner');
    const { organizationId } = await createOrganization(db(), {
      userId: ownerUser,
      name: 'Generated Ltd',
      commercialMode: 'byom',
    });
    const owner = await resolveTenantContext(db(), ownerUser, organizationId);
    const member = async (label: string, role = 'member') => {
      const user = await makeUser(label);
      const membershipId = randomUUID();
      await withTenantTx(db(), owner, (tx) =>
        tx.execute(
          sql`insert into org.memberships (organization_id, id, user_id, role)
              values (${organizationId}, ${membershipId}, ${user}, ${role})`,
        ),
      );
      return resolveTenantContext(db(), user, organizationId);
    };
    const alex = await member('alex');
    const sam = await member('sam');
    const connection = async (owner: string | null, scopes: string[]) => {
      const id = randomUUID();
      await fixture(
        organizationId,
        `insert into integrations.connections
           (organization_id, id, connector_type, display_name, state, granted_scopes, owner_membership_id)
         values ($1, $2, 'google_workspace', 'Generated account', 'active', $3, $4)`,
        [organizationId, id, scopes, owner],
      );
      return id;
    };
    const alexMail = await connection(alex.membershipId, [
      google('gmail.readonly'),
      google('gmail.compose'),
      google('gmail.send'),
    ]);
    const samMail = await connection(sam.membershipId, [google('gmail.send')]);
    const alexReadOnly = await connection(alex.membershipId, [google('gmail.readonly')]);
    const orgFiles = await connection(null, [google('drive.metadata.readonly')]);
    const work = async (context: TenantContext) =>
      (await createWorkUnit(db(), context, { title: 'Write back', objective: 'Reply.' })).id;
    return { organizationId, owner, alex, sam, alexMail, samMail, alexReadOnly, orgFiles, work };
  }

  describe('M3’s intent path on the connection rule', () => {
    it('freezes a declared change on the proposer’s own connection, awaiting the approver', async () => {
      const t = await tenant();
      const workUnitId = await t.work(t.alex);
      const proposed = await withTenantTx(db(), t.alex, (tx) =>
        proposeExternalActionInTx(tx, t.alex, {
          workUnitId,
          connectionId: t.alexMail,
          toolName: 'gmail.send',
          toolVersion: '1',
          payload: { message },
          approverMembershipId: t.owner.membershipId,
        }),
      );
      const [row] = await withTenantTx(db(), t.alex, (tx) =>
        tx.select().from(externalActions).where(eq(externalActions.id, proposed.externalActionId)),
      );
      expect(row).toMatchObject({
        status: 'awaiting_approval',
        requiresApproval: true,
        toolName: 'gmail.send',
        payload: { message },
      });
    });

    it.each([
      ['another member’s connection', 'samMail', 'gmail.send', 'FORBIDDEN'],
      ['a scope the provider did not grant', 'alexReadOnly', 'gmail.send', 'INVALID_INPUT'],
      ['a read, which no manifest declares a change', 'alexMail', 'gmail.search', 'INVALID_INPUT'],
      ['a draft through the approval path', 'alexMail', 'gmail.create_draft', 'INVALID_INPUT'],
      [
        'the organization’s connection for a member’s capability',
        'orgFiles',
        'gmail.send',
        'FORBIDDEN',
      ],
    ] as const)('refuses %s', async (_name, which, toolName, code) => {
      const t = await tenant();
      const workUnitId = await t.work(t.alex);
      await expect(
        withTenantTx(db(), t.alex, (tx) =>
          proposeExternalActionInTx(tx, t.alex, {
            workUnitId,
            connectionId: t[which],
            toolName,
            toolVersion: '1',
            payload: { message },
            approverMembershipId: t.owner.membershipId,
          }),
        ),
      ).rejects.toMatchObject({ code });
    });

    it('starts a draft ready, asks nobody, and refuses a send through the draft path', async () => {
      const t = await tenant();
      const workUnitId = await t.work(t.alex);
      const draft = await withTenantTx(db(), t.alex, (tx) =>
        proposeDraftActionInTx(tx, t.alex, {
          workUnitId,
          connectionId: t.alexMail,
          toolName: 'gmail.create_draft',
          toolVersion: '1',
          payload: { message },
        }),
      );
      const [row] = await withTenantTx(db(), t.alex, (tx) =>
        tx.select().from(externalActions).where(eq(externalActions.id, draft.externalActionId)),
      );
      expect(row).toMatchObject({ status: 'ready', requiresApproval: false, approvalId: null });
      await expect(
        withTenantTx(db(), t.alex, (tx) =>
          proposeDraftActionInTx(tx, t.alex, {
            workUnitId,
            connectionId: t.alexMail,
            toolName: 'gmail.send',
            toolVersion: '1',
            payload: { message },
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('which connections a run may name', () => {
    it('lists the organization’s and the member’s own, never another member’s, and never scopes', async () => {
      const t = await tenant();
      const listed = await withTenantTx(db(), t.alex, (tx) =>
        listUsableConnections(tx, t.alex.membershipId),
      );
      const ids = listed.map((connection) => connection.id);
      expect(ids).toContain(t.alexMail);
      expect(ids).toContain(t.orgFiles);
      expect(ids).not.toContain(t.samMail);
      expect(JSON.stringify(listed)).not.toContain('googleapis.com/auth');
      expect(listed.find((connection) => connection.id === t.orgFiles)?.toolIds).toEqual([
        'drive.search',
      ]);
    });
  });

  describe('0563: the suite read table', () => {
    it('shows a person nothing and lets neither a person nor the worker write a request', async () => {
      const t = await tenant();
      await expect(
        withTenantTx(db(), t.owner, (tx) => tx.select().from(suiteReads)),
      ).resolves.toEqual([]);
      for (const context of [t.owner, createServiceContext(t.organizationId)]) {
        const refused = await withTenantTx(db(), context, (tx) =>
          tx.insert(suiteReads).values({
            organizationId: t.organizationId,
            proposalId: randomUUID(),
            runId: randomUUID(),
            stepId: randomUUID(),
            connectionId: t.alexMail,
            toolId: 'gmail.search',
            toolVersion: '1',
            args: {},
          }),
        ).catch((error: unknown) => error);
        // No INSERT grant to the application role: only the agent role writes a request.
        expect(pgCode(refused)).toBe('42501');
      }
    });
  });

  describe('0563: what members may connect for themselves', () => {
    it('refuses a member changing the setting', async () => {
      const t = await tenant();
      const refused = await withTenantTx(db(), t.alex, (tx) =>
        tx.insert(suiteSettings).values({
          organizationId: t.organizationId,
          memberCapabilities: ['mail', 'calendar', 'documents'],
          updatedByMembershipId: t.alex.membershipId,
        }),
      ).catch((error: unknown) => error);
      expect(['EN126', 'EN405']).toContain(pgCode(refused));
    });
  });

  describe('a member’s own consent (ADR-038 D5)', () => {
    const web: OAuthWebSide = {
      seal: async () => randomUUID(),
      redirectUri: 'https://ensemus.example.invalid/api/v1/oauth/callback',
      platformClientId: () => 'generated-client.apps.example.invalid',
    };
    const start = (context: TenantContext, capabilities: ('mail' | 'documents' | 'files')[]) =>
      startAuthorization(
        db(),
        context,
        {
          connectorType: 'google_workspace',
          displayName: 'My account',
          config: {},
          capabilities,
          owner: 'member',
          client: { kind: 'platform' },
        },
        web,
      );

    it('starts one for an allowed capability, owned by that member alone', async () => {
      const t = await tenant();
      const started = await start(t.alex, ['mail']);
      const [row] = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .select()
          .from(oauthAuthorizations)
          .where(eq(oauthAuthorizations.id, started.authorizationId)),
      );
      expect(row?.ownerMembershipId).toBe(t.alex.membershipId);
    });

    it('refuses a capability the organization does not allow members, and one only it may own', async () => {
      const t = await tenant();
      await expect(start(t.alex, ['documents'])).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(start(t.alex, ['files'])).rejects.toMatchObject({
        code: 'OAUTH_CAPABILITY_UNAVAILABLE',
      });
    });

    it('refuses a member starting the organization’s connection', async () => {
      const t = await tenant();
      await expect(
        startAuthorization(
          db(),
          t.alex,
          {
            connectorType: 'google_workspace',
            displayName: 'Everyone’s files',
            config: {},
            capabilities: ['files'],
            client: { kind: 'platform' },
          },
          web,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  /** A resource as a completed sync records it, with its ACL mapped, and the row's ID. */
  const synced = async (
    organizationId: string,
    connectionId: string,
    externalId: string,
    classification = 'internal',
  ) => {
    const { rows } = await fixture<{ id: string }>(
      organizationId,
      `insert into integrations.external_resources
         (organization_id, connection_id, stream, resource_type, external_id, display_name,
          classification, acl_state)
       values ($1, $2, 'drive', 'file', $3, 'Generated file', $4, 'mapped') returning id`,
      [organizationId, connectionId, externalId, classification],
    );
    return rows[0]!.id;
  };
  const grantAccess = (
    organizationId: string,
    resourceId: string,
    membershipId: string,
    access: string,
  ) =>
    fixture(
      organizationId,
      `insert into integrations.external_resource_acl
         (organization_id, resource_id, principal_kind, principal_external_id, access, membership_id)
       values ($1, $2, 'user', $3, $4, $3)`,
      [organizationId, resourceId, membershipId, access],
    );
  /** One of the organization's Google connections, granted these scopes. */
  const organizationConnection = async (organizationId: string, scopes: string[]) => {
    const id = randomUUID();
    await fixture(
      organizationId,
      `insert into integrations.connections
         (organization_id, id, connector_type, display_name, state, granted_scopes)
       values ($1, $2, 'google_workspace', 'Company files', 'active', $3)`,
      [organizationId, id, scopes],
    );
    return id;
  };

  describe('a file’s class follows the file, not the account that read it (review finding 1)', () => {
    it('finds the organization’s class for a file a member reads through their own account', async () => {
      const t = await tenant();
      const orgDocs = await organizationConnection(t.organizationId, [google('documents')]);
      await synced(t.organizationId, orgDocs, 'board-minutes', 'restricted');
      await synced(t.organizationId, orgDocs, 'lunch-menu', 'internal');
      const service = createServiceContext(t.organizationId);
      const classes = (ids: string[], connectorType = 'google_workspace') =>
        withTenantTx(db(), service, (tx) =>
          sourceClassesInTenant(tx, { connectorType, externalIds: ids }),
        );
      // Alex's own connection synced nothing: the organization's sync is what decides.
      expect(await classes(['board-minutes'])).toEqual(['restricted']);
      expect((await classes(['board-minutes', 'lunch-menu'])).sort()).toEqual([
        'internal',
        'restricted',
      ]);
      // A copy the sync has since lost sight of still counts.
      await fixture(
        t.organizationId,
        `update integrations.external_resources set deleted_at = now()
          where organization_id = $1 and external_id = 'board-minutes'`,
        [t.organizationId],
      );
      expect(await classes(['board-minutes'])).toEqual(['restricted']);
      // Another provider's IDs are another namespace.
      expect(await classes(['board-minutes'], 'microsoft_365')).toEqual([]);
    });
  });

  describe('an approved suite change, checked again at the send (review finding 2)', () => {
    type Tenant = Awaited<ReturnType<typeof tenant>>;
    const stateOf = async (id: string) =>
      (
        await superuser.query<{ status: string; status_reason: string | null }>(
          'select status, status_reason from integrations.external_actions where id = $1',
          [id],
        )
      ).rows[0];
    const attempts = async (id: string) =>
      (
        await superuser.query(
          'select id from integrations.external_action_attempts where external_action_id = $1',
          [id],
        )
      ).rows.length;

    /** Alex proposes, the owner approves, and the intent is ready. */
    async function approved(
      t: Tenant,
      input: { connectionId: string; toolName: string; payload: unknown },
    ) {
      const workUnitId = await t.work(t.alex);
      const proposed = await withTenantTx(db(), t.alex, (tx) =>
        proposeExternalActionInTx(tx, t.alex, {
          workUnitId,
          toolVersion: '1',
          approverMembershipId: t.owner.membershipId,
          ...input,
        }),
      );
      await decideApproval(db(), t.owner, {
        approvalId: proposed.approvalId,
        decision: 'approve',
        shownHash: proposed.requestHash,
      });
      expect((await stateOf(proposed.externalActionId))?.status).toBe('ready');
      return proposed.externalActionId;
    }
    const begin = (t: Tenant, id: string) =>
      beginAttempt(db(), createServiceContext(t.organizationId), {
        externalActionId: id,
        runId: randomUUID(),
      });
    const mailOf = (t: Tenant) => ({
      connectionId: t.alexMail,
      toolName: 'gmail.send',
      payload: { message },
    });

    it('sends what nothing has changed, with the connection’s scopes for the connector', async () => {
      const t = await tenant();
      const id = await approved(t, mailOf(t));
      expect(await begin(t, id)).toMatchObject({
        kind: 'send',
        attempt: {
          connection: {
            id: t.alexMail,
            ownerKind: 'member',
            grantedScopes: expect.arrayContaining([google('gmail.send')]),
          },
        },
      });
    });

    it.each([
      [
        'the initiator was deactivated after the approval',
        (t: Tenant) =>
          fixture(
            t.organizationId,
            `update org.memberships set status = 'disabled' where id = $1`,
            [t.alex.membershipId],
          ),
        'ACCESS_REVOKED',
      ],
      [
        'the provider narrowed the scopes after the approval',
        (t: Tenant) =>
          fixture(
            t.organizationId,
            'update integrations.connections set granted_scopes = $2 where id = $1',
            [t.alexMail, [google('gmail.readonly')]],
          ),
        'SCOPE_NOT_GRANTED',
      ],
      [
        'the connection was revoked after the approval',
        (t: Tenant) =>
          fixture(
            t.organizationId,
            `update integrations.connections set state = 'revoked', revoked_at = now() where id = $1`,
            [t.alexMail],
          ),
        'CONNECTION_NOT_ACTIVE',
      ],
    ] as const)('cancels it, unsent and with no attempt, when %s', async (_name, change, code) => {
      const t = await tenant();
      const id = await approved(t, mailOf(t));
      await change(t);
      await expect(begin(t, id)).resolves.toEqual({ kind: 'stop', status: 'cancelled' });
      expect(await stateOf(id)).toEqual({ status: 'cancelled', status_reason: code });
      expect(await attempts(id)).toBe(0);
    });

    it('cancels an edit of the organization’s document once the source stops granting it', async () => {
      const t = await tenant();
      const orgDocs = await organizationConnection(t.organizationId, [google('documents')]);
      const resourceId = await synced(t.organizationId, orgDocs, 'doc-1');
      await grantAccess(t.organizationId, resourceId, t.alex.membershipId, 'write');
      const edit = {
        connectionId: orgDocs,
        toolName: 'docs.edit',
        payload: {
          document_id: 'doc-1',
          required_revision_id: 'rev1',
          edits: [{ kind: 'insert_text', index: 1, text: 'Synthetic.' }],
        },
      };
      const kept = await approved(t, edit);
      expect(await begin(t, kept)).toMatchObject({ kind: 'send' });

      const revoked = await approved(t, edit);
      await fixture(
        t.organizationId,
        'delete from integrations.external_resource_acl where organization_id = $1 and resource_id = $2',
        [t.organizationId, resourceId],
      );
      await expect(begin(t, revoked)).resolves.toEqual({ kind: 'stop', status: 'cancelled' });
      expect(await stateOf(revoked)).toEqual({
        status: 'cancelled',
        status_reason: 'ACCESS_REVOKED',
      });
      expect(await attempts(revoked)).toBe(0);
    });

    it('cancels a new file through the organization’s connection into a folder never synced', async () => {
      const t = await tenant();
      const orgDrive = await organizationConnection(t.organizationId, [google('drive.file')]);
      const file = {
        name: 'notes.txt',
        media_type: 'text/plain',
        text: 'x',
        parent_id: 'folder-1',
      };
      // Proposing by hand names no ACL (the gateway checks it where the run is known), so the send does.
      const id = await approved(t, {
        connectionId: orgDrive,
        toolName: 'drive.create_file',
        payload: file,
      });
      await expect(begin(t, id)).resolves.toEqual({ kind: 'stop', status: 'cancelled' });
      expect((await stateOf(id))?.status_reason).toBe('ACCESS_REVOKED');
    });
  });

  describe('a formula that would fetch, link or import (review finding 4)', () => {
    it('is refused when proposed, before anyone is asked', async () => {
      const t = await tenant();
      const workUnitId = await t.work(t.alex);
      const sheets = randomUUID();
      await fixture(
        t.organizationId,
        `insert into integrations.connections
           (organization_id, id, connector_type, display_name, state, granted_scopes, owner_membership_id)
         values ($1, $2, 'google_workspace', 'Alex sheets', 'active', $3, $4)`,
        [t.organizationId, sheets, [google('spreadsheets')], t.alex.membershipId],
      );
      await expect(
        withTenantTx(db(), t.alex, (tx) =>
          proposeExternalActionInTx(tx, t.alex, {
            workUnitId,
            connectionId: sheets,
            toolName: 'sheets.write_range',
            toolVersion: '1',
            payload: {
              spreadsheet_id: 'sheet-1',
              range: 'A1',
              values: [['=IMPORTXML("https://example.invalid", "//a")']],
              value_input: 'raw',
            },
            approverMembershipId: t.owner.membershipId,
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('0565: a member’s own consent belongs to the member who started it (review finding 3)', () => {
    type Tenant = Awaited<ReturnType<typeof tenant>>;
    /** Alex's own consent, started as the application starts one, as a source for its sealed IDs. */
    const startOwn = async (t: Tenant) => {
      const web: OAuthWebSide = {
        seal: async () => randomUUID(),
        redirectUri: 'https://ensemus.example.invalid/api/v1/oauth/callback',
        platformClientId: () => 'generated-client.apps.example.invalid',
      };
      const started = await startAuthorization(
        db(),
        t.alex,
        {
          connectorType: 'google_workspace',
          displayName: 'My account',
          config: {},
          capabilities: ['mail'],
          owner: 'member',
          client: { kind: 'platform' },
        },
        web,
      );
      const [row] = await withTenantTx(db(), t.alex, (tx) =>
        tx
          .select()
          .from(oauthAuthorizations)
          .where(eq(oauthAuthorizations.id, started.authorizationId)),
      );
      return row!;
    };

    it('refuses a member starting a consent owned by another member', async () => {
      const t = await tenant();
      const own = await startOwn(t);
      const refused = await withTenantTx(db(), t.alex, (tx) =>
        tx.insert(oauthAuthorizations).values({
          organizationId: t.organizationId,
          connectorType: 'google_workspace',
          displayName: 'Someone else’s account',
          config: {},
          clientKind: own.clientKind,
          clientId: own.clientId,
          requestedCapabilities: ['mail'],
          requestedScopes: own.requestedScopes,
          ownerMembershipId: t.sam.membershipId,
          startedByMembershipId: t.alex.membershipId,
          stateSha256: 'a'.repeat(64),
          verifierSecretId: own.verifierSecretId,
          expiresAt: new Date(),
        }),
      ).catch((error: unknown) => error);
      expect(pgCode(refused)).toBe('EN121');
    });

    it('refuses the exchange making a member’s connection owned by anyone but its creator', async () => {
      const t = await tenant();
      const own = await startOwn(t);
      // An attempt 0563 now refuses, written past the application roles and moved on to the exchange,
      // so only 0565's added condition stands between it and a connection.
      const forged = randomUUID();
      await fixture(
        t.organizationId,
        `insert into integrations.oauth_authorizations
           (organization_id, id, connector_type, display_name, config, client_kind, client_id,
            requested_capabilities, requested_scopes, owner_membership_id, started_by_membership_id,
            state_sha256, verifier_secret_id, expires_at)
         select organization_id, $2, connector_type, display_name, config, client_kind, client_id,
                requested_capabilities, requested_scopes, $3, started_by_membership_id,
                $4, verifier_secret_id, expires_at
           from integrations.oauth_authorizations where id = $1`,
        [own.id, forged, t.sam.membershipId, 'b'.repeat(64)],
      );
      for (const id of [forged, own.id]) {
        await fixture(
          t.organizationId,
          `update integrations.oauth_authorizations
              set status = 'code_received', code_secret_id = verifier_secret_id where id = $1`,
          [id],
        );
        await fixture(
          t.organizationId,
          `update integrations.oauth_authorizations set status = 'exchanging' where id = $1`,
          [id],
        );
      }
      const exchange = (authorizationId: string, ownerMembershipId: string) =>
        withTenantTx(db(), createServiceContext(t.organizationId), async (tx) => {
          await tx.execute(
            sql`select set_config('ensemus.oauth_exchange', ${authorizationId}, true)`,
          );
          await tx.insert(connections).values({
            organizationId: t.organizationId,
            connectorType: 'google_workspace',
            displayName: 'My account',
            state: 'active',
            credentialSecretId: own.verifierSecretId,
            config: {},
            grantedScopes: [google('gmail.readonly')],
            createdByMembershipId: t.alex.membershipId,
            ownerMembershipId,
          });
        }).catch((error: unknown) => error);
      expect(pgCode(await exchange(forged, t.sam.membershipId))).toBe('EN121');
      // The same exchange for the member who started it still connects.
      expect(await exchange(own.id, t.alex.membershipId)).toBeUndefined();
    });
  });

  // Owed with the agent role and a seeded run (tests/helpers/delegated-child.ts has the pattern): the
  // gateway's request in its gate transaction, the worker's claim refusing a revoked connection and a
  // stopped run, finishSuiteRead refusing an output naming a resource the initiator's ACL does not grant,
  // and the agent's collect clearing the output.
});
