// ADR-038 D5 and D6 against the real database and migration 0563: the connection rule on M3's intent path,
// drafts that ask nobody, the suite read table nobody but the agent role and the connector worker can
// see, the members' capability setting, and a member's own consent. Generated values only. Written, not
// yet run: owed to the first stack run.
import { randomUUID } from 'node:crypto';
import {
  createWorkUnit,
  pgCode,
  proposeDraftActionInTx,
  proposeExternalActionInTx,
  startAuthorization,
  type OAuthWebSide,
} from '@ensemus/application';
import { listUsableConnections } from '@ensemus/application/suite-connections';
import {
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
import { urls } from '../helpers/stack';

const google = (scope: string) => `https://www.googleapis.com/auth/${scope}`;
const message = { to: ['someone@example.invalid'], subject: 'Hello', text_body: 'Synthetic.' };

describe('suite tools (ADR-038 D6)', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  /** Writes a member's own connection, which only a consent may make under the application roles. */
  let superuser: pg.Client;
  const db = () => app.db;

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
      await superuser.query(
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

  // Owed with the agent role and a seeded run (tests/helpers/delegated-child.ts has the pattern): the
  // gateway's request in its gate transaction, the worker's claim refusing a revoked connection and a
  // stopped run, finishSuiteRead refusing an output naming a resource the initiator's ACL does not grant,
  // and the agent's collect clearing the output.
});
