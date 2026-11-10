import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openAppDatabase,
  withTenantTx,
  agentVersions,
  agentDefinitions,
  serviceIdentities,
} from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createAgentDraft, updateAgentDraft } from '@ensemus/application/agent-drafts';
import { requestSimulation, runSimulationStep } from '@ensemus/application/simulations';
import {
  requestPublishReview,
  decidePublishReview,
  publishApproved,
  cancelPublishReview,
} from '@ensemus/application/publish-reviews';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import { makeTwoTenants, proveSecondFactor, testAnswers } from '../helpers/product';
import { urls } from '../helpers/stack';
import { publishReviews, processSpecs } from '@ensemus/database/product';
import { installBundledWorkflow } from '@ensemus/application/process-runs';
import { compileProcessGraph } from '@ensemus/domain/process-spec';
import { canonicalJson } from '@ensemus/domain/approval';
import { BUNDLED_WORKFLOWS } from '@ensemus/packs/bundled';
import { eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { pgCode } from '../../packages/application/src/errors';

describe('Studio publishes only the actually rehearsed and reviewed revision', () => {
  let app: ReturnType<typeof openAppDatabase>;
  beforeAll(() => {
    app = openAppDatabase(urls.app());
  });
  afterAll(async () => {
    await app?.close();
  });
  async function fixture(elevated = false) {
    const { a, b } = await makeTwoTenants(app.db),
      ports = createRuntimeProductPorts(app.db),
      answers = testAnswers(
        a.owner.context.membershipId,
        elevated ? { dataClasses: ['confidential'] } : {},
      ),
      draft = await createAgentDraft(app.db, a.owner.context, ports, {
        name: `Generated reviewed ${a.organizationId}`,
        answers,
      }),
      simulation = await requestSimulation(app.db, a.owner.context, {
        subject: { kind: 'agent_draft', draftId: draft.id },
        scenarioKey: 'standard.draft_only',
      });
    await runSimulationStep(app.db, createServiceContext(a.organizationId), {
      simulationId: simulation.id,
    });
    return { a, b, ports, answers, draft, simulation };
  }
  it('admits only exact released catalog bodies and refuses a direct graph publication without its actual review', async () => {
    const { a } = await makeTwoTenants(app.db),
      hash = (s: string) => createHash('sha256').update(s).digest('hex');
    for (const release of BUNDLED_WORKFLOWS) {
      const compiled = compileProcessGraph(
        release.graph,
        {
          classification: release.classification,
          agentDefinitionIds: new Set(),
          toolIds: new Set(release.graph.nodes.flatMap((n) => n.toolId ?? [])),
        },
        hash,
      );
      if (!compiled.ok) throw Error('TEST_RELEASE_NOT_COMPILED');
      const spec = compiled.spec,
        canonical = canonicalJson(spec),
        ref = `${release.key}@${release.version}`;
      const checked = await withTenantTx(app.db, a.owner.context, (tx) =>
        tx.execute<{ valid: boolean; changed: boolean }>(sql`select
        studio.bundled_publication_matches(${release.key},${ref},${release.name},${release.classification},${compiled.specSha256},${canonical}::jsonb) as valid,
        studio.bundled_publication_matches(${release.key},${ref},${release.name + ' changed'},${release.classification},${compiled.specSha256},${canonical}::jsonb) as changed`),
      );
      expect(checked.rows[0]).toEqual({ valid: true, changed: false });
    }
    await expect(
      installBundledWorkflow(app.db, a.owner.context, { processKey: 'client-status-update' }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await proveSecondFactor(a.owner);
    expect(
      (
        await installBundledWorkflow(app.db, a.owner.context, {
          processKey: 'client-status-update',
        })
      ).versionNumber,
    ).toBe(1);
    const release = BUNDLED_WORKFLOWS[0]!,
      compiled = compileProcessGraph(
        release.graph,
        {
          classification: release.classification,
          agentDefinitionIds: new Set(),
          toolIds: new Set(release.graph.nodes.flatMap((n) => n.toolId ?? [])),
        },
        hash,
      );
    if (!compiled.ok) throw Error('TEST_RELEASE_NOT_COMPILED');
    const denied = await withTenantTx(app.db, a.owner.context, (tx) =>
      tx.insert(processSpecs).values({
        organizationId: a.organizationId,
        processKey: 'generated-unreviewed',
        versionNumber: 1,
        name: release.name,
        classification: release.classification,
        spec: compiled.spec,
        specSha256: compiled.specSha256,
        source: 'graph',
        publishedByMembershipId: a.owner.context.membershipId,
      }),
    ).then(
      () => null,
      (e) => e as unknown,
    );
    expect(pgCode(denied)).toBe('EN412');
  });
  it('closes a named review without MFA and requires a new immutable reviewer assignment', async () => {
    const f = await fixture(),
      review = await requestPublishReview(app.db, f.a.owner.context, {
        subjectKind: 'agent_draft',
        subjectId: f.draft.id,
        simulationRunId: f.simulation.id,
        reviewerMembershipId: f.a.admin.context.membershipId,
      });
    expect(
      (
        await cancelPublishReview(app.db, f.a.owner.context, {
          reviewId: review.id,
          expectedVersion: review.version,
        })
      ).status,
    ).toBe('cancelled');
    const next = await requestPublishReview(app.db, f.a.owner.context, {
      subjectKind: 'agent_draft',
      subjectId: f.draft.id,
      simulationRunId: f.simulation.id,
    });
    expect(next.id).not.toBe(review.id);
    expect(next.reviewerMembershipId).toBeNull();
    expect(
      (
        await cancelPublishReview(app.db, f.a.owner.context, {
          reviewId: review.id,
          expectedVersion: review.version,
        })
      ).status,
    ).toBe('cancelled');
  });
  it('refuses missing, foreign and stale simulation evidence', async () => {
    const f = await fixture();
    await expect(
      requestPublishReview(app.db, f.b.owner.context, {
        subjectKind: 'agent_draft',
        subjectId: f.draft.id,
        simulationRunId: f.simulation.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await updateAgentDraft(app.db, f.a.owner.context, f.ports, {
      draftId: f.draft.id,
      expectedVersion: 1,
      answers: { ...f.answers, intendedOutcome: 'A changed reviewed objective with citations.' },
    });
    await expect(
      requestPublishReview(app.db, f.a.owner.context, {
        subjectKind: 'agent_draft',
        subjectId: f.draft.id,
        simulationRunId: f.simulation.id,
      }),
    ).rejects.toMatchObject({ code: 'SIMULATION_STALE' });
  });
  it('requires actual native MFA and an independent current person for elevated review', async () => {
    const f = await fixture(true),
      review = await requestPublishReview(app.db, f.a.owner.context, {
        subjectKind: 'agent_draft',
        subjectId: f.draft.id,
        simulationRunId: f.simulation.id,
        reviewerMembershipId: f.a.admin.context.membershipId,
      });
    await expect(
      decidePublishReview(app.db, f.a.admin.context, null, {
        reviewId: review.id,
        expectedVersion: 1,
        decision: 'approved',
      }),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await proveSecondFactor(f.a.owner);
    await expect(
      decidePublishReview(
        app.db,
        f.a.owner.context,
        { sessionId: f.a.owner.sessionId },
        { reviewId: review.id, expectedVersion: 1, decision: 'approved' },
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_SELF_DECISION' });
    await proveSecondFactor(f.a.admin);
    expect(
      (
        await decidePublishReview(
          app.db,
          f.a.admin.context,
          { sessionId: f.a.admin.sessionId },
          { reviewId: review.id, expectedVersion: 1, decision: 'approved' },
        )
      ).status,
    ).toBe('approved');
  });
  it('refuses clearing another named reviewer inline during a direct SQL decision', async () => {
    const f = await fixture();
    await proveSecondFactor(f.a.owner);
    const review = await requestPublishReview(app.db, f.a.owner.context, {
      subjectKind: 'agent_draft',
      subjectId: f.draft.id,
      simulationRunId: f.simulation.id,
      reviewerMembershipId: f.a.admin.context.membershipId,
    });
    const denied = await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx
        .update(publishReviews)
        .set({
          reviewerMembershipId: null,
          status: 'approved',
          decidedByMembershipId: f.a.owner.context.membershipId,
          decidedAt: new Date(),
          version: 2,
        })
        .where(eq(publishReviews.id, review.id)),
    ).then(() => null, pgCode);
    expect(denied).toBe('EN412');
    expect(
      await withTenantTx(app.db, f.a.owner.context, (tx) =>
        tx
          .select({ status: publishReviews.status, reviewer: publishReviews.reviewerMembershipId })
          .from(publishReviews)
          .where(eq(publishReviews.id, review.id)),
      ),
    ).toEqual([{ status: 'pending', reviewer: f.a.admin.context.membershipId }]);
  });
  it('does not let an approved review manufacture a published draft or a nonexistent immutable result', async () => {
    const f = await fixture();
    await proveSecondFactor(f.a.owner);
    const review = await requestPublishReview(app.db, f.a.owner.context, {
      subjectKind: 'agent_draft',
      subjectId: f.draft.id,
      simulationRunId: f.simulation.id,
    });
    await decidePublishReview(
      app.db,
      f.a.owner.context,
      { sessionId: f.a.owner.sessionId },
      { reviewId: review.id, expectedVersion: 1, decision: 'approved' },
    );
    expect(
      await withTenantTx(app.db, f.a.owner.context, (tx) =>
        tx.execute(sql`update studio.agent_drafts set status='published'
      where id=${f.draft.id}::uuid`),
      ).then(() => null, pgCode),
    ).toBe('EN412');
    expect(
      await withTenantTx(app.db, f.a.owner.context, (tx) =>
        tx
          .update(publishReviews)
          .set({
            status: 'published',
            publishedRef: randomUUID(),
            publishedAt: new Date(),
            version: 3,
          })
          .where(eq(publishReviews.id, review.id)),
      ).then(() => null, pgCode),
    ).toBe('EN406');
    expect(
      await withTenantTx(app.db, f.a.owner.context, (tx) => tx.select().from(agentVersions)),
    ).toEqual([]);
  });
  it('atomically commits one actual M4 immutable version and an idempotent published receipt', async () => {
    const f = await fixture();
    await proveSecondFactor(f.a.owner);
    const proof = { sessionId: f.a.owner.sessionId },
      review = await requestPublishReview(app.db, f.a.owner.context, {
        subjectKind: 'agent_draft',
        subjectId: f.draft.id,
        simulationRunId: f.simulation.id,
      }),
      approved = await decidePublishReview(app.db, f.a.owner.context, proof, {
        reviewId: review.id,
        expectedVersion: 1,
        decision: 'approved',
      }),
      result = await publishApproved(app.db, f.a.owner.context, f.ports, proof, {
        reviewId: review.id,
        expectedVersion: approved.version,
      });
    const versions = await withTenantTx(app.db, f.a.owner.context, (tx) =>
      tx.select().from(agentVersions),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.id).toBe(result.publishedRef);
    expect(versions[0]?.specSha256).toBe(f.draft.specSha256);
    expect(
      await publishApproved(app.db, f.a.owner.context, f.ports, proof, {
        reviewId: review.id,
        expectedVersion: approved.version,
      }),
    ).toEqual(result);
    expect(
      await withTenantTx(app.db, f.a.owner.context, (tx) => tx.select().from(agentVersions)),
    ).toHaveLength(1);
  });
  it('publishes with the actual reviewed responsible person while retaining the native human signer', async () => {
    const { a } = await makeTwoTenants(app.db),
      ports = createRuntimeProductPorts(app.db),
      draft = await createAgentDraft(app.db, a.owner.context, ports, {
        name: `Generated accountable ${a.organizationId}`,
        answers: testAnswers(a.member.context.membershipId),
      }),
      simulation = await requestSimulation(app.db, a.owner.context, {
        subject: { kind: 'agent_draft', draftId: draft.id },
        scenarioKey: 'standard.draft_only',
      });
    await runSimulationStep(app.db, createServiceContext(a.organizationId), {
      simulationId: simulation.id,
    });
    await proveSecondFactor(a.owner);
    const proof = { sessionId: a.owner.sessionId },
      review = await requestPublishReview(app.db, a.owner.context, {
        subjectKind: 'agent_draft',
        subjectId: draft.id,
        simulationRunId: simulation.id,
      }),
      approved = await decidePublishReview(app.db, a.owner.context, proof, {
        reviewId: review.id,
        expectedVersion: 1,
        decision: 'approved',
      });
    await publishApproved(app.db, a.owner.context, ports, proof, {
      reviewId: review.id,
      expectedVersion: approved.version,
    });
    expect(
      await withTenantTx(app.db, a.owner.context, (tx) =>
        tx
          .select({
            owner: agentDefinitions.ownerMembershipId,
            identityOwner: serviceIdentities.ownerMembershipId,
            signer: agentVersions.publishedByMembershipId,
          })
          .from(agentVersions)
          .innerJoin(agentDefinitions, eq(agentDefinitions.id, agentVersions.definitionId))
          .innerJoin(
            serviceIdentities,
            eq(serviceIdentities.id, agentDefinitions.serviceIdentityId),
          ),
      ),
    ).toEqual([
      {
        owner: a.member.context.membershipId,
        identityOwner: a.member.context.membershipId,
        signer: a.owner.context.membershipId,
      },
    ]);
  });
});
