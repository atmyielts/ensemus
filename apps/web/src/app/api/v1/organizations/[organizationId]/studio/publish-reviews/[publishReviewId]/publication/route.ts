import { publishApproved, getPublishReview } from '@ensemus/application/publish-reviews';
import { apiRoute, readIfMatch, etag } from '@/server/api';
import { publishReviewDto, publishReviewParams, studioOnce } from '@/server/studio-api';
import { webProductPorts } from '@/server/product-ports';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  publishReviewParams,
  async ({ database, context, params, request, sessionId }) => {
    const input = { reviewId: params.publishReviewId, expectedVersion: readIfMatch(request) };
    const id = await studioOnce(
      database,
      context,
      request.headers.get('idempotency-key') ?? '',
      'publish-review.publish',
      input,
      // The stored idempotent response comes from the service's transaction result, which names the
      // review. Remapping it here would be ignored, so pass the receipt through unchanged.
      (db) => publishApproved(db, context, webProductPorts(), { sessionId }, input),
      200,
    );
    const row = await getPublishReview(database, context, id);
    return Response.json(publishReviewDto(row), { headers: { ETag: etag(row.version) } });
  },
);
