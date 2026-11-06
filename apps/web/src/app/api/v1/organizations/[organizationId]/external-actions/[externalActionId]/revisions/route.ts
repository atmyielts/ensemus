import { reviseEmailActionSchema } from '@ensemus/contracts/external-actions';
import {
  apiRoute,
  etag,
  externalActionParams,
  proposedDto,
  readIfMatch,
  readJson,
  reviseEmail,
} from '@/server/api';

export const dynamic = 'force-dynamic';

export const POST = apiRoute(
  externalActionParams,
  async ({ request, context, database, params }) => {
    const expectedVersion = readIfMatch(request);
    const body = await readJson(request, reviseEmailActionSchema);
    const proposed = await reviseEmail(
      database,
      context,
      params.externalActionId,
      expectedVersion,
      body,
    );
    return Response.json(proposedDto(proposed), { status: 201, headers: { ETag: etag(1) } });
  },
);
