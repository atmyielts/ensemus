// ADR-032 D4a. On the connector queue, because Paddle is an outside call and only this process holds its
// key. What crosses Temporal is IDs and enums; amounts, links and Paddle's answers stay here and in
// PostgreSQL.
import { AppError } from '@ensemus/application';
import {
  loadCheckoutForWorker,
  recordCheckoutNotOpened,
  recordCheckoutOpened,
} from '@ensemus/application/saas/checkout';
import { applyPaddleLookup } from '@ensemus/application/saas/checkout-callbacks';
import type { AgentHaltPort } from '@ensemus/application/saas/ports';
import type { PaddleClient } from '@ensemus/connectors/checkout';
import type { AppDatabase } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import type { PaddleLookup } from '@ensemus/saas/checkout';
import { createLogger, errorCode } from '@ensemus/telemetry';
import {
  checkoutInputSchema,
  type CheckoutInput,
  type CheckoutLookupStep,
  type CheckoutOpenStep,
} from './saas-schemas';

const log = createLogger('checkout-activities');

export type CheckoutConnectorDeps = {
  database: AppDatabase;
  /** Null unless the server names Paddle and its key is mounted. A checkout then closes unopened. */
  paddle: PaddleClient | null;
  /** The secrets-role witness for what Paddle's own transaction said. */
  attestLookup: (input: {
    organizationId: string;
    sessionId: string;
    restoreGeneration: string;
    action: 'paddle.lookup_paid' | 'paddle.lookup_cancelled';
    txnRef: string;
    amountMinor: bigint | null;
    currency: string | null;
  }) => Promise<{ token: string }>;
  agents?: AgentHaltPort;
};

export function createCheckoutConnectorActivities(deps: CheckoutConnectorDeps) {
  return {
    async openCheckoutStep(raw: CheckoutInput): Promise<CheckoutOpenStep> {
      const input = checkoutInputSchema.parse(raw);
      const context = createServiceContext(input.organizationId);
      const checkout = await loadCheckoutForWorker(deps.database, context, input);
      if (checkout.state !== 'opening') return checkout.state === 'open' ? 'open' : 'settled';
      if (checkout.processor !== 'paddle' || !deps.paddle || !checkout.account) {
        await recordCheckoutNotOpened(deps.database, context, input);
        return 'cancelled';
      }
      try {
        const customerRef = await deps.paddle.customerFor({
          email: checkout.account.email,
          name: checkout.account.name,
        });
        const addressId = await deps.paddle.addressFor(customerRef, {
          countryCode: checkout.account.countryCode,
          postalCode: checkout.account.postalCode,
          region: checkout.account.regionCode,
        });
        const opened = await deps.paddle.createTransaction({
          customerId: customerRef,
          addressId,
          currency: checkout.currency,
          amountMinor: checkout.amountMinor,
          description:
            checkout.invoiceNumber === null
              ? 'Ensemus invoice'
              : `Ensemus invoice ${checkout.invoiceNumber}`,
          orderRef: checkout.sessionId,
        });
        const recorded = await recordCheckoutOpened(deps.database, context, {
          sessionId: input.sessionId,
          transactionId: opened.transactionId,
          checkoutUrl: opened.checkoutUrl,
          customerRef,
        });
        return recorded === 'open' ? 'open' : 'settled';
      } catch (error) {
        // Refused or unanswered, Paddle's link reached nobody, so nothing can be paid through it.
        log.warn('checkout.not_opened', {
          organizationId: input.organizationId,
          errorCode: errorCode(error),
        });
        await recordCheckoutNotOpened(deps.database, context, input);
        return 'cancelled';
      }
    },

    async lookupCheckoutStep(raw: CheckoutInput): Promise<CheckoutLookupStep> {
      const input = checkoutInputSchema.parse(raw);
      const context = createServiceContext(input.organizationId);
      const checkout = await loadCheckoutForWorker(deps.database, context, input);
      if (checkout.state !== 'open') return 'settled';
      if (!deps.paddle || !checkout.providerTxnRef)
        throw new AppError('PAYMENT_PROCESSOR_NOT_CONFIGURED');
      const lookup: PaddleLookup = await deps.paddle.transaction(checkout.providerTxnRef);
      if (lookup.status === 'open') return 'still_open';
      const attested = await deps.attestLookup({
        organizationId: input.organizationId,
        sessionId: input.sessionId,
        restoreGeneration: checkout.restoreGeneration,
        action: lookup.status === 'paid' ? 'paddle.lookup_paid' : 'paddle.lookup_cancelled',
        txnRef: lookup.transactionId,
        amountMinor: lookup.status === 'paid' ? BigInt(lookup.grandTotalMinor) : null,
        currency: lookup.status === 'paid' ? lookup.currency : null,
      });
      const applied = await applyPaddleLookup(
        deps.database,
        context,
        { sessionId: input.sessionId, lookup, verificationToken: attested.token },
        deps.agents,
      );
      if (applied === 'mismatch' || applied === 'paid_after_close') {
        log.warn('checkout.needs_person', {
          organizationId: input.organizationId,
          reasonCode: applied,
        });
        return 'needs_person';
      }
      return applied === 'still_open' ? 'still_open' : 'settled';
    },
  };
}
export type CheckoutConnectorActivities = ReturnType<typeof createCheckoutConnectorActivities>;
