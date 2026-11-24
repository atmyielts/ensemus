// ADR-035 D5 and D6: deployment profile and residency rules on real PostgreSQL with native roles.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createOrganization,
  DedicatedOrganizationClaimRefused,
  deploymentProfile,
  isolationEvidence,
  memberships,
  openAppDatabase,
  residencyRequirements,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { applyDeploymentProfile, PinChangeRefused } from '@ensemus/database/deployment';
import { clearDeploymentProfile, client, setDeploymentProfile } from '../helpers/federation';
import { urls } from '../helpers/stack';
import { makePerson, nativePersonContext, proveSecondFactor } from '../helpers/product';

const sqlState = (code: string) =>
  expect.objectContaining({ cause: expect.objectContaining({ code }) });

describe('deployment profile and residency rules in the database', () => {
  let database: ReturnType<typeof openAppDatabase>;
  let ownerA: TenantContext;
  let ownerB: TenantContext;
  let memberA: TenantContext;

  const newOwner = async (label: string) => {
    const person = await makePerson(label);
    const { organizationId } = await createOrganization(database.db, {
      userId: person.userId,
      name: 'Same Name Ltd',
      commercialMode: 'byom',
    });
    await proveSecondFactor(person);
    return nativePersonContext(database.db, person, organizationId);
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
    ownerA = await newOwner('owner-a');
    ownerB = await newOwner('owner-b');
    const memberPerson = await makePerson('member-a');
    await withTenantTx(database.db, ownerA, (tx) =>
      tx.insert(memberships).values({
        organizationId: ownerA.organizationId,
        userId: memberPerson.userId,
        role: 'member',
      }),
    );
    memberA = await nativePersonContext(database.db, memberPerson, ownerA.organizationId);
  });

  afterEach(clearDeploymentProfile);

  afterAll(async () => {
    await clearDeploymentProfile();
    await database?.close();
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

  it('keeps the first committed pin when setup jobs start on an empty profile', async () => {
    const first = randomUUID();
    const competing = randomUUID();
    const config = (pinnedOrganizationId: string) => ({
      tier: 'dedicated' as const,
      pinnedOrganizationId,
      homeRegion: null,
      crossOrgEnabled: false,
      profileSha256: '0'.repeat(64),
    });
    const holder = await client(urls.migrator());
    const observer = await client(urls.superuser());
    let attempt: Promise<unknown> | undefined;
    try {
      await holder.query('begin');
      await holder.query(
        "insert into tenancy.deployment_profile(tier, pinned_organization_id, profile_sha256) values ('dedicated',$1,$2)",
        [first, config(first).profileSha256],
      );
      attempt = applyDeploymentProfile(urls.migrator(), config(competing)).then(
        () => null,
        (error: unknown) => error,
      );
      await expect
        .poll(
          async () => {
            const { rowCount } = await observer.query(
              "select 1 from pg_stat_activity where datname = current_database() and application_name='ensemus-deploy' and wait_event_type='Lock'",
            );
            return rowCount;
          },
          { timeout: 5_000, interval: 50 },
        )
        .toBe(1);
      await holder.query('commit');
      expect(await attempt).toBeInstanceOf(PinChangeRefused);
      await expect(applyDeploymentProfile(urls.migrator(), config(first))).resolves.toBeUndefined();
      const { rows } = await observer.query(
        'select pinned_organization_id from tenancy.deployment_profile',
      );
      expect(rows).toEqual([{ pinned_organization_id: first }]);
    } finally {
      await holder.end();
      await attempt;
      await observer.end();
    }
  });

  describe('a dedicated deployment', () => {
    it('sets up the pinned organization once and gives a competing account no membership', async () => {
      const person = await makePerson('dedicated-owner');
      const other = await makePerson('dedicated-other');
      const pinnedOrganizationId = randomUUID();
      const input = {
        userId: person.userId,
        name: 'Pinned workspace',
        commercialMode: 'byom' as const,
        pinnedOrganizationId,
      };
      await expect(createOrganization(database.db, input)).rejects.toBeInstanceOf(
        DedicatedOrganizationClaimRefused,
      );
      await setDeploymentProfile({ tier: 'dedicated', pinnedOrganizationId });
      const created = await createOrganization(database.db, input);
      expect(created.organizationId).toBe(pinnedOrganizationId);
      await expect(createOrganization(database.db, input)).resolves.toEqual(created);
      await expect(
        createOrganization(database.db, { ...input, userId: other.userId }),
      ).rejects.toBeInstanceOf(DedicatedOrganizationClaimRefused);
      await expect(
        resolveTenantContext(database.db, other.userId, pinnedOrganizationId),
      ).rejects.toThrow();
    });

    it('admits only its pinned organization, whatever asks', async () => {
      await setDeploymentProfile({ tier: 'dedicated', pinnedOrganizationId: randomUUID() });
      const person = await makePerson('second-org');
      await expect(
        createOrganization(database.db, {
          userId: person.userId,
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
