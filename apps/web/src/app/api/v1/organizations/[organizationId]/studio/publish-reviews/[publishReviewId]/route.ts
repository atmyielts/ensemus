import { getPublishReview, cancelPublishReview } from '@ensemus/application/publish-reviews';
import { apiRoute, etag, readIfMatch } from '@/server/api';
import { publishReviewDto, publishReviewParams } from '@/server/studio-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(publishReviewParams, async ({ database, context, params }) => {
  const row = await getPublishReview(database, context, params.publishReviewId);
  return Response.json(publishReviewDto(row), { headers: { ETag: etag(row.version) } });
});
export const DELETE = apiRoute(
  publishReviewParams,
  async ({ database, context, params, request }) => {
    await cancelPublishReview(database, context, {
      reviewId: params.publishReviewId,
      expectedVersion: readIfMatch(request),
    });
    return new Response(null, { status: 204 });
  },
);
