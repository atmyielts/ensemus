import { listTickets, openTicket } from '@ensemus/application/saas/support';
import { openTicketSchema } from '@ensemus/contracts/saas';
import { apiRoute, organizationParams, readJson } from '@/server/api';
import { ticketDto } from '../dto';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ database, context }) =>
    Response.json({ items: (await listTickets(database, context)).map(ticketDto) }),
  'account',
);
export const POST = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const body = await readJson(request, openTicketSchema),
      result = await openTicket(database, context, body);
    return Response.json({ ticket_id: result.ticketId }, { status: 201 });
  },
  'account',
);
