// ADR-031's database rules on their own: forced RLS, what each role can reach, and the triggers that hold the
// rules whatever application code does. Real PostgreSQL, real roles. The slices test behaviour on top of this,
// and each writes its own file. Needs the migrations in 0400 and 0401 to have been stitched into the journal.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkUnit } from '@ensemus/application';
import { assertRecentMfa } from '@ensemus/application/privileged';
import { openAppDatabase, withTenantTx } from '@ensemus/database';
import {
  objectRecords,
  objectTypes,
  objectTypeVersions,
  packCapabilityReviews,
  packInstallations,
  processSpecs,
  publishReviews,
  pulseSignalStates,
  scimTokens,
  simulationRuns,
  ssoConnections,
  withScimTokenTx,
  withSsoProviderTx,
} from '@ensemus/database/product';
import { and, eq, sql } from 'drizzle-orm';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

const client = async (url: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

const HASH = 'a'.repeat(64);

describe('product rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  let su: pg.Client;

  beforeAll(async () => {
    database = openAppDatabase(urls.app(), { max: 2 });
    tenants = await makeTwoTenants(database.db);
    su = await client(urls.superuser());
  });

  afterAll(async () => {
    await database?.close();
    await su?.end();
  });

  const seedSimulation = async (
    status: 'passed' | 'failed' = 'passed',
    subjectId = randomUUID(),
  ) => {
    const { owner } = tenants.a;
    const id = randomUUID();
    await withTenantTx(database.db, owner.context, async (tx) => {
      await tx.insert(simulationRuns).values({
        organizationId: owner.context.organizationId,
        id,
        subjectKind: 'agent_draft',
        subjectId,
        subjectSha256: HASH,
        scenarioKey: 'test',
        requestedByMembershipId: owner.context.membershipId,
      });
      await tx.update(simulationRuns).set({ status: 'running' }).where(eq(simulationRuns.id, id));
      await tx
        .update(simulationRuns)
        .set({ status, report: {}, reportSha256: HASH })
        .where(eq(simulationRuns.id, id));
    });
    return { id, subjectId };
  };

  it('gives the dispatcher and the secrets role nothing in the new schemas', async () => {
    const { rows } = await su.query(
      `select grantee, table_schema, table_name from information_schema.role_table_grants
        where grantee in ('ensemus_dispatcher','ensemus_secrets')
          and table_schema in ('studio','objects','packs','experience')`,
    );
    expect(rows).toEqual([]);
  });

  it('keeps TOTP secrets and provider settings away from the application role', async () => {
    const app = await client(urls.app());
    try {
      await expect(app.query('select secret from identity.two_factors')).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query('select saml_config from identity.sso_providers')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await app.end();
    }
  });

  it('does not let the application role say a session proved anything', async () => {
    const app = await client(urls.app());
    try {
      await expect(
        app.query(
          `insert into identity.session_assurances (session_id, kind, user_id, verified_at)
           values ($1, 'mfa_totp', $2, now())`,
          [tenants.a.member.sessionId, tenants.a.member.userId],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        app.query(`update identity.session_assurances set verified_at = now()`),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  describe('recent MFA', () => {
    const attempt = (person: typeof tenants.a.owner, sessionId: string | null) =>
      withTenantTx(database.db, person.context, (tx) =>
        assertRecentMfa(tx, person.context, 'studio.publish', sessionId ? { sessionId } : null),
      );

    it('refuses no proof, someone else’s session, and an old proof, and accepts a recent one', async () => {
      const { admin, member } = tenants.a;
      await expect(attempt(admin, admin.sessionId)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
      await expect(attempt(admin, null)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });

      await proveSecondFactor(member);
      await expect(attempt(admin, member.sessionId)).rejects.toMatchObject({
        code: 'MFA_REQUIRED',
      });

      await proveSecondFactor(admin, new Date(Date.now() - 60 * 60 * 1000));
      await expect(attempt(admin, admin.sessionId)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });

      await proveSecondFactor(admin);
      await expect(attempt(admin, admin.sessionId)).resolves.toBeUndefined();
    });
  });

  describe('SSO', () => {
    const connection = async (domain: string) => {
      const { owner } = tenants.a;
      const id = randomUUID();
      const providerId = `saml-${id}`;
      await withTenantTx(database.db, owner.context, (tx) =>
        tx.insert(ssoConnections).values({
          organizationId: owner.context.organizationId,
          id,
          providerId,
          displayName: 'Test provider',
          domain,
          createdByMembershipId: owner.context.membershipId,
        }),
      );
      return { id, providerId };
    };

    it('does not let a tenant verify its own domain, however it asks', async () => {
      const { owner } = tenants.a;
      const { id } = await connection(`${randomUUID()}.example.invalid`);
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx
            .update(ssoConnections)
            .set({ domainState: 'verified' })
            .where(eq(ssoConnections.id, id)),
        ),
      ).rejects.toThrow();
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx.insert(ssoConnections).values({
            organizationId: owner.context.organizationId,
            providerId: `saml-${randomUUID()}`,
            displayName: 'Claiming',
            domain: `${randomUUID()}.example.invalid`,
            domainState: 'verified',
            createdByMembershipId: owner.context.membershipId,
          }),
        ),
      ).rejects.toEqual(sqlState('EN401'));
    });

    it('will not activate an unverified domain', async () => {
      const { owner } = tenants.a;
      const { id } = await connection(`${randomUUID()}.example.invalid`);
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx.update(ssoConnections).set({ state: 'active' }).where(eq(ssoConnections.id, id)),
        ),
      ).rejects.toThrow();
    });

    it('finds nothing through a provider nobody verified', async () => {
      const { providerId } = await connection(`${randomUUID()}.example.invalid`);
      const found = await withSsoProviderTx(database.db, providerId, async () => 'reached');
      expect(found).toBeNull();
    });

    it('does not let two tenants hold a verified domain', async () => {
      const domain = `${randomUUID()}.example.invalid`;
      const first = await connection(domain);
      const { owner } = tenants.b;
      const secondId = randomUUID();
      await withTenantTx(database.db, owner.context, (tx) =>
        tx.insert(ssoConnections).values({
          organizationId: owner.context.organizationId,
          id: secondId,
          providerId: `saml-${secondId}`,
          displayName: 'Other tenant',
          domain,
          createdByMembershipId: owner.context.membershipId,
        }),
      );
      await su.query(`update org.sso_connections set domain_state = 'verified' where id = $1`, [
        first.id,
      ]);
      await expect(
        su.query(`update org.sso_connections set domain_state = 'verified' where id = $1`, [
          secondId,
        ]),
      ).rejects.toThrow(/sso_connections_verified_domain_idx/);
    });

    it('binds a SCIM token to its own tenant and nothing else', async () => {
      const { owner } = tenants.a;
      const { id } = await connection(`${randomUUID()}.example.invalid`);
      await su.query(
        `update org.sso_connections set domain_state = 'verified', state = 'active' where id = $1`,
        [id],
      );
      const tokenHash = randomUUID();
      await withTenantTx(database.db, owner.context, (tx) =>
        tx.insert(scimTokens).values({
          organizationId: owner.context.organizationId,
          connectionId: id,
          tokenHash,
          createdByMembershipId: owner.context.membershipId,
        }),
      );
      const reached = await withScimTokenTx(database.db, tokenHash, async (_tx, scope) => ({
        organizationId: scope.context.organizationId,
        actorType: scope.context.actorType,
      }));
      expect(reached).toEqual({
        organizationId: owner.context.organizationId,
        actorType: 'service',
      });
      expect(await withScimTokenTx(database.db, 'nope', async () => 'reached')).toBeNull();
    });
  });

  describe('simulations and reviews', () => {
    it('cannot start a simulation past queued, or change a finished one', async () => {
      const { owner } = tenants.a;
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx.insert(simulationRuns).values({
            organizationId: owner.context.organizationId,
            subjectKind: 'agent_draft',
            subjectId: randomUUID(),
            subjectSha256: HASH,
            scenarioKey: 'test',
            status: 'passed',
            report: {},
            reportSha256: HASH,
            requestedByMembershipId: owner.context.membershipId,
          }),
        ),
      ).rejects.toEqual(sqlState('EN401'));
      const { id } = await seedSimulation();
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx.update(simulationRuns).set({ status: 'failed' }).where(eq(simulationRuns.id, id)),
        ),
      ).rejects.toEqual(sqlState('EN401'));
    });

    it('cannot change which hash a simulation is about', async () => {
      const { id } = await seedSimulation();
      const { owner } = tenants.a;
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx
            .update(simulationRuns)
            .set({ subjectSha256: 'b'.repeat(64) })
            .where(eq(simulationRuns.id, id)),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    const review = (
      simulationRunId: string,
      subjectId: string,
      overrides: Partial<typeof publishReviews.$inferInsert> = {},
    ) => {
      const { owner } = tenants.a;
      return withTenantTx(database.db, owner.context, async (tx) => {
        const [row] = await tx
          .insert(publishReviews)
          .values({
            organizationId: owner.context.organizationId,
            subjectKind: 'agent_draft',
            subjectId,
            subjectSha256: HASH,
            simulationRunId,
            riskLevel: 'elevated',
            riskSummary: [],
            requestedByMembershipId: owner.context.membershipId,
            ...overrides,
          })
          .returning({ id: publishReviews.id });
        return row!.id;
      });
    };

    it('needs a passed simulation of exactly this hash', async () => {
      const failed = await seedSimulation('failed');
      await expect(review(failed.id, failed.subjectId)).rejects.toEqual(sqlState('EN402'));
      const passed = await seedSimulation();
      await expect(
        review(passed.id, passed.subjectId, { subjectSha256: 'b'.repeat(64) }),
      ).rejects.toEqual(sqlState('EN402'));
      await expect(review(passed.id, randomUUID())).rejects.toEqual(sqlState('EN402'));
    });

    it('needs a second person for elevated risk, whatever the application does', async () => {
      const { owner, admin } = tenants.a;
      const passed = await seedSimulation();
      const id = await review(passed.id, passed.subjectId);
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx
            .update(publishReviews)
            .set({
              status: 'approved',
              decidedByMembershipId: owner.context.membershipId,
              decidedAt: new Date(),
            })
            .where(eq(publishReviews.id, id)),
        ),
      ).rejects.toEqual(sqlState('EN402'));
      await withTenantTx(database.db, admin.context, (tx) =>
        tx
          .update(publishReviews)
          .set({
            status: 'approved',
            decidedByMembershipId: admin.context.membershipId,
            decidedAt: new Date(),
          })
          .where(eq(publishReviews.id, id)),
      );
    });
  });

  it('keeps a process spec exactly as it was published, for every role', async () => {
    const { owner } = tenants.a;
    const id = randomUUID();
    await withTenantTx(database.db, owner.context, (tx) =>
      tx.insert(processSpecs).values({
        organizationId: owner.context.organizationId,
        id,
        processKey: `test-${randomUUID().slice(0, 8)}`,
        versionNumber: 1,
        name: 'Test',
        classification: 'internal',
        spec: {},
        specSha256: HASH,
        source: 'graph',
        publishedByMembershipId: owner.context.membershipId,
      }),
    );
    await expect(
      withTenantTx(database.db, owner.context, (tx) =>
        tx.update(processSpecs).set({ name: 'Other' }).where(eq(processSpecs.id, id)),
      ),
    ).rejects.toThrow();
    await expect(
      su.query(`delete from studio.process_specs where id = $1`, [id]),
    ).rejects.toThrow();
  });

  describe('custom objects', () => {
    const makeType = async () => {
      const { owner } = tenants.a;
      const id = randomUUID();
      await withTenantTx(database.db, owner.context, async (tx) => {
        await tx.insert(objectTypes).values({
          organizationId: owner.context.organizationId,
          id,
          slug: `t${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          displayName: 'Test',
          classification: 'confidential',
          createdByMembershipId: owner.context.membershipId,
        });
        await tx.insert(objectTypeVersions).values({
          organizationId: owner.context.organizationId,
          typeId: id,
          versionNumber: 1,
          fields: [],
          relations: [],
          schemaSha256: HASH,
          createdByMembershipId: owner.context.membershipId,
        });
      });
      return id;
    };

    it('refuses a record looser than its type', async () => {
      const { owner } = tenants.a;
      const typeId = await makeType();
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx.insert(objectRecords).values({
            organizationId: owner.context.organizationId,
            typeId,
            typeVersionNumber: 1,
            displayName: 'Too loose',
            attributes: {},
            classification: 'internal',
            ownerMembershipId: owner.context.membershipId,
            createdByMembershipId: owner.context.membershipId,
          }),
        ),
      ).rejects.toEqual(sqlState('EN403'));
    });

    it('refuses lowering a type, and raises its records when it rises', async () => {
      const { owner } = tenants.a;
      const typeId = await makeType();
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx
            .update(objectTypes)
            .set({ classification: 'internal' })
            .where(eq(objectTypes.id, typeId)),
        ),
      ).rejects.toEqual(sqlState('EN403'));
      const recordId = randomUUID();
      await withTenantTx(database.db, owner.context, async (tx) => {
        await tx.insert(objectRecords).values({
          organizationId: owner.context.organizationId,
          id: recordId,
          typeId,
          typeVersionNumber: 1,
          displayName: 'Rising',
          attributes: {},
          classification: 'confidential',
          ownerMembershipId: owner.context.membershipId,
          createdByMembershipId: owner.context.membershipId,
        });
        await tx
          .update(objectTypes)
          .set({ classification: 'restricted' })
          .where(eq(objectTypes.id, typeId));
      });
      const [row] = await withTenantTx(database.db, owner.context, (tx) =>
        tx
          .select({ classification: objectRecords.classification })
          .from(objectRecords)
          .where(eq(objectRecords.id, recordId)),
      );
      expect(row?.classification).toBe('restricted');
    });

    it('cannot rewrite an old shape', async () => {
      const { owner } = tenants.a;
      const typeId = await makeType();
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx
            .update(objectTypeVersions)
            .set({ fields: [] })
            .where(eq(objectTypeVersions.typeId, typeId)),
        ),
      ).rejects.toThrow();
    });

    it('shows another tenant nothing', async () => {
      const typeId = await makeType();
      const rows = await withTenantTx(database.db, tenants.b.owner.context, (tx) =>
        tx.select({ id: objectTypes.id }).from(objectTypes).where(eq(objectTypes.id, typeId)),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('packs', () => {
    it('will not activate with anything undecided, and needs a person', async () => {
      const { owner } = tenants.a;
      const id = randomUUID();
      await withTenantTx(database.db, owner.context, async (tx) => {
        await tx.insert(packInstallations).values({
          organizationId: owner.context.organizationId,
          id,
          packKey: `pack-${randomUUID()}`,
          packVersion: '1.0.0',
          manifestSha256: HASH,
          requestedByMembershipId: owner.context.membershipId,
        });
        await tx.insert(packCapabilityReviews).values({
          organizationId: owner.context.organizationId,
          installationId: id,
          capabilityKey: 'tool.email.send',
        });
      });
      const activate = (activatedByMembershipId: string | null) =>
        withTenantTx(database.db, owner.context, (tx) =>
          tx
            .update(packInstallations)
            .set({ status: 'active', activatedByMembershipId })
            .where(eq(packInstallations.id, id)),
        );
      await expect(activate(owner.context.membershipId)).rejects.toEqual(sqlState('EN404'));
      await withTenantTx(database.db, owner.context, (tx) =>
        tx
          .update(packCapabilityReviews)
          .set({
            decision: 'declined',
            decidedByMembershipId: owner.context.membershipId,
            decidedAt: new Date(),
          })
          .where(
            and(
              eq(packCapabilityReviews.installationId, id),
              eq(packCapabilityReviews.capabilityKey, 'tool.email.send'),
            ),
          ),
      );
      await expect(activate(null)).rejects.toEqual(sqlState('EN404'));
      await activate(owner.context.membershipId);
    });

    it('cannot start an installation already active', async () => {
      const { owner } = tenants.a;
      await expect(
        withTenantTx(database.db, owner.context, (tx) =>
          tx.insert(packInstallations).values({
            organizationId: owner.context.organizationId,
            packKey: `pack-${randomUUID()}`,
            packVersion: '1.0.0',
            manifestSha256: HASH,
            status: 'active',
            requestedByMembershipId: owner.context.membershipId,
          }),
        ),
      ).rejects.toEqual(sqlState('EN401'));
    });
  });

  describe('experience', () => {
    it('does not let one person dismiss a signal for another', async () => {
      const { admin, member } = tenants.a;
      await expect(
        withTenantTx(database.db, admin.context, (tx) =>
          tx.insert(pulseSignalStates).values({
            organizationId: admin.context.organizationId,
            membershipId: member.context.membershipId,
            signalKey: 'work_overdue:someone',
            state: 'dismissed',
          }),
        ),
      ).rejects.toThrow();
    });

    it('keeps an authorized outcome as it was authorized', async () => {
      const { owner } = tenants.a;
      const work = await createWorkUnit(database.db, owner.context, { title: 'Test outcome' });
      const id = randomUUID();
      await su.query(
        `insert into experience.outcome_drafts
           (organization_id, id, objective, preview, preview_sha256, created_by_membership_id)
         values ($1, $2, 'Objective', '{}', $3, $4)`,
        [owner.context.organizationId, id, HASH, owner.context.membershipId],
      );
      await su.query(
        `update experience.outcome_drafts
            set status = 'authorized', work_unit_id = $2, authorized_by_membership_id = $3
          where id = $1`,
        [id, work.id, owner.context.membershipId],
      );
      await expect(
        su.query(`update experience.outcome_drafts set objective = 'Changed' where id = $1`, [id]),
      ).rejects.toThrow(/OUTCOME_FINISHED/);
    });
  });

  it('leaves no session state behind between transactions', async () => {
    const rows = await database.db.run((tx) =>
      tx.execute(sql`select current_setting('app.scim_token_hash', true) as hash`),
    );
    expect((rows.rows[0] as { hash: string | null }).hash || null).toBeNull();
  });
});
