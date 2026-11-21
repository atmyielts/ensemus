import { AppError, idSchema, listBusinessRecords } from '@ensemus/application';
import { z } from 'zod';
import { apiRoute } from '@/server/api';
import { businessRecordQuery, businessRecordDto } from '@/server/business-record-api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  z.object({ organizationId: idSchema }),
  async ({ database, context, request }) => {
    const parsed = businessRecordQuery.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    const q = parsed.data,
      result = await listBusinessRecords(database, context, {
        ...(q.connection_id ? { connectionId: q.connection_id } : {}),
        ...(q.stream ? { stream: q.stream } : {}),
        ...(q.cursor ? { after: q.cursor } : {}),
      });
    return Response.json({
      items: result.items.map(businessRecordDto),
      next_cursor: result.nextCursor,
    });
  },
);
