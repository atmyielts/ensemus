import { idSchema, withdrawSubmission } from '@ensemus/application';
import { apiRoute, etag, organizationParams, readIfMatch } from '@/server/api';
import { requireMarketplace, submissionDto } from '@/server/marketplace-api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  organizationParams.extend({ submissionId: idSchema }),
  async ({ context, database, params, request }) => {
    const expectedVersion = readIfMatch(request);
    await requireMarketplace(context);
    const row = await withdrawSubmission(database, context, {
      submissionId: params.submissionId,
      expectedVersion,
    });
    return Response.json(submissionDto(row), { headers: { ETag: etag(row.version) } });
  },
);
