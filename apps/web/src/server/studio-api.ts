import 'server-only';
import { AppError, idSchema, requestHash, runIdempotent } from '@ensemus/application';
import type { AgentDraftView } from '@ensemus/application/agent-drafts';
import type { ProcessDraftView } from '@ensemus/application/process-specs';
import type { PublishReviewView } from '@ensemus/application/publish-reviews';
import type { SimulationView } from '@ensemus/application/simulations';
import type { AppDatabase, TenantContext } from '@ensemus/database';
import { canonicalJson } from '@ensemus/domain/approval';
import { organizationParams } from './api';

export const agentDraftParams = organizationParams.extend({ agentDraftId: idSchema });
export const processDraftParams = organizationParams.extend({ processDraftId: idSchema });
export const simulationParams = organizationParams.extend({ simulationId: idSchema });
export const publishReviewParams = organizationParams.extend({ publishReviewId: idSchema });
export const agentDraftDto = (row: AgentDraftView) => ({
  id: row.id,
  name: row.name,
  owner_membership_id: row.ownerMembershipId,
  agent_definition_id: row.agentDefinitionId,
  answers: row.answers,
  spec_sha256: row.specSha256,
  status: row.status,
  from_pack_installation_id: row.fromPackInstallationId,
  version: row.version,
  updated_at: row.updatedAt.toISOString(),
});
export const processDraftDto = (row: ProcessDraftView) => ({
  id: row.id,
  name: row.name,
  owner_membership_id: row.ownerMembershipId,
  classification: row.classification,
  graph: row.graph,
  spec_sha256: row.specSha256,
  issues: row.issues,
  status: row.status,
  version: row.version,
  updated_at: row.updatedAt.toISOString(),
});
export const simulationDto = (row: SimulationView) => ({
  id: row.id,
  subject_kind: row.subjectKind,
  subject_id: row.subjectId,
  subject_key: row.subjectKey,
  subject_sha256: row.subjectSha256,
  scenario_key: row.scenarioKey,
  status: row.status,
  outcome_code: row.outcomeCode,
  report: row.report,
  created_at: row.createdAt.toISOString(),
  finished_at: row.finishedAt?.toISOString() ?? null,
});
export const publishReviewDto = (row: PublishReviewView) => ({
  id: row.id,
  subject_kind: row.subjectKind,
  subject_id: row.subjectId,
  subject_sha256: row.subjectSha256,
  simulation_run_id: row.simulationRunId,
  risk_level: row.riskLevel,
  risk_summary: row.riskSummary,
  requested_by_membership_id: row.requestedByMembershipId,
  reviewer_membership_id: row.reviewerMembershipId,
  status: row.status,
  decision_reason: row.decisionReason,
  published_ref: row.publishedRef,
  version: row.version,
  created_at: row.createdAt.toISOString(),
});

/**
 * The response a key stores. `runIdempotent` builds it inside the service's transaction, from that
 * transaction's own result, never from what `effect` returns after it. So a service that does not name
 * its record there is refused before the key row is written, and the whole transaction rolls back: an
 * effect is never committed under a key that could not replay it.
 */
export function studioResponse(status: number) {
  return (row: unknown) => {
    const id = idSchema.safeParse(
      typeof row === 'object' && row !== null && 'id' in row ? row.id : undefined,
    );
    if (!id.success)
      throw new Error('A Studio service must name its committed record in its transaction');
    return { status, body: { id: id.data } };
  };
}

/** Store only the committed identity. Every replay rereads through current native/tenant/record ACL. */
export async function studioOnce(
  database: AppDatabase,
  context: TenantContext,
  key: string,
  operation: string,
  input: unknown,
  effect: (db: AppDatabase) => Promise<{ id: string }>,
  status = 201,
): Promise<string> {
  const once = () =>
    runIdempotent(
      database,
      context,
      { key, requestHash: requestHash([operation, canonicalJson(input)]) },
      effect,
      studioResponse(status),
    );
  let result;
  try {
    result = await once();
  } catch (error) {
    // A review's uniqueness guard can see the winning transaction before the key insertion does.
    // Retry only this known conflict once; the fresh key lookup either replays it or refuses again.
    if (!(error instanceof AppError) || error.code !== 'REVIEW_ALREADY_OPEN') throw error;
    result = await once();
  }
  if (result.kind === 'conflict') throw new AppError('IDEMPOTENCY_KEY_REUSED');
  const parsed = idSchema.safeParse(
    typeof result.body === 'object' && result.body !== null && 'id' in result.body
      ? result.body.id
      : null,
  );
  if (!parsed.success) throw new AppError('INVALID_STATE');
  return parsed.data;
}
