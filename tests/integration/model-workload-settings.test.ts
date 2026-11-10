// Authored real-role/native-session regressions. Synthetic qualification transport only; these do
// not prove provider quality, browser MFA enrollment, Cloud billing or production acceptance.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAppDatabase, resolveTenantContext } from '@ensemus/database';
import { disableMember } from '@ensemus/application';
import { updateModelProfile } from '@ensemus/application/ai-model-profiles';
import { assertInteractivePrivilege } from '@ensemus/application/privileged';
import {
  approveModelWorkload,
  listModelQualifications,
  listModelWorkloadApprovals,
  requestModelQualification,
  revokeModelWorkload,
} from '@ensemus/application/knowledge/model-jobs';
import { makeTwoTenants, proveSecondFactor } from '../helpers/product';
import { GENERATED_MODEL_ENDPOINT, seedQualifiedKnowledgeRoute } from '../helpers/knowledge-models';
import { urls } from '../helpers/stack';

const bounds = {
  maxCalls: 2,
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  maxTotalTokens: 2200,
  maxCostMicros: 500,
  timeoutSeconds: 60,
};
describe('native model capability and workload management boundaries', () => {
  const app = openAppDatabase(urls.app(), { max: 4 });
  let tenants: Awaited<ReturnType<typeof makeTwoTenants>>,
    route: Awaited<ReturnType<typeof seedQualifiedKnowledgeRoute>>;
  beforeAll(async () => {
    tenants = await makeTwoTenants(app.db);
    await proveSecondFactor(tenants.a.owner);
    await proveSecondFactor(tenants.b.owner);
    route = await seedQualifiedKnowledgeRoute(app.db, tenants.a.owner.context, { dimension: 3 });
  });
  afterAll(async () => app.close());
  const input = () => ({
    kind: 'query' as const,
    scope: 'organization' as const,
    sourceId: null,
    connectionId: null,
    purposes: ['embed' as const],
    qualificationIds: [route.qualificationId!],
    maxClassification: 'internal' as const,
    bounds,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    requestKey: randomUUID(),
  });

  it('reads exact passed version/protocol/dimension evidence without private payloads or credentials', async () => {
    const page = await listModelQualifications(app.db, tenants.a.owner.context, {
      profileId: route.modelProfileRef,
    });
    const q = page.items.find((row) => row.id === route.qualificationId);
    expect(q).toMatchObject({
      current: true,
      usable: true,
      purpose: 'embed',
      protocol: 'native_embedding_v1',
      dimension: 3,
      vectorSpaceVersion: 'generated-v1',
      state: 'passed',
    });
    expect(q?.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(q!)).not.toEqual(
      expect.arrayContaining(['secretRef', 'requestHash', 'query', 'response']),
    );
  });
  it('denies member reads/writes and masks another tenant’s profile evidence', async () => {
    await expect(listModelQualifications(app.db, tenants.a.member.context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      listModelWorkloadApprovals(app.db, tenants.a.member.context),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      approveModelWorkload(app.db, tenants.a.member.context, input()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      listModelQualifications(app.db, tenants.b.owner.context, {
        profileId: route.modelProfileRef,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      approveModelWorkload(app.db, tenants.b.owner.context, input()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not keep manager reads alive after the native context’s membership is disabled', async () => {
    const fresh = await makeTwoTenants(app.db);
    await proveSecondFactor(fresh.a.owner);
    expect((await listModelQualifications(app.db, fresh.a.admin.context)).items).toEqual([]);
    await disableMember(app.db, fresh.a.owner.context, {
      membershipId: fresh.a.admin.context.membershipId,
    });
    await expect(listModelQualifications(app.db, fresh.a.admin.context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(listModelWorkloadApprovals(app.db, fresh.a.admin.context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('rejects copied native context fields and a stale second factor in the actual effect transaction', async () => {
    const plain = await resolveTenantContext(
      app.db,
      tenants.a.owner.userId,
      tenants.a.organizationId,
    );
    await expect(approveModelWorkload(app.db, { ...plain }, input())).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
    await proveSecondFactor(tenants.a.owner, new Date(Date.now() - 86400000));
    try {
      await expect(
        approveModelWorkload(app.db, tenants.a.owner.context, input()),
      ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    } finally {
      await proveSecondFactor(tenants.a.owner);
    }
  });
  it('records exact bounded approval idempotently and refuses a reused key with wider caps', async () => {
    const raw = input();
    const approved = await approveModelWorkload(app.db, tenants.a.owner.context, raw);
    expect(await approveModelWorkload(app.db, tenants.a.owner.context, raw)).toEqual(approved);
    await expect(
      approveModelWorkload(app.db, tenants.a.owner.context, {
        ...raw,
        bounds: { ...bounds, maxCostMicros: bounds.maxCostMicros + 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const view = (await listModelWorkloadApprovals(app.db, tenants.a.owner.context)).items.find(
      (row) => row.id === approved.approvalId,
    );
    expect(view).toMatchObject({
      ...bounds,
      maxClassification: 'internal',
      qualifications: [{ id: route.qualificationId, usable: true }],
    });
    expect(
      (await listModelWorkloadApprovals(app.db, tenants.b.owner.context)).items.some(
        (row) => row.id === approved.approvalId,
      ),
    ).toBe(false);
  });
  it('revokes without a new MFA proof, refuses foreign IDs and keeps repeat revocation safe', async () => {
    const approved = await approveModelWorkload(app.db, tenants.a.owner.context, input());
    await proveSecondFactor(tenants.a.owner, new Date(Date.now() - 86400000));
    try {
      await expect(
        revokeModelWorkload(app.db, tenants.a.member.context, approved.approvalId),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        revokeModelWorkload(app.db, tenants.b.owner.context, approved.approvalId),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await revokeModelWorkload(app.db, tenants.a.owner.context, approved.approvalId);
      await revokeModelWorkload(app.db, tenants.a.owner.context, approved.approvalId);
      expect(
        (await listModelWorkloadApprovals(app.db, tenants.a.owner.context)).items.find(
          (row) => row.id === approved.approvalId,
        )?.revokedAt,
      ).not.toBeNull();
    } finally {
      await proveSecondFactor(tenants.a.owner);
    }
  });
  it('refuses missing bounds, expired authority and wrong capability evidence before granting spend', async () => {
    await expect(
      approveModelWorkload(app.db, tenants.a.owner.context, {
        ...input(),
        expiresAt: new Date(0).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      approveModelWorkload(app.db, tenants.a.owner.context, { ...input(), purposes: ['answer'] }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      requestModelQualification(app.db, tenants.a.owner.context, {
        profileId: route.modelProfileRef,
        expectedProfileVersion: route.modelProfileVersion + 1,
        purpose: 'embed',
        dimension: 3,
        vectorSpaceVersion: 'generated-v1',
        requestKey: randomUUID(),
        bounds: { ...bounds, maxCalls: 1 },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('rechecks a profile changed after native admission; historical evidence stays visible but unusable', async () => {
    const fresh = await seedQualifiedKnowledgeRoute(app.db, tenants.a.owner.context, {
      dimension: 3,
    });
    let release!: () => void, admitted!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const pending = approveModelWorkload(
      app.db,
      tenants.a.owner.context,
      { ...input(), qualificationIds: [fresh.qualificationId!] },
      {
        assertInTx: async (tx, context) => {
          await assertInteractivePrivilege(tx, context, 'model_workload.approve');
          admitted();
          await waiting;
        },
      },
    );
    // Register the rejection before allowing the other transaction to finish.
    const refused = expect(pending).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await reached;
    try {
      await updateModelProfile(
        app.db,
        tenants.a.owner.context,
        {
          profileId: fresh.modelProfileRef,
          patch: {
            expected_version: fresh.modelProfileVersion,
            model_id: `changed-${randomUUID()}`,
          },
        },
        { privateEndpoints: [GENERATED_MODEL_ENDPOINT] },
      );
    } finally {
      release();
    }
    await refused;
    expect(
      (
        await listModelQualifications(app.db, tenants.a.owner.context, {
          profileId: fresh.modelProfileRef,
        })
      ).items.find((q) => q.id === fresh.qualificationId),
    ).toMatchObject({ current: false, usable: false, state: 'passed' });
  });
});
