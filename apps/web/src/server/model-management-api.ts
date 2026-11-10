import 'server-only';
import { AppError, idSchema } from '@ensemus/application';
import {
  approveModelWorkload,
  listModelQualifications,
  listModelWorkloadApprovals,
  requestModelQualification,
  revokeModelWorkload,
  type ModelQualificationView,
  type ModelWorkloadApprovalView,
} from '@ensemus/application/knowledge/model-jobs';
import {
  approveModelWorkloadBodySchema,
  requestModelQualificationBodySchema,
} from '@ensemus/contracts/knowledge-models';
import type { ModelJobBounds } from '@ensemus/domain/knowledge-models';
import { apiRoute, organizationParams, readJson } from './api';

const profileParams = organizationParams.extend({ modelProfileId: idSchema });
const approvalParams = organizationParams.extend({ approvalId: idSchema });
function cursor(request: Request) {
  const raw = new URL(request.url).searchParams.get('after');
  if (raw === null) return undefined;
  const parsed = idSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_INPUT');
  return parsed.data;
}
const boundsDto = (b: ModelJobBounds) => ({
  max_calls: b.maxCalls,
  max_input_tokens: b.maxInputTokens,
  max_output_tokens: b.maxOutputTokens,
  max_total_tokens: b.maxTotalTokens,
  max_cost_micros: b.maxCostMicros,
  timeout_seconds: b.timeoutSeconds,
});
const qualificationDto = (q: ModelQualificationView) => ({
  id: q.id,
  profile_id: q.profileId,
  profile_alias: q.profileAlias,
  profile_version: q.profileVersion,
  purpose: q.purpose,
  protocol: q.protocol,
  dimension: q.dimension,
  vector_space_version: q.vectorSpaceVersion,
  state: q.state,
  current: q.current,
  usable: q.usable,
  result_digest: q.resultDigest,
  qualified_at: q.qualifiedAt,
  created_at: q.createdAt,
  bounds: boundsDto(q),
  job: q.job
    ? { id: q.job.id, state: q.job.state, code: q.job.code, unknown_outcome: q.job.unknownOutcome }
    : null,
});
const approvalDto = (a: ModelWorkloadApprovalView) => ({
  id: a.id,
  kind: a.kind,
  scope: a.scope,
  source_id: a.sourceId,
  connection_id: a.connectionId,
  purposes: a.purposes,
  max_classification: a.maxClassification,
  bounds: boundsDto(a),
  expires_at: a.expiresAt,
  revoked_at: a.revokedAt,
  created_at: a.createdAt,
  qualifications: a.qualifications.map((q) => ({ id: q.id, usable: q.usable })),
});
export const qualificationsGET = apiRoute(
  profileParams,
  async ({ request, database, context, params }) => {
    const after = cursor(request);
    const page = await listModelQualifications(database, context, {
      profileId: params.modelProfileId,
      ...(after ? { after } : {}),
    });
    return Response.json({ items: page.items.map(qualificationDto), next_cursor: page.nextCursor });
  },
);
/** Durable request only. No provider transport, key lender, private payload read or workflow client. */
export const qualificationsPOST = apiRoute(
  profileParams,
  async ({ request, database, context, params }) => {
    const body = await readJson(request, requestModelQualificationBodySchema);
    const requested = await requestModelQualification(database, context, {
      ...body,
      profileId: params.modelProfileId,
    });
    return Response.json(
      { qualification_id: requested.qualificationId, job_id: requested.jobId },
      { status: 202 },
    );
  },
);
export const workloadsGET = apiRoute(organizationParams, async ({ request, database, context }) => {
  const page = await listModelWorkloadApprovals(database, context, cursor(request));
  return Response.json({ items: page.items.map(approvalDto), next_cursor: page.nextCursor });
});
export const workloadsPOST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const input = await readJson(request, approveModelWorkloadBodySchema);
    const approved = await approveModelWorkload(database, context, input);
    return Response.json({ approval_id: approved.approvalId }, { status: 201 });
  },
);
export const workloadDELETE = apiRoute(approvalParams, async ({ database, context, params }) => {
  await revokeModelWorkload(database, context, params.approvalId);
  return new Response(null, { status: 204 });
});
