import {
  requestPublishReview,
  getPublishReview,
  listPublishReviews,
} from '@ensemus/application/publish-reviews';
import { requestPublishReviewSchema } from '@ensemus/contracts/studio';
import { apiRoute, organizationParams, readJson, etag } from '@/server/api';
import { publishReviewDto, studioOnce } from '@/server/studio-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(organizationParams, async ({ database, context }) =>
  Response.json({ items: (await listPublishReviews(database, context)).map(publishReviewDto) }),
);
export const POST = apiRoute(organizationParams, async ({ database, context, request }) => {
  const b = await readJson(request, requestPublishReviewSchema),
    input = {
      subjectKind: b.subject_kind,
      subjectId: b.subject_id,
      simulationRunId: b.simulation_run_id,
      ...(b.reviewer_membership_id ? { reviewerMembershipId: b.reviewer_membership_id } : {}),
    };
  const id = await studioOnce(
    database,
    context,
    request.headers.get('idempotency-key') ?? '',
    'publish-review.request',
    input,
    (db) => requestPublishReview(db, context, input),
  );
  const row = await getPublishReview(database, context, id);
  return Response.json(publishReviewDto(row), {
    status: 201,
    headers: { ETag: etag(row.version) },
  });
});
