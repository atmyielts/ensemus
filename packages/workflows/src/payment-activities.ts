// Owned by the payments slice (BILL-01). See docs/06-delivery/m8-slices.md and ADR-032 D4.
import { PAYMENT_CODES, type PaymentCode, type ProcessorCallContext, type PaymentGatewayBinding, type PaymentConnectionAuthority } from '@ensemus/saas/payment';
import { AppError } from '@ensemus/application';
import {
  beginPaymentAttempt,
  beginPaymentReconcile,
  failUnsentPayment,
  finishPaymentAttempt,
  finishPaymentReconcile,
  getPaymentExecution,
  inspectInterruptedPayment,
  readPaymentOutcome,
} from '@ensemus/application/saas/payments';
import {
  routePaymentEvent,
  type PaymentRoutingBinding,
} from '@ensemus/application/saas/payment-events';
import type { AgentHaltPort } from '@ensemus/application/saas/ports';
import {
  preflightPaymentExecution, bindPaymentExecution, readPaymentExecutionBinding,
  beginPaymentCustomerRegistration, finishPaymentCustomerRegistration,
  qualifyPaymentWebhookExecution,
  type PaymentExecutionBinding,
} from '@ensemus/application/saas/payment-execution';
import { createServiceContext } from '@ensemus/database/service';
import {
  identifyPaymentExecution,
  type VerifiedPaymentExecutionIdentity,
  runBoundCharge,
  runBoundCustomerRegistration,
  runBoundPaymentLookup,
  SECRET_PURPOSE_PAYMENT_PROCESSOR,
} from '@ensemus/connectors/payment';
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
  binding: PaymentGatewayBinding,
  input: Parameters<ProcessorCallContext['request']>[0],
  signal: AbortSignal,
) => ReturnType<ProcessorCallContext['request']>;
export type PaymentActivityOptions = {
  agents?: AgentHaltPort;
  routing?: PaymentRoutingBinding;
  requestThroughGateway?: PaymentGatewayRequest;
  /** A real native adapter's configured TLS target; absent is unavailable, never inferred from a payload. */
  paymentApiOrigin?: string;
  /** Actual selected stored endpoint. Omitted endpoints do not receive a guessed native qualification. */
  paymentWebhookEndpointId?: string;
  /** The existing secrets-role native worker, consuming only an opaque in-process verified identity. */
  attestIdentity?: (input: { organizationId: string; paymentId: string; authority: PaymentConnectionAuthority; proof: VerifiedPaymentExecutionIdentity }) => Promise<{ token: string; expiresAt: Date }>;
};
const ctx = (input: { organizationId: string }) => createServiceContext(input.organizationId);
async function outcomeAfterNoReconcile(
  deps: PaymentPlatformDeps,
  input: PaymentInput,
): Promise<PaymentReconcileStep> {
  const execution = await getPaymentExecution(deps.database, ctx(input), input);
  if (['ready', 'sending', 'reconciling'].includes(execution.status)) return 'retry';
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
      // A lost worker/configuration exception is not an original-merchant reconciliation answer.
      // The connector Activity alone may conclude after its exact native authority was established.
      return outcomeAfterNoReconcile(deps, value);
    },
  };
}
export type PaymentPlatformActivities = ReturnType<typeof createPaymentPlatformActivities>;

/** On the connector queue, because these hold the processor's credential and leave through the gateway. */
export function createPaymentConnectorActivities(
  deps: PaymentConnectorDeps,
  options: PaymentActivityOptions = {},
) {
  const wait: ChargeStep = { step: 'retry', afterMs: 300_000 };
  const configured = () => Boolean(deps.billingOrganizationId && deps.billingConnectionId
    && deps.paymentProcessor && options.paymentApiOrigin && options.requestThroughGateway && options.attestIdentity);

  // This performs only an authenticated identity read. SQL preflight refuses a changed original connection,
  // secret or config before any credential is lent. Its native proof is never serialized through Temporal.
  async function qualified(input: PaymentInput, processorName: string, existing?: PaymentExecutionBinding) {
    if (!configured() || deps.paymentProcessor !== processorName) return null;
    const processor = deps.processors.get(processorName);
    if (!processor || processor.manifest.processor !== processorName || !processor.identifyExecution
      || processor.manifest.nativeIdempotency !== true) return null;
    let authority: PaymentConnectionAuthority;
    try {
      authority = await preflightPaymentExecution(deps.database, ctx(input), {
        paymentId: input.paymentId, billingOrganizationId: deps.billingOrganizationId!,
        connectionId: deps.billingConnectionId!, processor: processorName,
        adapterVersion: processor.manifest.version, apiOrigin: options.paymentApiOrigin!,
      });
    } catch { return null; }
    if (existing && existing.authoritySha256 !== authority.authoritySha256) return null;
    const callFor = (binding: PaymentGatewayBinding): ProcessorCallContext => ({
      signal: AbortSignal.timeout(60_000),
      withCredential: (use) => deps.secrets.withSecret({
        organizationId: authority.billingOrganizationId, secretId: authority.credentialSecretId,
        purpose: SECRET_PURPOSE_PAYMENT_PROCESSOR,
      }, use),
      async request(this: ProcessorCallContext, request) {
        return options.requestThroughGateway!(binding, request, this.signal);
      },
    });
    const base = { organizationId: input.organizationId, paymentId: input.paymentId, authority };
    const proof = await identifyPaymentExecution(processor, callFor({ ...base, phase: 'identity' }), authority.authoritySha256);
    if (!proof || (existing && existing.identitySha256 !== proof.sha256)) return null;
    let binding: PaymentExecutionBinding;
    try {
      const attestation = await options.attestIdentity!({ ...input, authority, proof });
      if (!(attestation.expiresAt instanceof Date) || attestation.expiresAt.getTime() <= Date.now()) return null;
      binding = await bindPaymentExecution(deps.database, ctx(input), { paymentId: input.paymentId, token: attestation.token });
      if (options.paymentWebhookEndpointId) await qualifyPaymentWebhookExecution(deps.database,
        createServiceContext(authority.billingOrganizationId), {
          originOrganizationId: input.organizationId, paymentId: input.paymentId, bindingId: binding.id,
          endpointId: options.paymentWebhookEndpointId,
        });
    } catch { return null; }
    if ((existing && existing.id !== binding.id) || binding.authoritySha256 !== authority.authoritySha256
      || binding.identitySha256 !== proof.sha256) return null;
    return {
      processor, binding, authority,
      call: (phase: Exclude<PaymentGatewayBinding['phase'], 'identity'>, ids: { attemptId?: string; customerToken?: string } = {}) =>
        callFor({ ...base, phase, executionBinding: binding, identityProof: proof, ...ids }),
    };
  }

  return {
    /** One admitted attempt. Configuration refusal is pending work, never a made-up not-sent receipt. */
    async chargePaymentStep(input: PaymentInput & { runId: string }): Promise<ChargeStep> {
      const value = paymentInputSchema.extend({ runId: z.uuid() }).parse(input);
      // Recovery has a separate read-only Activity. Billing-off never reaches a new customer or attempt.
      if (deps.billingEnabled !== true) return { step: 'reconcile' };
      if (!configured()) return wait;
      const context = ctx(value);
      const execution = await getPaymentExecution(deps.database, context, { paymentId: value.paymentId });
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(execution.status))
        return { step: execution.status as 'succeeded' | 'failed' | 'cancelled' | 'unknown' };
      if (execution.status === 'sending' || execution.status === 'reconciling') return { step: 'reconcile' };
      if (execution.preflightCode) return wait;
      const native = await qualified(value, execution.processor);
      if (!native) return wait;
      let customer;
      try {
        customer = await beginPaymentCustomerRegistration(deps.database, context, {
          paymentId: value.paymentId, bindingId: native.binding.id,
        });
      } catch { return wait; }
      if (customer.action === 'unknown') return wait;
      if (customer.action === 'send') {
        if (!customer.token) return wait;
        const customerRef = await runBoundCustomerRegistration(native.processor,
          native.call('customer', { customerToken: customer.token }), {
            idempotencyKey: customer.requestKey,
            billingEmail: execution.account.billingEmail, billingName: execution.account.billingName,
          }, native.authority.authoritySha256);
        // Settlement is intentionally allowed after credential revocation: preserve the original answer.
        await finishPaymentCustomerRegistration(deps.database, context, {
          paymentId: value.paymentId, bindingId: native.binding.id, token: customer.token, customerRef,
        });
        if (!customerRef) return wait;
      }
      const begun = await beginPaymentAttempt(deps.database, context, {
        paymentId: value.paymentId, runId: value.runId, executionBindingId: native.binding.id,
      });
      if (begun.kind === 'stop') return { step: begun.status as 'succeeded' | 'failed' | 'cancelled' | 'unknown' };
      if (begun.kind === 'reconcile') return { step: 'reconcile' };
      const result = await runBoundCharge(native.processor, native.call('charge', { attemptId: begun.attemptId }), begun.charge,
        native.authority.authoritySha256);
      return finishPaymentAttempt(deps.database, context, { attemptId: begun.attemptId, result }, options.agents);
    },
    /** Prior attempts may be inspected while billing is off, but only their exact original identity is used. */
    async reconcilePaymentStep(input: PaymentInput): Promise<PaymentReconcileStep> {
      const value = paymentInputSchema.parse(input);
      const context = ctx(value);
      const execution = await getPaymentExecution(deps.database, context, { paymentId: value.paymentId });
      if (execution.status === 'cancelled') return 'failed';
      if (['succeeded', 'failed', 'unknown'].includes(execution.status))
        return execution.status as 'succeeded' | 'failed' | 'unknown';
      const existing = await readPaymentExecutionBinding(deps.database, context, { paymentId: value.paymentId });
      // Legacy unbound attempts and disabled/replaced connections remain unconfirmed, not relabeled unknown.
      if (!existing) return 'retry';
      const native = await qualified(value, execution.processor, existing);
      if (!native) return 'retry';
      const prepared = await beginPaymentReconcile(deps.database, context, {
        paymentId: value.paymentId, code: 'PROCESSOR_ERROR',
      });
      if (!prepared) return outcomeAfterNoReconcile(deps, value);
      if (prepared.executionBindingId !== existing.id) return 'retry';
      const result = await runBoundPaymentLookup(native.processor, native.call('lookup', { attemptId: prepared.attemptId }), prepared.idempotencyKey,
        native.authority.authoritySha256);
      return finishPaymentReconcile(deps.database, context, {
        attemptId: prepared.attemptId, result, lookup: native.processor.manifest.lookup,
      }, options.agents);
    },
  };
}
export type PaymentConnectorActivities = ReturnType<typeof createPaymentConnectorActivities>;
