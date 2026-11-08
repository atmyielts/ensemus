import { getTicket } from '@ensemus/application/saas/support';
import { z } from 'zod';
import { apiRoute, etag, organizationParams } from '@/server/api';
import { ticketDto } from '../../dto';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams.extend({ ticketId: z.uuid() }),
  async ({ database, context, params }) => {
    const row = await getTicket(database, context, params.ticketId);
    return Response.json(
      {
        ...ticketDto(row),
        messages: row.messages.map((message) => ({
          id: message.id,
          author_kind: message.authorKind,
          body: message.body,
          created_at: message.createdAt.toISOString(),
        })),
      },
      { headers: { etag: etag(row.version) } },
    );
  },
  'account',
);
