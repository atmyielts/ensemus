import {
  createSkillPackage,
  getSkillPackage,
  listSkillPackages,
  updateSkillPackage,
} from '@ensemus/application';
import { openAppDatabase } from '@ensemus/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { urls } from '../helpers/stack';

const code = (value: string) => expect.objectContaining({ code: value });
const on = { isEnabled: async () => true };
const off = { isEnabled: async () => false };

describe('skill package catalog', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>;
  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    tenants = await makeTwoTenants(app.db);
    await proveSecondFactor(tenants.a.owner);
    await proveSecondFactor(tenants.b.owner);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('creates tenant metadata and lets members read it without exposing membership IDs', async () => {
    const created = await createSkillPackage(app.db, tenants.a.owner.context, on, {
      name: 'summary-pack',
      displayName: '  Summary pack  ',
    });
    expect(created).toMatchObject({
      displayName: 'Summary pack',
      origin: 'tenant',
      listingId: null,
      state: 'active',
      contentClassification: 'internal',
      version: 1,
    });
    expect(created).not.toHaveProperty('ownerMembershipId');
    expect(await getSkillPackage(app.db, tenants.a.member.context, created.id)).toEqual(created);
    await expect(
      getSkillPackage(app.db, tenants.b.owner.context, created.id),
    ).rejects.toMatchObject(code('NOT_FOUND'));
    await expect(
      updateSkillPackage(app.db, tenants.b.owner.context, {
        packageId: created.id,
        expectedVersion: 1,
        state: 'disabled',
      }),
    ).rejects.toMatchObject(code('NOT_FOUND'));
    expect((await listSkillPackages(app.db, tenants.b.owner.context, {})).items).toEqual([]);
  });

  it('rejects disabled admission, malformed names, member writers and duplicate tenant names', async () => {
    const context = tenants.a.owner.context;
    const input = { name: 'reporting-pack', displayName: 'Reporting pack' };
    await expect(createSkillPackage(app.db, context, off, input)).rejects.toMatchObject(
      code('FEATURE_NOT_ENABLED'),
    );
    await expect(
      createSkillPackage(app.db, context, on, { ...input, name: '../unknown' }),
    ).rejects.toMatchObject(code('INVALID_INPUT'));
    await expect(
      createSkillPackage(app.db, tenants.a.member.context, on, input),
    ).rejects.toMatchObject(code('FORBIDDEN'));
    await createSkillPackage(app.db, context, on, input);
    await expect(createSkillPackage(app.db, context, on, input)).rejects.toMatchObject(
      code('SKILL_NAME_TAKEN'),
    );
    await expect(
      createSkillPackage(app.db, tenants.b.owner.context, on, input),
    ).resolves.toMatchObject({ name: input.name });
  });

  it('scopes cursor pages and rejects a malformed cursor', async () => {
    for (const name of ['paging-first', 'paging-second']) {
      await createSkillPackage(app.db, tenants.a.owner.context, on, { name, displayName: name });
    }
    const context = tenants.a.member.context;
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page = await listSkillPackages(
        app.db,
        context,
        after === null ? { limit: 1 } : { limit: 1, after },
      );
      seen.push(...page.items.map(({ name }) => name));
      after = page.nextCursor;
    } while (after !== null);
    const unpaged = await listSkillPackages(app.db, context, {});
    expect(seen).toEqual(unpaged.items.map(({ name }) => name));
    expect(seen).toEqual(expect.arrayContaining(['paging-first', 'paging-second']));
    await expect(listSkillPackages(app.db, context, { after: '@broken' })).rejects.toMatchObject(
      code('INVALID_INPUT'),
    );
  });

  it('applies only one concurrent change to a version and refuses ordinary members', async () => {
    const context = tenants.a.owner.context;
    const pkg = await createSkillPackage(app.db, context, on, {
      name: 'release-pack',
      displayName: 'Release pack',
    });
    const patch = { packageId: pkg.id, expectedVersion: pkg.version, state: 'disabled' as const };
    await expect(updateSkillPackage(app.db, tenants.a.member.context, patch)).rejects.toMatchObject(
      code('FORBIDDEN'),
    );
    const results = await Promise.allSettled([
      updateSkillPackage(app.db, context, patch),
      updateSkillPackage(app.db, context, patch),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: code('VERSION_CONFLICT'),
    });
    expect(await getSkillPackage(app.db, context, pkg.id)).toMatchObject({
      state: 'disabled',
      version: 2,
    });
  });
});
