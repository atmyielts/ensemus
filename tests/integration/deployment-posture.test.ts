import { randomUUID } from 'node:crypto';
import {
  getDeploymentProfile,
  getIsolationPosture,
  getResidencyPosture,
  inspectDeployment,
  setMemberRole,
} from '@ensemus/application';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import { recordIsolationEvidence } from '@ensemus/database/deployment';
import { createServiceContext } from '@ensemus/database/service';
import { ISOLATION_ASPECTS, PROBED_ISOLATION_ASPECTS } from '@ensemus/domain/tenancy';
import { NO_RESIDENCY_POLICY, RESIDENCY_SURFACES } from '@ensemus/domain/residency';
import { afterAll, describe, expect, it } from 'vitest';
import { openAgentTestDatabase, seedActiveProfile, seedAiTenant } from '../helpers/ai/fixtures';
import { clearDeploymentProfile, setDeploymentProfile } from '../helpers/federation';
import { urls } from '../helpers/stack';

const refused = { code: 'NOT_FOUND' };

describe('deployment posture uses current tenant authority and operator evidence', () => {
  const app = openAppDatabase(urls.app()),
    agent = openAgentTestDatabase();
  afterAll(async () => {
    await app.close();
    await agent.close();
  });

  it('defaults to a shared deployment without a regional claim and refuses member or service views', async () => {
    const tenant = await seedAiTenant(app.db);
    expect(await getDeploymentProfile(app.db, tenant.owner)).toEqual({
      tier: 'shared',
      homeRegion: null,
      crossOrgEnabled: false,
      profiled: false,
    });
    expect(
      await getResidencyPosture(app.db, tenant.owner, { policy: NO_RESIDENCY_POLICY, sources: [] }),
    ).toMatchObject({
      allInRegion: false,
      surfaces: RESIDENCY_SURFACES.map((surface) => ({ surface, state: 'undeclared' })),
    });
    await expect(getDeploymentProfile(app.db, tenant.member)).rejects.toMatchObject(refused);
    await setMemberRole(app.db, tenant.owner, {
      membershipId: tenant.member.membershipId,
      role: 'admin',
    });
    const admin = await resolveTenantContext(app.db, tenant.member.userId, tenant.organizationId);
    expect(admin.role).toBe('admin');
    expect((await getDeploymentProfile(app.db, admin)).tier).toBe('shared');
    await setMemberRole(app.db, tenant.owner, { membershipId: admin.membershipId, role: 'member' });
    await expect(getDeploymentProfile(app.db, admin)).rejects.toMatchObject(refused);
    await expect(
      getIsolationPosture(app.db, createServiceContext(tenant.organizationId), {
        releaseVersion: null,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      getResidencyPosture(app.db, tenant.member, { policy: NO_RESIDENCY_POLICY, sources: [] }),
    ).rejects.toMatchObject(refused);
  });

  it('only reports dedicated isolation from current release evidence and prefers a failed check recorded at the same time', async () => {
    const tenant = await seedAiTenant(app.db),
      releaseVersion = `generated-${randomUUID()}`;
    await setDeploymentProfile({ tier: 'dedicated', pinnedOrganizationId: tenant.organizationId });
    try {
      const checkedAt = new Date();
      await recordIsolationEvidence(
        urls.migrator(),
        ISOLATION_ASPECTS.map((aspect) => ({
          aspect,
          result: PROBED_ISOLATION_ASPECTS.includes(aspect) ? 'passed' : 'declared',
          releaseVersion,
          checkedAt,
        })),
      );
      expect(await inspectDeployment(app.db, tenant.owner, releaseVersion)).toMatchObject({
        profile: { tier: 'dedicated', profiled: true },
        isolation: { tier: 'dedicated', isolated: true },
      });
      const unknown = await getIsolationPosture(app.db, tenant.owner, { releaseVersion: null });
      expect(unknown.isolated).toBe(false);
      expect(unknown.aspects.every((aspect) => aspect.state === 'stale')).toBe(true);
      await recordIsolationEvidence(urls.migrator(), [
        {
          aspect: 'network',
          result: 'failed',
          code: 'PROBE_FAILED',
          releaseVersion,
          checkedAt,
        },
      ]);
      const mixed = await getIsolationPosture(app.db, tenant.owner, { releaseVersion });
      expect(mixed.isolated).toBe(false);
      expect(mixed.aspects).toContainEqual(
        expect.objectContaining({ aspect: 'network', state: 'failed', code: 'PROBE_FAILED' }),
      );
    } finally {
      await clearDeploymentProfile();
    }
  });

  it('uses only this tenant’s active model regions and withholds the overall declaration for unknown locations', async () => {
    const a = await seedAiTenant(app.db),
      b = await seedAiTenant(app.db);
    await seedActiveProfile(app.db, agent.db, a.owner, {
      region: 'test-region-b',
      allowedPurposes: ['reason'],
    });
    await seedActiveProfile(app.db, agent.db, a.owner, {
      region: null,
      allowedPurposes: ['embed'],
    });
    const policy = {
      homeRegion: 'test-region-a',
      surfaces: Object.fromEntries(
        RESIDENCY_SURFACES.map((surface) => [
          surface,
          {
            regions: ['test-region-a'],
            evidenceRef: 'Synthetic declaration',
          },
        ]),
      ),
    };
    const posture = await getResidencyPosture(app.db, a.owner, { policy, sources: [] });
    expect(posture.allInRegion).toBe(false);
    expect(posture.surfaces).toContainEqual(
      expect.objectContaining({ surface: 'inference', observedElsewhere: ['test-region-b'] }),
    );
    expect(posture.surfaces).toContainEqual(
      expect.objectContaining({ surface: 'embeddings', observedElsewhere: ['Unknown'] }),
    );
    expect(await getResidencyPosture(app.db, b.owner, { policy, sources: [] })).toMatchObject({
      allInRegion: true,
    });
    expect(
      await getResidencyPosture(app.db, b.owner, {
        policy,
        sources: [
          {
            surface: 'support',
            regionsFor: async () => {
              throw new Error('TEST_LOCATION_UNAVAILABLE');
            },
          },
        ],
      }),
    ).toMatchObject({ allInRegion: false });
  });
});
