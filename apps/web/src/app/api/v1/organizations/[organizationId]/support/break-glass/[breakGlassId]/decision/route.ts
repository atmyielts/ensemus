import { AppError } from '@ensemus/application';
import { decideBreakGlass, listBreakGlassRequests } from '@ensemus/application/saas/break-glass';
import { loadSaasConfig } from '@ensemus/config';
import { decideBreakGlassSchema } from '@ensemus/contracts/saas';
import { z } from 'zod';
import { apiRoute, etag, organizationParams, readIfMatch, readJson } from '@/server/api';
import { breakGlassDto } from '../../../dto';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams.extend({ breakGlassId: z.uuid() }),
  async ({ request, database, context, params }) => {
    const body = await readJson(request, decideBreakGlassSchema);
    await decideBreakGlass(
      database,
      context,
      {
        requestId: params.breakGlassId,
        decision: body.decision,
        expectedVersion: readIfMatch(request),
      },
      loadSaasConfig().breakGlass,
    );
    const [row] = await listBreakGlassRequests(database, context, {
      requestId: params.breakGlassId,
    });
    if (!row) throw new AppError('NOT_FOUND');
    return Response.json(breakGlassDto(row), { headers: { etag: etag(row.version) } });
  },
  'account',
);
