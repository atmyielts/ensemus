// ADR-035 D5 and D6's database rules on their own. Real PostgreSQL, real roles. NOT RUN YET: the migrations are
// not in the journal until the final merge, and this project needs a container.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  createOrganization,
  deploymentProfile,
  isolationEvidence,
  memberships,
  openAppDatabase,
  residencyRequirements,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { clearDeploymentProfile, client, setDeploymentProfile } from '../helpers/federation';
import { urls } from '../helpers/stack';

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('deployment profile and residency rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let ownerA: TenantContext;
  let ownerB: TenantContext;
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
    const { organizationId } = await createOrganization(database.db, {
      userId: user,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    return resolveTenantContext(database.db, user, organizationId);
  };

  const setRequirement = (context: TenantContext, region: string, scope = 'all') =>
    withTenantTx(database.db, context, (tx) =>
      tx.insert(residencyRequirements).values({
        organizationId: context.organizationId,
        scope,
        region,
        setByMembershipId: context.membershipId,
      }),
    );

  beforeAll(async () => {
    database = openAppDatabase(urls.app());
    auth = await client(urls.auth());
    ownerA = await newOwner('owner-a');
    ownerB = await newOwner('owner-b');
    const memberUser = await makeUser('member-a');
    await withTenantTx(database.db, ownerA, (tx) =>
      tx.insert(memberships).values({
        organizationId: ownerA.organizationId,
        userId: memberUser,
        role: 'member',
      }),
    );
    memberA = await resolveTenantContext(database.db, memberUser, ownerA.organizationId);
  });

  afterEach(clearDeploymentProfile);

  afterAll(async () => {
    await clearDeploymentProfile();
    await database?.close();
    await auth?.end();
  });

  it('behaves as it always has with no profile', async () => {
    await expect(newOwner('no-profile')).resolves.toBeDefined();
  });

  describe('the profile', () => {
    it('cannot be changed by any tenant', async () => {
      await setDeploymentProfile({ homeRegion: 'test-region-a' });
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx.update(deploymentProfile).set({ homeRegion: 'test-region-b' }),
        ),
      ).rejects.toEqual(sqlState('42501'));
      await expect(
        withTenantTx(database.db, ownerA, (tx) =>
          tx.insert(isolationEvidence).values({
            aspect: 'database',
            result: 'passed',
            releaseVersion: 'forged',
          }),
        ),
      ).rejects.toEqual(sqlState('42501'));
    });

    it('holds one row, and refuses a dedicated tier with no pin, or with cross-org on', async () => {
      await setDeploymentProfile({});
      const migrator = await client(urls.migrator());
      const insert = (columns: string, values: string) =>
        migrator.query(
          `insert into tenancy.deployment_profile (${columns}, profile_sha256) values (${values}, '${'0'.repeat(64)}')`,
        );
      await expect(insert('tier', `'shared'`)).rejects.toThrow(/duplicate key/);
      await migrator.query('delete from tenancy.deployment_profile');
      await expect(insert('tier', `'dedicated'`)).rejects.toThrow(/deployment_profile_pin_check/);
      await expect(
        insert(
          'tier, pinned_organization_id, cross_org_enabled',
          `'dedicated', '${randomUUID()}', true`,
        ),
      ).rejects.toThrow(/deployment_profile_dedicated_alone/);
      await expect(insert('singleton', 'false')).rejects.toThrow(/deployment_profile_one_row/);
      await migrator.end();
    });
  });

  describe('a dedicated deployment', () => {
    it('admits only its pinned organization, whatever asks', async () => {
      await setDeploymentProfile({ tier: 'dedicated', pinnedOrganizationId: randomUUID() });
      const user = await makeUser('second-org');
      await expect(
        createOrganization(database.db, {
          userId: user,
          name: 'Another',
          commercialMode: 'byom',
        }),
      ).rejects.toEqual(sqlState('EN701'));
    });
  });

  describe('a requirement', () => {
    it('is refused with no region claimed, or for a region this deployment is not in', async () => {
      await expect(setRequirement(ownerA, 'test-region-a')).rejects.toEqual(sqlState('EN702'));
      await setDeploymentProfile({ homeRegion: 'test-region-a' });
      await expect(setRequirement(ownerA, 'test-region-b')).rejects.toEqual(sqlState('EN702'));
    });

    it('takes an owner, and belongs to one tenant', async () => {
      await setDeploymentProfile({ homeRegion: 'test-region-a' });
      await expect(setRequirement(memberA, 'test-region-a')).rejects.toEqual(sqlState('EN704'));
      await setRequirement(ownerA, 'test-region-a', 'confidential');
      const fromB = await withTenantTx(database.db, ownerB, (tx) =>
        tx.select().from(residencyRequirements),
      );
      expect(fromB.map((row) => row.organizationId)).not.toContain(ownerA.organizationId);
    });
  });
});
