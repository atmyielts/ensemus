// Real native author/reviewer, worker intent and M4-backed publication. No published-row seed.
import pg from 'pg';
import { interactiveSessionOf, type AppDatabase, type TenantContext } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { createRuntimeProductPorts } from '@ensemus/application/product-runtime';
import {
  createProcessDraft,
  updateProcessDraft,
  getProcessSpec,
} from '@ensemus/application/process-specs';
import { requestSimulation, runSimulationStep } from '@ensemus/application/simulations';
import {
  requestPublishReview,
  decidePublishReview,
  publishApproved,
} from '@ensemus/application/publish-reviews';
import type { ProcessGraph } from '@ensemus/domain/process-spec';
import { makePerson, nativePersonContext, proveSecondFactor } from './product';
import { urls } from './stack';
import { inFixtureTenant } from './fixture-tenant';

export async function publishReviewedProcess(
  database: AppDatabase,
  context: TenantContext,
  graph: ProcessGraph,
  name: string,
) {
  const identity = interactiveSessionOf(context);
  if (!identity) throw Error('TEST_NATIVE_AUTHOR_REQUIRED');
  await proveSecondFactor({ userId: context.userId, sessionId: identity.sessionId });
  const person = await makePerson('generated-process-reviewer'),
    su = new pg.Client({ connectionString: urls.superuser() });
  await su.connect();
  try {
    await inFixtureTenant(su, context.organizationId, () =>
      su.query(
        `insert into org.memberships(organization_id,user_id,role,status) values($1,$2,'admin','active')`,
        [context.organizationId, person.userId],
      ),
    );
  } finally {
    await su.end();
  }
  const reviewer = await nativePersonContext(database, person, context.organizationId);
  await proveSecondFactor(person);
  const ports = createRuntimeProductPorts(database),
    draft = await createProcessDraft(database, context, { name, classification: 'internal' });
  await updateProcessDraft(database, context, ports, {
    draftId: draft.id,
    expectedVersion: draft.version,
    graph,
  });
  const simulation = await requestSimulation(database, context, {
    subject: { kind: 'process_draft', draftId: draft.id },
    scenarioKey: 'standard.process',
  });
  if (
    (await runSimulationStep(database, createServiceContext(context.organizationId), {
      simulationId: simulation.id,
    })) !== 'passed'
  )
    throw Error('TEST_PROCESS_REHEARSAL_FAILED');
  const review = await requestPublishReview(database, context, {
    subjectKind: 'process_draft',
    subjectId: draft.id,
    simulationRunId: simulation.id,
    reviewerMembershipId: reviewer.membershipId,
  });
  const approved = await decidePublishReview(
    database,
    reviewer,
    { sessionId: person.sessionId },
    { reviewId: review.id, expectedVersion: review.version, decision: 'approved' },
  );
  const published = await publishApproved(
    database,
    context,
    ports,
    { sessionId: identity.sessionId },
    { reviewId: review.id, expectedVersion: approved.version },
  );
  const spec = await getProcessSpec(database, context, published.publishedRef);
  return { specId: spec.id, versionNumber: spec.versionNumber };
}
