import { retryExternalActionSchema } from '@ensemus/contracts/external-actions';
import {
  apiRoute,
  askAgain,
  etag,
  externalActionParams,
  proposedDto,
  readJson,
} from '@/server/api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  externalActionParams,
  async ({ request, context, database, params }) => {
    const body = await readJson(request, retryExternalActionSchema);
    const proposed = await askAgain(
      database,
      context,
      params.externalActionId,
      body.approver_membership_id,
    );
    return Response.json(proposedDto(proposed), { status: 201, headers: { ETag: etag(1) } });
  },
);
