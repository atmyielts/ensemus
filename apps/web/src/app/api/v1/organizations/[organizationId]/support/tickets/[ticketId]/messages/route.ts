import { replyToTicket } from '@ensemus/application/saas/support';
import { replyTicketSchema } from '@ensemus/contracts/saas';
import { z } from 'zod';
import { apiRoute, etag, organizationParams, readIfMatch, readJson } from '@/server/api';
export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams.extend({ ticketId: z.uuid() }),
  async ({ request, database, context, params }) => {
    const body = await readJson(request, replyTicketSchema),
      result = await replyToTicket(database, context, {
        ticketId: params.ticketId,
        body: body.body,
        expectedVersion: readIfMatch(request),
      });
    return Response.json(result, { headers: { etag: etag(result.version) } });
  },
  'account',
);
