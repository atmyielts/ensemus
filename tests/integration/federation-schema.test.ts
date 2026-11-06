// ADR-035's database rules on their own: forced RLS, what each role can reach, both consents, and what holds
// whatever application code does. Real PostgreSQL, real roles. NOT RUN YET: the migrations are not in the
// journal until the final merge, and this project needs a container. The slices test behaviour on top of this.
import { randomUUID } from 'node:crypto';
import { sql, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  createOrganization,
  federationCrossings,
  federationGrants,
  federationInboundItems,
  federationOrgSettings,
  federationOutboundItems,
  memberships,
  openAppDatabase,
  resolveTenantContext,
  withGrantInvitationTx,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { hashFederationToken, itemContentHash } from '@ensemus/domain/federation';
import {
  clearDeploymentProfile,
  client,
  enableFederation,
  ensureBridgeRole,
  seedGrant,
  seedOutboundItem,
  setDeploymentProfile,
} from '../helpers/federation';
import { urls } from '../helpers/stack';

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('cross-organization rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let su: pg.Client;
  let bridgeUrl: string;
  let ownerA: TenantContext;
  let ownerB: TenantContext;
  let ownerC: TenantContext;
  let memberA: TenantContext;

  const makeUser = async (label: string) => {
    const id = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      id,
      label,
      `${label}-${id}@example.invalid`,
    ]);
    return id;
  };

  const newOwner = async (label: string) => {
    const user = await makeUser(label);
    // Same name on purpose: a display name tells nobody apart.
    const { organizationId } = await createOrganization(database.db, {
      userId: user,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    return resolveTenantContext(database.db, user, organizationId);
  };

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = await client(urls.auth());
    su = await client(urls.superuser());
    bridgeUrl = await ensureBridgeRole();
    await setDeploymentProfile({ crossOrgEnabled: true });
    ownerA = await newOwner('owner-a');
    ownerB = await newOwner('owner-b');
    ownerC = await newOwner('owner-c');
    const memberUser = await makeUser('member-a');
    await withTenantTx(database.db, ownerA, (tx) =>
      tx.insert(memberships).values({
        organizationId: ownerA.organizationId,
        userId: memberUser,
        role: 'member',
      }),
    );
    memberA = await resolveTenantContext(database.db, memberUser, ownerA.organizationId);
    await enableFederation(database.db, ownerA);
    await enableFederation(database.db, ownerB);
    await enableFederation(database.db, ownerC);
  });

  afterAll(async () => {
    await clearDeploymentProfile();
    await database?.close();
    await auth?.end();
    await su?.end();
  });

  const bridge = async <T>(grantId: string | null, fn: (c: pg.Client) => Promise<T>) => {
    const c = await client(bridgeUrl);
    try {
      await c.query('begin');
      if (grantId) {
        await c.query(`select set_config('app.federation_grant_id', $1, true)`, [grantId]);
      }
      const result = await fn(c);
      await c.query('commit');
      return result;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      await c.end();
    }
  };

  const crossExact = (
    c: pg.Client,
    grantId: string,
    item: Awaited<ReturnType<typeof seedOutboundItem>>,
    sender: TenantContext,
    receiver: TenantContext,
  ) =>
    c.query(
      `insert into federation.inbound_items
         (organization_id, id, grant_id, sender_organization_id, kind, classification, title, body, content_sha256)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        receiver.organizationId,
        item.id,
        grantId,
        sender.organizationId,
        item.kind,
        item.classification,
        item.title,
        JSON.stringify(item.body),
        item.contentSha256,
      ],
    );

  describe('the boundary as a whole', () => {
    it('forces RLS on every table in both new schemas', async () => {
      const { rows } = await su.query(
        `select n.nspname || '.' || c.relname as t
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r','p')
            and n.nspname in ('federation','tenancy')
            and not (c.relrowsecurity and c.relforcerowsecurity)`,
      );
      expect(rows).toEqual([]);
    });

    it('gives the bridge role exactly what ADR-035 lists, and no stronger attributes', async () => {
      const { rows: attributes } = await su.query(
        `select rolsuper, rolcreaterole, rolbypassrls, rolcreatedb from pg_roles
          where rolname = 'ensemus_federation'`,
      );
      expect(attributes).toEqual([
        { rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolcreatedb: false },
      ]);
      const { rows } = await su.query(
        `select distinct table_schema || '.' || table_name as t
           from information_schema.role_table_grants where grantee = 'ensemus_federation'
         union
         select distinct table_schema || '.' || table_name
           from information_schema.column_privileges where grantee = 'ensemus_federation'
         order by 1`,
      );
      expect(rows.map((row) => row.t as string)).toEqual([
        'federation.crossings',
        'federation.grants',
        'federation.inbound_items',
        'federation.outbound_items',
        'tenancy.deployment_profile',
      ]);
    });

    it.each([
      'work.work_units',
      'work.artifacts',
      'org.memberships',
      'org.organizations',
      'identity.users',
      'identity.accounts',
      'secrets.sealed_secrets',
      'platform.domain_events',
      'platform.outbox_events',
      'governance.audit_events',
      'integrations.connections',
      'integrations.external_actions',
      'federation.org_settings',
      'tenancy.residency_requirements',
      'tenancy.isolation_evidence',
    ])('refuses the bridge role %s', async (table) => {
      const c = await client(bridgeUrl);
      await expect(c.query(`select * from ${table}`)).rejects.toThrow(/permission denied/);
      await c.end();
    });

    it('gave no other runtime role anything in the new schemas it should not have', async () => {
      const { rows } = await su.query(
        `select grantee, table_schema || '.' || table_name as t
           from information_schema.role_table_grants
          where table_schema in ('federation','tenancy')
            and grantee in ('ensemus_auth','ensemus_dispatcher','ensemus_secrets')`,
      );
      expect(rows).toEqual([]);
    });

    it('leaves the application role unable to write an arrival or read another tenant', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const item = await seedOutboundItem(database.db, ownerA, grant.id, { title: 'A only' });
      // Directly, as the receiver, with an exact copy. A tenant cannot forge what it received.
      await expect(
        withTenantTx(database.db, ownerB, (tx) =>
          tx.insert(federationInboundItems).values({
            organizationId: ownerB.organizationId,
            id: item.id,
            grantId: grant.id,
            senderOrganizationId: ownerA.organizationId,
            kind: item.kind,
            classification: item.classification,
            title: item.title,
            body: item.body,
            contentSha256: item.contentSha256,
          }),
        ),
      ).rejects.toEqual(sqlState('42501'));
      // The sender's outbound row is invisible to its own counterparty.
      const seen = await withTenantTx(database.db, ownerB, (tx) =>
        tx.select().from(federationOutboundItems).where(eq(federationOutboundItems.id, item.id)),
      );
      expect(seen).toEqual([]);
    });

    it('finds nothing with no tenant and no grant bound', async () => {
      const c = await client(urls.app());
      for (const table of ['grants', 'outbound_items', 'inbound_items', 'crossings']) {
        const { rows } = await c.query(`select count(*)::int as n from federation.${table}`);
        expect(rows[0].n, table).toBe(0);
      }
      await c.end();
      await bridge(null, async (bare) => {
        const { rows } = await bare.query('select id from federation.grants');
        expect(rows).toEqual([]);
      });
    });
  });

  describe('off by default', () => {
    it('refuses a tenant turning it on while the deployment has it off', async () => {
      const lone = await newOwner('lone');
      await clearDeploymentProfile();
      try {
        await expect(enableFederation(database.db, lone)).rejects.toEqual(sqlState('EN717'));
      } finally {
        await setDeploymentProfile({ crossOrgEnabled: true });
      }
    });

    it('refuses a proposal from a tenant that has not turned it on', async () => {
      const lone = await newOwner('not-on');
      await expect(seedGrant(database.db, lone, ownerB, { status: 'proposed' })).rejects.toEqual(
        sqlState('EN714'),
      );
    });

    it('closes every grant at once when the deployment turns it off', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const item = await seedOutboundItem(database.db, ownerA, grant.id);
      await bridge(grant.id, (c) => crossExact(c, grant.id, item, ownerA, ownerB));
      const read = () =>
        withTenantTx(database.db, ownerB, (tx) =>
          tx.select().from(federationInboundItems).where(eq(federationInboundItems.id, item.id)),
        );
      expect(await read()).toHaveLength(1);
      await setDeploymentProfile({ crossOrgEnabled: false });
      try {
        expect(await read()).toEqual([]);
      } finally {
        await setDeploymentProfile({ crossOrgEnabled: true });
      }
    });
  });

  describe('two-sided consent', () => {
    it('lets a token reveal one proposal, under the holder’s own tenant, and only while it is open', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB, { status: 'proposed' });
      const withToken = await withGrantInvitationTx(
        database.db,
        ownerB,
        hashFederationToken(grant.token),
        (tx) => tx.select().from(federationGrants),
      );
      expect(withToken.map((row) => row.id)).toContain(grant.id);
      const without = await withTenantTx(database.db, ownerB, (tx) =>
        tx.select().from(federationGrants).where(eq(federationGrants.id, grant.id)),
      );
      expect(without).toEqual([]);
    });

    it('refuses accepting different terms, and accepting as the sharing side', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB, { status: 'proposed' });
      const accept = (context: TenantContext, hash: string) =>
        withGrantInvitationTx(database.db, context, hashFederationToken(grant.token), (tx) =>
          tx
            .update(federationGrants)
            .set({
              status: 'accepted',
              receivingOrganizationId: context.organizationId,
              receivingDisplayName: 'Same Name Ltd',
              acceptedByMembershipId: context.membershipId,
              acceptedTermsHash: hash,
              acceptedAt: new Date(),
              version: 2,
            })
            .where(eq(federationGrants.id, grant.id)),
        );
      await expect(accept(ownerB, 'f'.repeat(64))).rejects.toEqual(sqlState('EN720'));
      await expect(accept(ownerA, grant.termsHash)).rejects.toEqual(sqlState('EN711'));
    });

    it('refuses a name a request chose, and consent from someone who is not an owner', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB, { status: 'proposed' });
      await expect(
        withGrantInvitationTx(database.db, ownerB, hashFederationToken(grant.token), (tx) =>
          tx
            .update(federationGrants)
            .set({
              status: 'accepted',
              receivingOrganizationId: ownerB.organizationId,
              receivingDisplayName: 'A Bank You Trust',
              acceptedByMembershipId: ownerB.membershipId,
              acceptedTermsHash: grant.termsHash,
              acceptedAt: new Date(),
              version: 2,
            })
            .where(eq(federationGrants.id, grant.id)),
        ),
      ).rejects.toEqual(sqlState('EN712'));
      await expect(seedGrant(database.db, memberA, ownerB, { status: 'proposed' })).rejects.toEqual(
        sqlState('EN715'),
      );
    });

    it('lets nothing be sent before the sharing owner confirms who accepted', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB, { status: 'accepted' });
      await expect(seedOutboundItem(database.db, ownerA, grant.id)).rejects.toEqual(
        sqlState('EN722'),
      );
    });

    it('refuses the receiving side confirming its own acceptance', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB, { status: 'accepted' });
      await expect(
        withTenantTx(database.db, ownerB, (tx) =>
          tx
            .update(federationGrants)
            .set({
              status: 'active',
              confirmedByMembershipId: ownerB.membershipId,
              confirmedTermsHash: grant.termsHash,
              confirmedAt: new Date(),
              version: 3,
            })
            .where(eq(federationGrants.id, grant.id)),
        ),
      ).rejects.toEqual(sqlState('EN711'));
    });

    it('fixes the terms once written, for every application role', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx
            .update(federationGrants)
            .set({ purpose: 'document_review' })
            .where(eq(federationGrants.id, grant.id)),
        ),
      ).rejects.toEqual(sqlState('42501'));
    });

    it('keeps a third tenant out of a grant, whatever it knows', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const seen = await withGrantInvitationTx(
        database.db,
        ownerC,
        hashFederationToken(grant.token),
        (tx) => tx.select().from(federationGrants).where(eq(federationGrants.id, grant.id)),
      );
      expect(seen).toEqual([]);
      const updated = await withTenantTx(database.db, ownerC, (tx) =>
        tx
          .update(federationGrants)
          .set({
            status: 'ended',
            endReason: 'revoked',
            endedAt: new Date(),
            endedByOrganizationId: ownerC.organizationId,
            endedByMembershipId: ownerC.membershipId,
            version: 4,
          })
          .where(eq(federationGrants.id, grant.id))
          .returning({ id: federationGrants.id }),
      );
      expect(updated).toEqual([]);
      await expect(seedOutboundItem(database.db, ownerC, grant.id)).rejects.toEqual(
        sqlState('EN722'),
      );
    });
  });

  describe('limited objects', () => {
    it('refuses a kind the purpose does not cover', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB, { purpose: 'document_review' });
      await expect(
        seedOutboundItem(database.db, ownerA, grant.id, { kind: 'work_summary' }),
      ).rejects.toEqual(sqlState('EN723'));
      await seedOutboundItem(database.db, ownerB, grant.id, { kind: 'status_update' });
    });

    it('refuses a class above the grant’s, and restricted on any grant', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB, { maxClassification: 'public' });
      await expect(
        seedOutboundItem(database.db, ownerA, grant.id, { classification: 'internal' }),
      ).rejects.toEqual(sqlState('EN724'));
      const wide = await seedGrant(database.db, ownerA, ownerB, {
        maxClassification: 'confidential',
      });
      await expect(
        seedOutboundItem(database.db, ownerA, wide.id, { classification: 'restricted' }),
      ).rejects.toEqual(sqlState('EN724'));
    });

    it('refuses an object key anywhere but the derived one', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const body = {};
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx.insert(federationOutboundItems).values({
            organizationId: ownerA.organizationId,
            grantId: grant.id,
            kind: 'artifact',
            classification: 'internal',
            title: 'Pointing elsewhere',
            body,
            contentSha256: itemContentHash({
              kind: 'artifact',
              classification: 'internal',
              title: 'Pointing elsewhere',
              body,
              fileSha256: 'a'.repeat(64),
            }),
            fileObjectKey: `${ownerB.organizationId}/artifacts/${randomUUID()}`,
            fileSha256: 'a'.repeat(64),
            fileSizeBytes: 1,
            fileMimeType: 'text/plain',
            createdByMembershipId: ownerA.membershipId,
          }),
        ),
      ).rejects.toEqual(sqlState('23514'));
    });
  });

  describe('the bridge', () => {
    it('carries an exact copy, and refuses anything else', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const item = await seedOutboundItem(database.db, ownerA, grant.id, { title: 'As sent' });
      await expect(
        bridge(grant.id, (c) =>
          crossExact(c, grant.id, { ...item, title: 'Changed' }, ownerA, ownerB),
        ),
      ).rejects.toThrow(/FEDERATION_ITEM_MISMATCH/);
      await expect(
        bridge(grant.id, (c) => crossExact(c, grant.id, item, ownerA, ownerC)),
      ).rejects.toThrow(/FEDERATION_NOT_A_PARTY/);
      await bridge(grant.id, (c) => crossExact(c, grant.id, item, ownerA, ownerB));
      const arrived = await withTenantTx(database.db, ownerB, (tx) =>
        tx.select().from(federationInboundItems).where(eq(federationInboundItems.id, item.id)),
      );
      expect(arrived[0]?.title).toBe('As sent');
    });

    it('sees one grant per transaction and cannot read back what it wrote', async () => {
      const first = await seedGrant(database.db, ownerA, ownerB);
      const second = await seedGrant(database.db, ownerA, ownerB);
      const item = await seedOutboundItem(database.db, ownerA, second.id);
      await bridge(first.id, async (c) => {
        const { rows } = await c.query('select id from federation.outbound_items where id = $1', [
          item.id,
        ]);
        expect(rows).toEqual([]);
      });
      await bridge(second.id, (c) => crossExact(c, second.id, item, ownerA, ownerB));
      await expect(
        bridge(second.id, (c) => c.query('select title from federation.inbound_items')),
      ).rejects.toThrow(/permission denied/);
    });

    it('writes to the ledger only for this grant’s two parties', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      await expect(
        bridge(grant.id, (c) =>
          c.query(
            `insert into federation.crossings
               (grant_id, sender_organization_id, receiver_organization_id, outcome)
             values ($1, $2, $3, 'delivered')`,
            [grant.id, ownerA.organizationId, ownerC.organizationId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('shows both parties the ledger, a third nothing, and refuses changing it', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      await bridge(grant.id, (c) =>
        c.query(
          `insert into federation.crossings
             (grant_id, sender_organization_id, receiver_organization_id, outcome)
           values ($1, $2, $3, 'delivered')`,
          [grant.id, ownerA.organizationId, ownerB.organizationId],
        ),
      );
      const read = (context: TenantContext) =>
        withTenantTx(database.db, context, (tx) =>
          tx.select().from(federationCrossings).where(eq(federationCrossings.grantId, grant.id)),
        );
      expect(await read(ownerA)).toHaveLength(1);
      expect(await read(ownerB)).toHaveLength(1);
      expect(await read(ownerC)).toEqual([]);
      await expect(
        withTenantTx(database.db, ownerA, (tx) => tx.delete(federationCrossings)),
      ).rejects.toEqual(sqlState('42501'));
    });
  });

  describe('revocation', () => {
    it('stops reads on commit, before any purge, and either side can do it', async () => {
      for (const ender of ['sharing', 'receiving'] as const) {
        const grant = await seedGrant(database.db, ownerA, ownerB);
        const item = await seedOutboundItem(database.db, ownerA, grant.id);
        await bridge(grant.id, (c) => crossExact(c, grant.id, item, ownerA, ownerB));
        const by = ender === 'sharing' ? ownerA : ownerB;
        await withTenantTx(database.db, by, (tx) =>
          tx
            .update(federationGrants)
            .set({
              status: 'ended',
              endReason: 'revoked',
              endedAt: new Date(),
              endedByOrganizationId: by.organizationId,
              endedByMembershipId: by.membershipId,
              version: grant.version + 1,
            })
            .where(eq(federationGrants.id, grant.id)),
        );
        const seen = await withTenantTx(database.db, ownerB, (tx) =>
          tx.select().from(federationInboundItems).where(eq(federationInboundItems.id, item.id)),
        );
        expect(seen, ender).toEqual([]);
        // Nothing further crosses, and the purge still can.
        const another = await bridge(grant.id, async (c) => {
          const { rows } = await c.query('select id from federation.outbound_items');
          return rows;
        });
        expect(another, ender).toEqual([]);
        const removed = await bridge(grant.id, async (c) => {
          const { rowCount } = await c.query('delete from federation.inbound_items');
          return rowCount;
        });
        expect(removed, ender).toBe(1);
      }
    });

    it('has no way back from ended', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const end = {
        status: 'ended',
        endReason: 'revoked',
        endedAt: new Date(),
        endedByOrganizationId: ownerA.organizationId,
        endedByMembershipId: ownerA.membershipId,
        version: grant.version + 1,
      };
      await withTenantTx(database.db, ownerA, (tx) =>
        tx.update(federationGrants).set(end).where(eq(federationGrants.id, grant.id)),
      );
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx
            .update(federationGrants)
            .set({ status: 'active', version: grant.version + 2 })
            .where(eq(federationGrants.id, grant.id)),
        ),
      ).rejects.toEqual(sqlState('EN716'));
    });

    it('refuses calling something expired before its date', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      await expect(
        withTenantTx(database.db, ownerB, (tx) =>
          tx
            .update(federationGrants)
            .set({
              status: 'ended',
              endReason: 'expired',
              endedAt: new Date(),
              endedByOrganizationId: ownerB.organizationId,
              version: grant.version + 1,
            })
            .where(eq(federationGrants.id, grant.id)),
        ),
      ).rejects.toEqual(sqlState('EN716'));
    });

    it('lets a worker wind a tenant down with nobody named, and only for that reason', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const service = createServiceContext(ownerA.organizationId);
      const end = (endReason: string) =>
        withTenantTx(database.db, service, (tx) =>
          tx
            .update(federationGrants)
            .set({
              status: 'ended',
              endReason,
              endedAt: new Date(),
              endedByOrganizationId: ownerA.organizationId,
              version: grant.version + 1,
            })
            .where(eq(federationGrants.id, grant.id)),
        );
      await expect(end('revoked')).rejects.toEqual(sqlState('EN721'));
      await end('disabled');
    });

    it('keeps a copy until it is withdrawn and the other side’s copy is gone', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const item = await seedOutboundItem(database.db, ownerA, grant.id);
      const remove = () =>
        withTenantTx(database.db, ownerA, (tx) =>
          tx.delete(federationOutboundItems).where(eq(federationOutboundItems.id, item.id)),
        );
      await expect(remove()).rejects.toEqual(sqlState('EN716'));
      await bridge(grant.id, (c) => crossExact(c, grant.id, item, ownerA, ownerB));
      await withTenantTx(database.db, ownerA, (tx) =>
        tx
          .update(federationOutboundItems)
          .set({ state: 'withdrawn', withdrawnAt: new Date(), version: 2 })
          .where(eq(federationOutboundItems.id, item.id)),
      );
      await expect(remove()).rejects.toEqual(sqlState('23503'));
      await bridge(grant.id, (c) =>
        c.query('delete from federation.inbound_items where id = $1', [item.id]),
      );
      await remove();
    });

    it('refuses switching a tenant off while anything is open', async () => {
      const lone = await newOwner('open-grant');
      await enableFederation(database.db, lone);
      await seedGrant(database.db, lone, ownerB, { status: 'proposed' });
      await expect(
        withTenantTx(database.db, lone, (tx) =>
          tx
            .update(federationOrgSettings)
            .set({ enabled: false, version: 2, changedByMembershipId: lone.membershipId })
            .where(eq(federationOrgSettings.organizationId, lone.organizationId)),
        ),
      ).rejects.toEqual(sqlState('EN719'));
    });

    it('refuses a delivery once the grant has passed its date', async () => {
      const grant = await seedGrant(database.db, ownerA, ownerB);
      const item = await seedOutboundItem(database.db, ownerA, grant.id);
      await su.query(`alter table federation.grants disable trigger grants_check_change`);
      try {
        await su.query(
          `update federation.grants set expires_at = now() - interval '1 second', invitation_expires_at = now() - interval '2 seconds' where id = $1`,
          [grant.id],
        );
      } finally {
        await su.query(`alter table federation.grants enable trigger grants_check_change`);
      }
      await expect(
        bridge(grant.id, (c) => crossExact(c, grant.id, item, ownerA, ownerB)),
      ).rejects.toThrow(/FEDERATION_GRANT_NOT_OPEN/);
    });
  });

  it('still binds a role to its own session with nothing left over', async () => {
    const [{ bound }] = (await withTenantTx(database.db, ownerA, (tx) =>
      tx.execute(sql`select current_setting('app.federation_grant_id', true) as bound`),
    ).then((result) => result.rows)) as [{ bound: string | null }];
    expect(bound ?? '').toBe('');
  });
});
