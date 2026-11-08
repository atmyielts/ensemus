// Owned by the invoicing slice (BILL-03). On the connector queue, because a tax provider is an outside call.
import type { PaymentConnectorDeps } from './saas-deps';
import type { BillingCycleInput } from './saas-schemas';
import { billingCycleInputSchema } from './saas-schemas';
import { AppError, idSchema } from '@ensemus/application';
import { issueInvoice, loadTaxQuestion } from '@ensemus/application/saas/invoices';
import { createServiceContext } from '@ensemus/database/service';
import { TaxRefused } from '@ensemus/saas/tax';
import { createLogger } from '@ensemus/telemetry';

const log = createLogger('tax-activities');

export function createTaxActivities(deps: PaymentConnectorDeps) {
  return {
    /** Asks the port, then issues. No port configured leaves it a draft, with a code, and asks nobody. */
    async computeTaxAndIssue(
      input: BillingCycleInput & { invoiceId: string },
    ): Promise<'issued' | 'already_issued' | 'refused'> {
      if (deps.billingEnabled !== true) throw new AppError('BILLING_NOT_ENABLED');
      const { organizationId, invoiceId } = billingCycleInputSchema
        .extend({ invoiceId: idSchema })
        .parse(input);
      const context = createServiceContext(organizationId);
      try {
        const question = await loadTaxQuestion(deps.database, context, invoiceId);
        if (!question) return 'already_issued';
        if (question.treatment === 'not_collected')
          return await issueInvoice(deps.database, context, {
            invoiceId,
            tax: { taxMicros: 0n, providerRef: null },
          });
        if (!deps.tax) {
          log.warn('billing.tax_refused', {
            organizationId,
            invoiceId,
            reasonCode: 'TAX_PROVIDER_NOT_CONFIGURED',
          });
          return 'refused';
        }
        let tax;
        try {
          tax = await deps.tax.compute(question.input, AbortSignal.timeout(60_000));
        } catch (error) {
          log.warn('billing.tax_refused', {
            organizationId,
            invoiceId,
            reasonCode: error instanceof TaxRefused ? error.code : 'TAX_PROVIDER_UNAVAILABLE',
          });
          return 'refused';
        }
        if (
          !tax ||
          typeof tax.taxMicros !== 'bigint' ||
          typeof tax.providerRef !== 'string' ||
          tax.currency !== question.input.currency ||
          tax.taxMicros < 0n
        )
          return 'refused';
        return await issueInvoice(deps.database, context, {
          invoiceId,
          tax: {
            taxMicros: tax.taxMicros,
            providerRef: tax.providerRef,
            questionHash: question.questionHash,
          },
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        log.warn('billing.tax_refused', { organizationId, invoiceId, reasonCode: error.code });
        return 'refused';
      }
    },
  };
}
export type TaxActivities = ReturnType<typeof createTaxActivities>;
