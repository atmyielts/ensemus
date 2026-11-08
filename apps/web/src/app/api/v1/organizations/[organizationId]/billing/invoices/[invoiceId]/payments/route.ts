import { AppError } from '@ensemus/application';
import { requestInvoicePaymentOnce } from '@ensemus/application/saas/payments';
import { loadSaasConfig } from '@ensemus/config';
import { can } from '@ensemus/domain/policy';
import { z } from 'zod';
import { apiRoute, idempotencyKeyReused, organizationParams } from '@/server/api';

export const dynamic = 'force-dynamic';
export const POST = apiRoute(
  organizationParams.extend({ invoiceId: z.uuid() }),
  async ({ request, database, context, params }) => {
    if (context.actorType !== 'user' || !can(context.role, 'billing.manage'))
      throw new AppError('NOT_FOUND');
    const config = loadSaasConfig();
    if (!config.billingEnabled) throw new AppError('BILLING_NOT_ENABLED');
    if (!config.paymentProcessor) throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
    const result = await requestInvoicePaymentOnce(database, context, {
      invoiceId: params.invoiceId,
      processor: config.paymentProcessor,
      requestKey: request.headers.get('idempotency-key') ?? '',
    });
    if (result.kind === 'conflict') throw idempotencyKeyReused();
    return Response.json({ payment_id: result.paymentId, status: result.status }, { status: 202 });
  },
  'account',
);
