import { getInvoice } from '@ensemus/application/saas/invoices';
import { idSchema } from '@ensemus/application';
import { apiRoute, etag, organizationParams } from '@/server/api';
export const dynamic = 'force-dynamic';
export const GET = apiRoute(
  organizationParams.extend({ invoiceId: idSchema }),
  async ({ database, context, params }) => {
    const row = await getInvoice(database, context, params.invoiceId);
    return Response.json(
      {
        id: row.id,
        invoice_number: row.invoiceNumber,
        kind: row.kind,
        status: row.status,
        currency: row.currency,
        subtotal_micros: row.subtotalMicros.toString(),
        tax_micros: row.taxMicros.toString(),
        total_micros: row.totalMicros.toString(),
        minor_unit_exponent: row.minorUnitExponent,
        issued_at: row.issuedAt?.toISOString() ?? null,
        due_at: row.dueAt?.toISOString() ?? null,
        paid_at: row.paidAt?.toISOString() ?? null,
        version: row.version,
        lines: row.lines.map((line) => ({
          line_no: line.lineNo,
          kind: line.kind,
          meter: line.meter,
          quantity: line.quantity?.toString() ?? null,
          unit: line.unit,
          unit_price_micros: line.unitPriceMicros?.toString() ?? null,
          amount_micros: line.amountMicros.toString(),
        })),
      },
      { headers: { ETag: etag(row.version) } },
    );
  },
  'account',
);
