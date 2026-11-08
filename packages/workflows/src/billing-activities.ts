// Owned by the invoicing slice (BILL-02). See docs/06-delivery/m8-slices.md.
import type { BillingActivityDeps } from './saas-deps';
import type { BillingCycleInput } from './saas-schemas';
import { billingCycleInputSchema } from './saas-schemas';
import {
  draftDuePeriodInvoices,
  issueInvoice,
  listDraftsNeedingTax,
  loadTaxQuestion,
} from '@ensemus/application/saas/invoices';
import { runCollections } from '@ensemus/application/saas/collections';
import { AppError, idSchema } from '@ensemus/application';
import { createServiceContext } from '@ensemus/database/service';
import { createLogger } from '@ensemus/telemetry';

const log = createLogger('billing-activities');

export function createBillingActivities(deps: BillingActivityDeps) {
  return {
    /** Moves periods on, drafts what is due, and runs collections. Counts and a code come back. */
    async runBillingSweep(
      input: BillingCycleInput,
    ): Promise<{ closedPeriods: number; draftIds: readonly string[]; refusedCode: string | null }> {
      if (deps.billingEnabled !== true) throw new AppError('BILLING_NOT_ENABLED');
      const value = billingCycleInputSchema.parse(input);
      const context = createServiceContext(value.organizationId);
      const result = await draftDuePeriodInvoices(
        deps.database,
        context,
        { usage: deps.usage, agents: deps.agents },
        new Date(),
      );
      const draftIds = result.refusedCode ? [] : await listDraftsNeedingTax(deps.database, context);
      return { closedPeriods: result.closedPeriods, draftIds, refusedCode: result.refusedCode };
    },
    /** For tax that needs no outside call, and everything else after it. Safe to repeat. */
    async issueDraftInvoice(
      input: BillingCycleInput & { invoiceId: string },
    ): Promise<'issued' | 'already_issued' | 'needs_tax_port' | 'refused'> {
      if (deps.billingEnabled !== true) throw new AppError('BILLING_NOT_ENABLED');
      const { organizationId, invoiceId } = billingCycleInputSchema
        .extend({ invoiceId: idSchema })
        .parse(input);
      const context = createServiceContext(organizationId);
      try {
        const question = await loadTaxQuestion(deps.database, context, invoiceId);
        if (!question) return 'already_issued';
        if (question.treatment === 'provider_computed') return 'needs_tax_port';
        return await issueInvoice(deps.database, context, {
          invoiceId,
          tax: { taxMicros: 0n, providerRef: null },
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        log.warn('billing.invoice_refused', { organizationId, invoiceId, reasonCode: error.code });
        return 'refused';
      }
    },
    async runCollectionsStep(input: BillingCycleInput): Promise<{ stepsTaken: number }> {
      if (deps.billingEnabled !== true) throw new AppError('BILLING_NOT_ENABLED');
      const value = billingCycleInputSchema.parse(input);
      const result = await runCollections(
        deps.database,
        createServiceContext(value.organizationId),
        { agents: deps.agents },
        new Date(),
      );
      return { stepsTaken: result.stepsTaken };
    },
  };
}
export type BillingActivities = ReturnType<typeof createBillingActivities>;
