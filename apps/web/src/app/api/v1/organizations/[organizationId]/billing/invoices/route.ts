import { listInvoices } from '@ensemus/application/saas/invoices';
import { z } from 'zod';
import { apiRoute, organizationParams, readQuery } from '@/server/api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams,
  async ({ request, database, context }) => {
    const { cursor } = readQuery(
      request,
      z.strictObject({ cursor: z.string().min(1).max(512).optional() }),
    );
    const page = await listInvoices(database, context, cursor ? { after: cursor } : {});
    return Response.json({
      items: page.items.map((row) => ({
        id: row.id,
        invoice_number: row.invoiceNumber,
        kind: row.kind,
        status: row.status,
        currency: row.currency,
        total_micros: row.totalMicros.toString(),
        issued_at: row.issuedAt?.toISOString() ?? null,
        due_at: row.dueAt?.toISOString() ?? null,
        paid_at: row.paidAt?.toISOString() ?? null,
      })),
      next_cursor: page.nextCursor,
    });
  },
  'account',
);
