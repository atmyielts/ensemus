import { decidePublishReview, getPublishReview } from '@ensemus/application/publish-reviews';
import { decidePublishReviewSchema } from '@ensemus/contracts/studio';
import { apiRoute, readJson, readIfMatch, etag } from '@/server/api';
import { publishReviewDto, publishReviewParams, studioOnce } from '@/server/studio-api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  publishReviewParams,
  async ({ database, context, params, request, sessionId }) => {
    const expectedVersion = readIfMatch(request),
      b = await readJson(request, decidePublishReviewSchema),
      input = {
        reviewId: params.publishReviewId,
        expectedVersion,
        decision: b.decision,
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
      };
    const id = await studioOnce(
      database,
      context,
      request.headers.get('idempotency-key') ?? '',
      'publish-review.decide',
      input,
      (db) => decidePublishReview(db, context, { sessionId }, input),
      200,
    );
    const row = await getPublishReview(database, context, id);
    return Response.json(publishReviewDto(row), { headers: { ETag: etag(row.version) } });
  },
);
