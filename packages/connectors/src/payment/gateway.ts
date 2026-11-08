import { createHash } from 'node:crypto';
import type { ConnectorNetwork } from '../index';
import { exchangeHttpOverRelay } from '../runtime/provider-http';
import type {
  PaymentGatewayBinding,
  PaymentTransportAdmission,
  ProcessorCallContext,
} from '@ensemus/saas/payment';
import { isVerifiedPaymentExecutionIdentity } from './runtime';

const receipts = new WeakSet<object>();
export type PaymentTransportReceipt = Readonly<{
  origin: string;
  authoritySha256: string;
  restoreGeneration: string;
  organizationId: string;
  paymentId: string;
  attemptId: string | null;
  executionBindingId: string | null;
  lookupOperationId: string | null;
  phase: PaymentGatewayBinding['phase'];
  responseSha256: string;
  status: number;
}>;
export const isPaymentTransportReceipt = (value: unknown): value is PaymentTransportReceipt =>
  typeof value === 'object' && value !== null && receipts.has(value);

/** A real single-request TLS exchange, not an echoed claimed fingerprint or an arbitrary URL callback. */
export function createPaymentHttpGateway(deps: {
  network: ConnectorNetwork;
  apiOrigin: string;
  processor: string;
  adapterVersion: string;
  /** The real SQL authority/admission adapter. It must commit before transport and cannot be omitted. */
  assertAuthority(binding: PaymentGatewayBinding): Promise<PaymentTransportAdmission>;
  /** Local synthetic TLS fixtures only. Production composition never supplies a custom CA. */
  testCa?: Buffer;
}) {
  const origin = new URL(deps.apiOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== deps.apiOrigin ||
    origin.username ||
    origin.password ||
    (origin.port && origin.port !== '443') ||
    typeof deps.assertAuthority !== 'function'
  )
    throw new Error('PAYMENT_GATEWAY_UNAVAILABLE');
  return async (
    binding: PaymentGatewayBinding,
    input: Parameters<ProcessorCallContext['request']>[0],
    signal: AbortSignal,
  ): ReturnType<ProcessorCallContext['request']> => {
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 60_000 ||
      (input.maxResponseBytes !== undefined &&
        (!Number.isSafeInteger(input.maxResponseBytes) ||
          input.maxResponseBytes < 1 ||
          input.maxResponseBytes > 262144)) ||
      typeof input.path !== 'string' ||
      input.path.length > 8192 ||
      !/^\/(?!\/)[^\\#]*$/.test(input.path) ||
      /[^\x21-\x7e]/.test(input.path) ||
      (input.body !== undefined &&
        (!(input.body instanceof Uint8Array) || input.body.byteLength > 1048576))
    )
      throw new Error('PAYMENT_GATEWAY_REQUEST_INVALID');
    // Capture before the first await. A retained mutable authority/request must not stamp a native
    // response with a new restore generation or turn an admitted GET into a later POST.
    const authority = Object.freeze({ ...binding.authority });
    const admitted = Object.freeze({
      ...binding,
      authority,
      ...(binding.executionBinding
        ? { executionBinding: Object.freeze({ ...binding.executionBinding }) }
        : {}),
    });
    const request = {
      method: input.method,
      path: input.path,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes ?? 262144,
      headers: Object.freeze({ ...input.headers }),
      ...(input.body === undefined ? {} : { body: Buffer.from(input.body) }),
    };
    if (
      signal.aborted ||
      authority.apiOrigin !== deps.apiOrigin ||
      authority.processor !== deps.processor ||
      authority.adapterVersion !== deps.adapterVersion ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        authority.restoreGeneration,
      ) ||
      !/^[0-9a-f]{64}$/.test(authority.authoritySha256)
    )
      throw new Error('PAYMENT_GATEWAY_AUTHORITY_CHANGED');
    const readOnly = ['identity', 'lookup', 'customer_lookup'].includes(admitted.phase);
    if (request.method !== (readOnly ? 'GET' : 'POST') || (readOnly && request.body !== undefined))
      throw new Error('PAYMENT_GATEWAY_OPERATION_REFUSED');
    if (admitted.phase !== 'identity') {
      const proof = admitted.identityProof;
      if (
        !isVerifiedPaymentExecutionIdentity(proof) ||
        !admitted.executionBinding ||
        proof.authoritySha256 !== authority.authoritySha256 ||
        proof.restoreGeneration !== authority.restoreGeneration ||
        proof.sha256 !== admitted.executionBinding.identitySha256 ||
        proof.accountNamespaceSha256 !== admitted.executionBinding.accountNamespaceSha256 ||
        proof.apiOrigin !== deps.apiOrigin ||
        !proof.identity.apiOrigins.includes(deps.apiOrigin) ||
        Date.now() - proof.verifiedAtEpochMs < 0 ||
        Date.now() - proof.verifiedAtEpochMs > 60000
      )
        throw new Error('PAYMENT_NATIVE_IDENTITY_REQUIRED');
    }
    const admission = await deps.assertAuthority(admitted);
    if (
      !admission ||
      admission.restoreGeneration !== authority.restoreGeneration ||
      (admitted.phase === 'lookup' &&
        (!admitted.attemptId ||
          !admitted.executionBinding ||
          typeof admission.lookupOperationId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            admission.lookupOperationId,
          ))) ||
      (admitted.phase !== 'lookup' && admission.lookupOperationId !== null)
    )
      throw new Error('PAYMENT_TRANSPORT_UNCONFIRMED');
    const lookupOperationId = admission.lookupOperationId;
    const response = await exchangeHttpOverRelay(
      deps.network,
      origin.hostname,
      {
        method: request.method,
        path: request.path,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        timeoutMs: request.timeoutMs,
        maxResponseBytes: Math.min(request.maxResponseBytes ?? 262144, 262144),
        signal,
      },
      deps.testCa,
    );
    const receipt = Object.freeze({
      origin: deps.apiOrigin,
      authoritySha256: authority.authoritySha256,
      restoreGeneration: authority.restoreGeneration,
      organizationId: admitted.organizationId,
      paymentId: admitted.paymentId,
      attemptId: admitted.attemptId ?? null,
      executionBindingId: admitted.executionBinding?.id ?? null,
      lookupOperationId,
      phase: admitted.phase,
      responseSha256: createHash('sha256').update(response.body).digest('hex'),
      status: response.status,
    });
    receipts.add(receipt);
    return { status: response.status, body: response.body, transportReceipt: receipt };
  };
}
