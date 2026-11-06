import { listExternalActions } from '@ensemus/application';
import { externalActionStatusSchema } from '@ensemus/contracts/external-actions';
import { z } from 'zod';
import { apiRoute, externalActionSummaryDto, organizationParams, readQuery } from '@/server/api';

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  status: externalActionStatusSchema.optional(),
  work_unit_id: z.uuid().optional(),
});

export const GET = apiRoute(organizationParams, async ({ request, context, database }) => {
  const { cursor, status, work_unit_id: workUnitId } = readQuery(request, listQuery);
  const page = await listExternalActions(database, context, {
    ...(cursor ? { after: cursor } : {}),
    ...(status ? { status } : {}),
    ...(workUnitId ? { workUnitId } : {}),
  });
  return Response.json({
    items: page.items.map(externalActionSummaryDto),
    next_cursor: page.next,
  });
});
