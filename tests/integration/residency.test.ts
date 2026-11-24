import {
  createResidencyGate,
  listResidencyRequirements,
  setResidencyRequirement,
} from '@ensemus/application';
import {
  auditEvents,
  openAppDatabase,
  residencyRequirements,
  withTenantTx,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { RESIDENCY_SURFACES, type ResidencyPolicy } from '@ensemus/domain/residency';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearDeploymentProfile, setDeploymentProfile } from '../helpers/federation';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

const home = 'test-region-a';
const elsewhere = 'test-region-b';
const code = (errorCode: string) => ({ code: errorCode });

describe('native residency requirements and processing decisions', () => {
  const app = openAppDatabase(urls.app());
  const worker = openAppDatabase(urls.worker());
  let pair: Awaited<ReturnType<typeof makeTwoTenants>>;
  const owner = () => pair.a.owner.context;
  const service = () => createServiceContext(owner().organizationId);

  beforeAll(async () => {
    pair = await makeTwoTenants(app.db);
    await Promise.all([proveSecondFactor(pair.a.owner), proveSecondFactor(pair.b.owner)]);
  });
  afterEach(clearDeploymentProfile);
  afterAll(async () => {
    await Promise.all([app.close(), worker.close()]);
  });

  it('admits native owners to change a requirement and gives admins read access only', async () => {
    await setDeploymentProfile({ homeRegion: home });
    const changes = { scope: 'confidential' as const, region: home, expectedVersion: 0 };
    await expect(listResidencyRequirements(app.db, pair.a.member.context)).rejects.toMatchObject(
      code('NOT_FOUND'),
    );
    await expect(
      setResidencyRequirement(app.db, pair.a.admin.context, changes),
    ).rejects.toMatchObject(code('FORBIDDEN'));
    await expect(
      setResidencyRequirement(app.db, pair.a.member.context, changes),
    ).rejects.toMatchObject(code('NOT_FOUND'));
    await expect(async () =>
      setResidencyRequirement(worker.db, service(), changes),
    ).rejects.toMatchObject(code('FORBIDDEN'));
    await expect(setResidencyRequirement(app.db, owner(), changes)).resolves.toMatchObject([
      { scope: 'confidential', region: home, version: 1 },
    ]);
    await expect(listResidencyRequirements(app.db, pair.a.admin.context)).resolves.toMatchObject([
      { scope: 'confidential', region: home },
    ]);
    await expect(listResidencyRequirements(app.db, pair.b.owner.context)).resolves.toEqual([]);
  });

  it('refuses missing and unoffered regions without storing a rule', async () => {
    const req = { scope: 'public' as const, region: home, expectedVersion: 0 };
    await expect(setResidencyRequirement(app.db, owner(), req)).rejects.toMatchObject(
      code('RESIDENCY_REGION_NOT_OFFERED'),
    );
    await setDeploymentProfile({ homeRegion: home });
    await expect(
      setResidencyRequirement(app.db, owner(), { ...req, region: elsewhere }),
    ).rejects.toMatchObject(code('RESIDENCY_REGION_NOT_OFFERED'));
    expect(
      (await listResidencyRequirements(app.db, owner())).some((row) => row.scope === 'public'),
    ).toBe(false);
  });

  it('handles concurrent creation and makes stale removals fail without duplicating audit events', async () => {
    await setDeploymentProfile({ homeRegion: home });
    const req = { scope: 'restricted' as const, region: home, expectedVersion: 0 };
    const results = await Promise.allSettled([
      setResidencyRequirement(app.db, owner(), req),
      setResidencyRequirement(app.db, owner(), req),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: code('VERSION_CONFLICT'),
    });
    await setResidencyRequirement(app.db, owner(), { ...req, expectedVersion: 1 });
    await expect(
      setResidencyRequirement(app.db, owner(), { ...req, region: null }),
    ).rejects.toMatchObject(code('VERSION_CONFLICT'));
    const result = await setResidencyRequirement(app.db, owner(), {
      ...req,
      expectedVersion: 1,
      region: null,
    });
    expect(result.some((row) => row.scope === req.scope)).toBe(false);
    const events = await withTenantTx(app.db, owner(), (tx) =>
      tx
        .select({ action: auditEvents.action, actor: auditEvents.actorId })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetRef, 'residency:restricted'),
            inArray(auditEvents.action, [
              'residency.requirement_set',
              'residency.requirement_removed',
            ]),
          ),
        ),
    );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { action: 'residency.requirement_set', actor: owner().membershipId },
        { action: 'residency.requirement_removed', actor: owner().membershipId },
      ]),
    );
  });

  it('enforces the current requirements per tenant and classification against all surface declarations', async () => {
    await setDeploymentProfile({ homeRegion: home });
    await setResidencyRequirement(app.db, owner(), {
      scope: 'internal',
      expectedVersion: 0,
      region: home,
    });
    await setResidencyRequirement(app.db, pair.b.owner.context, {
      scope: 'public',
      expectedVersion: 0,
      region: home,
    });
    const policy: ResidencyPolicy = {
      homeRegion: home,
      surfaces: Object.fromEntries(
        RESIDENCY_SURFACES.map((surface) => [
          surface,
          { regions: [home], evidenceRef: 'Generated region declaration' },
        ]),
      ),
    };
    const gate = createResidencyGate({ database: worker.db, policy });
    const undeclared = createResidencyGate({
      database: worker.db,
      policy: { homeRegion: home, surfaces: {} },
    });
    const other = createServiceContext(pair.b.owner.context.organizationId);
    for (const surface of RESIDENCY_SURFACES) {
      const request = { surface, classification: 'internal' as const };
      await expect(
        gate.check(service(), { ...request, targetRegion: elsewhere }),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'TARGET_OUTSIDE_REGION',
      });
      await expect(
        gate.check(service(), { ...request, targetRegion: null }),
      ).resolves.toMatchObject({
        allowed: false,
        code: 'TARGET_REGION_UNKNOWN',
      });
      await expect(undeclared.check(service(), request)).resolves.toMatchObject({
        allowed: false,
        code: 'SURFACE_UNDECLARED',
      });
      await expect(
        gate.check(service(), { ...request, targetRegion: home }),
      ).resolves.toMatchObject({
        allowed: true,
        requiredRegion: home,
      });
      await expect(gate.check(other, { ...request, targetRegion: elsewhere })).resolves.toEqual({
        allowed: true,
        requiredRegion: null,
      });
    }
  });

  it('binds the version after the deployment offers a new home and blocks writes through the worker login', async () => {
    await setDeploymentProfile({ homeRegion: home });
    const req = { scope: 'all' as const, region: home, expectedVersion: 0 };
    await setResidencyRequirement(app.db, owner(), req);
    await setDeploymentProfile({ homeRegion: elsewhere });
    const changed = await setResidencyRequirement(app.db, owner(), {
      ...req,
      region: elsewhere,
      expectedVersion: 1,
    });
    expect(changed.find((row) => row.scope === 'all')).toMatchObject({
      version: 2,
      region: elsewhere,
    });
    await expect(
      withTenantTx(worker.db, service(), (tx) =>
        tx.delete(residencyRequirements).where(eq(residencyRequirements.scope, 'all')),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withTenantTx(app.db, pair.a.admin.context, (tx) =>
        tx.insert(residencyRequirements).values({
          organizationId: owner().organizationId,
          scope: 'public',
          region: elsewhere,
          setByMembershipId: owner().membershipId,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: 'EN704' } });
    expect(
      (await listResidencyRequirements(app.db, owner())).find((row) => row.scope === 'all'),
    ).toMatchObject({ version: 2 });
  });
});
