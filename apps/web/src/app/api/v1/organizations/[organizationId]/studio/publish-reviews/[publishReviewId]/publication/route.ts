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
      async (db) => {
        await publishApproved(db, context, webProductPorts(), { sessionId }, input);
        return { id: input.reviewId };
      },
      200,
    );
    const row = await getPublishReview(database, context, id);
    return Response.json(publishReviewDto(row), { headers: { ETag: etag(row.version) } });
  },
);
