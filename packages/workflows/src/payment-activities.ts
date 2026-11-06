// Owned by the payments slice (BILL-01). See docs/06-delivery/m8-slices.md and ADR-032 D4.
import { PAYMENT_CODES, type PaymentCode, type ProcessorCallContext } from '@ensemus/saas/payment';
import { AppError } from '@ensemus/application';
import {
  beginPaymentAttempt,
  beginPaymentReconcile,
  failUnsentPayment,
  finishPaymentAttempt,
  finishPaymentReconcile,
  getPaymentExecution,
  inspectInterruptedPayment,
  linkPaymentCustomer,
  readPaymentOutcome,
} from '@ensemus/application/saas/payments';
import {
  routePaymentEvent,
  type PaymentRoutingBinding,
} from '@ensemus/application/saas/payment-events';
import type { AgentHaltPort } from '@ensemus/application/saas/ports';
import { createServiceContext } from '@ensemus/database/service';
import { connections, withTenantTx } from '@ensemus/database';
import {
  createPaymentConnector,
  PAYMENT_CONNECTOR_PREFIX,
  runCharge,
  runPaymentLookup,
  SECRET_PURPOSE_PAYMENT_PROCESSOR,
} from '@ensemus/connectors/payment';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { paymentEventInputSchema, paymentInputSchema } from './saas-schemas';
import type { PaymentConnectorDeps, PaymentPlatformDeps } from './saas-deps';
import type {
  ChargeStep,
  InterruptedPaymentStep,
  PaymentEventInput,
  PaymentEventOutcome,
  PaymentInput,
  PaymentReconcileStep,
} from './saas-schemas';

export type PaymentGatewayRequest = (
  binding: { billingOrganizationId: string; connectionId: string; processor: string },
  input: Parameters<ProcessorCallContext['request']>[0],
  signal: AbortSignal,
) => ReturnType<ProcessorCallContext['request']>;
export type PaymentActivityOptions = {
  agents?: AgentHaltPort;
  routing?: PaymentRoutingBinding;
  requestThroughGateway?: PaymentGatewayRequest;
};
const ctx = (input: { organizationId: string }) => createServiceContext(input.organizationId);
async function outcomeAfterNoReconcile(
  deps: PaymentPlatformDeps,
  input: PaymentInput,
): Promise<PaymentReconcileStep> {
  const execution = await getPaymentExecution(deps.database, ctx(input), input);
  if (execution.status === 'ready') return 'retry';
  if (execution.status === 'cancelled') return 'failed';
  if (['succeeded', 'failed', 'unknown'].includes(execution.status))
    return execution.status as 'succeeded' | 'failed' | 'unknown';
  throw new AppError('INVALID_STATE');
}

/** Only what reads and writes PostgreSQL. */
export function createPaymentPlatformActivities(
  deps: PaymentPlatformDeps,
  options: PaymentActivityOptions = {},
) {
  return {
    async inspectInterruptedPaymentStep(input: PaymentInput): Promise<InterruptedPaymentStep> {
      const value = paymentInputSchema.parse(input);
      return inspectInterruptedPayment(deps.database, ctx(value), value);
    },
    async failUnsentPaymentStep(input: PaymentInput & { code: PaymentCode }): Promise<void> {
      const value = paymentInputSchema.extend({ code: z.enum(PAYMENT_CODES) }).parse(input);
      return failUnsentPayment(deps.database, ctx(value), value);
    },
    async routePaymentEventStep(input: PaymentEventInput): Promise<PaymentEventOutcome> {
      const value = paymentEventInputSchema.parse(input);
      return routePaymentEvent(
        deps.database,
        ctx(value),
        { paymentWebhookEventId: value.paymentWebhookEventId },
        options.routing,
        options.agents,
      );
    },
    async settledPaymentOutcomeStep(input: PaymentInput) {
      const value = paymentInputSchema.parse(input);
      return readPaymentOutcome(deps.database, ctx(value), value);
    },
    async concludePaymentWithoutAnswerStep(input: PaymentInput): Promise<PaymentReconcileStep> {
      const value = paymentInputSchema.parse(input);
      const prepared = await beginPaymentReconcile(deps.database, ctx(value), {
        paymentId: value.paymentId,
        code: 'PROCESSOR_ERROR',
      });
      if (!prepared) return outcomeAfterNoReconcile(deps, value);
      return finishPaymentReconcile(
        deps.database,
        ctx(value),
        { attemptId: prepared.attemptId, result: { found: 'cannot_answer' }, lookup: 'none' },
        options.agents,
      );
    },
  };
}
export type PaymentPlatformActivities = ReturnType<typeof createPaymentPlatformActivities>;

/** On the connector queue, because these hold the processor's credential and leave through the gateway. */
export function createPaymentConnectorActivities(
  deps: PaymentConnectorDeps,
  options: PaymentActivityOptions = {},
) {
  async function callFor(processorName: string): Promise<ProcessorCallContext | null> {
    if (!deps.billingOrganizationId || !deps.billingConnectionId || !options.requestThroughGateway)
      return null;
    const processor = deps.processors.get(processorName);
    if (
      !processor ||
      processor.manifest.processor !== processorName ||
      processor.manifest.nativeIdempotency !== true
    )
      return null;
    const expected = createPaymentConnector(processor);
    const [connection] = await withTenantTx(
      deps.database,
      createServiceContext(deps.billingOrganizationId),
      (tx) => tx.select().from(connections).where(eq(connections.id, deps.billingConnectionId!)),
    );
    if (
      !connection ||
      connection.state !== 'active' ||
      connection.connectorType !== PAYMENT_CONNECTOR_PREFIX + processorName ||
      !connection.credentialSecretId
    )
      return null;
    const connector = deps.registry.get(connection.connectorType);
    if (!connector || connector.manifest.credential.purpose !== SECRET_PURPOSE_PAYMENT_PROCESSOR)
      return null;
    try {
      expected.parseConfig(connection.config);
      connector.parseConfig(connection.config);
    } catch {
      return null;
    }
    const organizationId = deps.billingOrganizationId,
      connectionId = connection.id,
      secretId = connection.credentialSecretId;
    return {
      signal: AbortSignal.timeout(60_000),
      withCredential: (use) =>
        deps.secrets.withSecret(
          { organizationId, secretId, purpose: SECRET_PURPOSE_PAYMENT_PROCESSOR },
          use,
        ),
      async request(this: ProcessorCallContext, input) {
        if (
          !/^\/(?!\/)/.test(input.path) ||
          /[\r\n\0]/.test(input.path) ||
          !Number.isSafeInteger(input.timeoutMs) ||
          input.timeoutMs < 1 ||
          input.timeoutMs > 60_000 ||
          Object.entries(input.headers).some(([key, value]) => /[\r\n\0]/.test(key + value))
        )
          throw new Error('PAYMENT_GATEWAY_REQUEST_INVALID');
        return options.requestThroughGateway!(
          { billingOrganizationId: organizationId, connectionId, processor: processorName },
          input,
          this.signal,
        );
      },
    };
  }
  async function failBeforeAttempt(input: PaymentInput, code: PaymentCode): Promise<ChargeStep> {
    await failUnsentPayment(deps.database, ctx(input), { paymentId: input.paymentId, code });
    const state = await inspectInterruptedPayment(deps.database, ctx(input), input);
    return state === 'attempt_open'
      ? { step: 'reconcile' }
      : { step: await readPaymentOutcome(deps.database, ctx(input), input) };
  }
  return {
    /** Begins the attempt, charges once, and records what happened. Temporal never retries this. */
    async chargePaymentStep(input: PaymentInput & { runId: string }): Promise<ChargeStep> {
      const value = paymentInputSchema.extend({ runId: z.uuid() }).parse(input);
      const context = ctx(value);
      const execution = await getPaymentExecution(deps.database, context, {
        paymentId: value.paymentId,
      });
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(execution.status))
        return { step: execution.status as 'succeeded' | 'failed' | 'cancelled' | 'unknown' };
      if (execution.status === 'sending' || execution.status === 'reconciling')
        return { step: 'reconcile' };
      if (execution.preflightCode) return failBeforeAttempt(value, execution.preflightCode);
      const processor = deps.processors.get(execution.processor);
      if (!processor || processor.manifest.processor !== execution.processor)
        return failBeforeAttempt(value, 'PROCESSOR_NOT_CONFIGURED');
      if (!execution.account.customerRef) {
        const registration = await callFor(execution.processor);
        if (!registration) return failBeforeAttempt(value, 'PROCESSOR_NOT_CONFIGURED');
        try {
          const customer = await processor.createCustomer(registration, {
            idempotencyKey: `ensemus-customer:${value.organizationId}:${execution.account.id}:${execution.processor}`,
            billingEmail: execution.account.billingEmail,
            billingName: execution.account.billingName,
          });
          await linkPaymentCustomer(deps.database, context, {
            accountId: execution.account.id,
            processor: execution.processor,
            customerRef: customer.customerRef,
          });
        } catch {
          return failBeforeAttempt(value, 'PROCESSOR_ERROR');
        }
      }
      const begun = await beginPaymentAttempt(deps.database, context, {
        paymentId: value.paymentId,
        runId: value.runId,
      });
      if (begun.kind === 'stop')
        return { step: begun.status as 'succeeded' | 'failed' | 'cancelled' | 'unknown' };
      if (begun.kind === 'reconcile') return { step: 'reconcile' };
      const call = await callFor(begun.processor);
      const result = call
        ? await runCharge(processor, call, begun.charge)
        : {
            outcome: 'not_sent' as const,
            code: 'PROCESSOR_NOT_CONFIGURED' as const,
            retryable: false,
          };
      return finishPaymentAttempt(
        deps.database,
        context,
        { attemptId: begun.attemptId, result },
        options.agents,
      );
    },
    /** Only reads. It may retry. */
    async reconcilePaymentStep(input: PaymentInput): Promise<PaymentReconcileStep> {
      const value = paymentInputSchema.parse(input);
      const context = ctx(value);
      const prepared = await beginPaymentReconcile(deps.database, context, {
        paymentId: value.paymentId,
        code: 'PROCESSOR_ERROR',
      });
      if (!prepared) return outcomeAfterNoReconcile(deps, value);
      const processor = deps.processors.get(prepared.processor);
      const call = processor ? await callFor(prepared.processor) : null;
      const result =
        processor && call
          ? await runPaymentLookup(processor, call, prepared.idempotencyKey)
          : { found: 'cannot_answer' as const };
      return finishPaymentReconcile(
        deps.database,
        context,
        { attemptId: prepared.attemptId, result, lookup: processor?.manifest.lookup ?? 'none' },
        options.agents,
      );
    },
  };
}
export type PaymentConnectorActivities = ReturnType<typeof createPaymentConnectorActivities>;
