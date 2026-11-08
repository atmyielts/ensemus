// What the connector worker does with a stored delivery (ADR-027 D4). This is where a signing secret is
// opened and where a stranger's bytes are first read, in that order, and only with the signature checked
// does anything go on to read them.
import {
  AppError,
  applyVerifiedDelivery,
  emit,
  loadStoredDelivery,
  proposeExternalActionInTx,
  rejectDelivery,
  type DeliveryVerdict,
  type ProposeExternalActionInput,
  type StoredDelivery,
  type WebhookEffectHandlers,
  type WebhookVerifier,
} from '@ensemus/application';
import { MalformedWebhook, type ConnectorContext } from '@ensemus/connectors';
import { PAYMENT_CONNECTOR_PREFIX } from '@ensemus/connectors/payment';
import { verifyWebhookSignature } from '@ensemus/connectors/runtime';
import { recordPaymentEventInTx } from '@ensemus/application/saas/payment-events';
import { connections, webhookEndpoints, withTenantTx, workUnits, type Tx } from '@ensemus/database';
import { createServiceContext } from '@ensemus/database/service';
import { SECRET_PURPOSE_WEBHOOK_SIGNING } from '@ensemus/domain/connector';
import { AGGREGATE_CONNECTION, CONNECTOR_SYNC_REQUESTED } from '@ensemus/domain/integration-events';
import type { WebhookRejectCode } from '@ensemus/domain/webhook';
import { and, eq } from 'drizzle-orm';
import type { ConnectorActivityDeps } from './connector-deps';
import type { WebhookDeliveryInput, WebhookDeliveryOutcome } from './schemas';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@ensemus/domain/approval';
import { webhookRequestDigest } from '@ensemus/domain/webhook';
import { paymentWebhookFactCanonical } from '@ensemus/saas/payment';

const paymentWebhookProofs = new WeakSet<object>();
export type VerifiedPaymentWebhook = Readonly<{
  organizationId: string; deliveryId: string; rowVersion: string; endpointId: string; connectionId: string;
  signingSecretId: string; processor: string; adapterVersion: string; providerEventId: string;
  bodySha256: string; requestDigest: string; headersSha256: string; factSha256: string;
  accountNamespaceSha256: string | null; executionIdentitySha256: string | null; verifiedAtEpochMs: number;
}>;
export const isVerifiedPaymentWebhook = (value: unknown): value is VerifiedPaymentWebhook =>
  typeof value === 'object' && value !== null && paymentWebhookProofs.has(value);

type ProposeInTx = (
  tx: Tx,
  context: Parameters<typeof proposeExternalActionInTx>[1],
  input: ProposeExternalActionInput,
) => Promise<unknown>;

/** Reached only by a connector that has no business here, so asking is itself the bug. */
const refused = async (): Promise<never> => {
  throw new Error('Reading a webhook takes no credential and no network');
};

/** The broker says the same whether it is missing, revoked or tampered, and so does this. */
const isSecretUnavailable = (error: unknown) => (error as Error).name === 'SecretUnavailable';

/**
 * The real effects. Both are only requests: a proposal waits for a person, and its approver is whoever
 * answers for the work, because a webhook is nobody and cannot choose who it asks. The sender is the
 * connection's own address, read here and frozen in the intent (ADR-027 D1), never a body's claim.
 */
export function createWebhookEffectHandlers(
  propose: ProposeInTx = proposeExternalActionInTx,
  payment: ConnectorActivityDeps['paymentWebhook'] = undefined,
): WebhookEffectHandlers {
  return {
    async proposeAction(tx, context, effect) {
      const [work] = await tx
        .select({ owner: workUnits.ownerMembershipId })
        .from(workUnits)
        .where(
          and(
            eq(workUnits.organizationId, context.organizationId),
            eq(workUnits.id, effect.workUnitId),
          ),
        );
      if (!work) throw new AppError('NOT_FOUND');
      const [connection] = await tx
        .select({ config: connections.config })
        .from(connections)
        .where(
          and(
            eq(connections.organizationId, context.organizationId),
            eq(connections.id, effect.connectionId),
          ),
        );
      if (!connection) throw new AppError('NOT_FOUND');
      const { fromAddress, fromName } = connection.config as {
        fromAddress?: unknown;
        fromName?: unknown;
      };
      if (typeof fromAddress !== 'string') throw new AppError('INVALID_INPUT');
      await propose(tx, context, {
        workUnitId: effect.workUnitId,
        connectionId: effect.connectionId,
        toolName: effect.toolName,
        toolVersion: effect.toolVersion,
        payload: {
          ...(effect.payload as object),
          from: {
            address: fromAddress,
            ...(typeof fromName === 'string' ? { name: fromName } : {}),
          },
        },
        approverMembershipId: work.owner,
      });
    },
    async requestSync(tx, context, connectionId) {
      await emit(tx, context, {
        eventType: CONNECTOR_SYNC_REQUESTED,
        aggregateType: AGGREGATE_CONNECTION,
        aggregateId: connectionId,
        aggregateVersion: 1,
        classification: 'internal',
        payload: {},
      });
    },
    async recordPaymentEvent(tx, context, effect, source) {
      if (
        !payment?.billingOrganizationId ||
        !payment.billingConnectionId ||
        !payment.processor ||
        !source ||
        context.actorType !== 'service' ||
        payment.billingOrganizationId.toLowerCase() !== context.organizationId ||
        payment.billingConnectionId.toLowerCase() !== source.connectionId ||
        !/^[a-z][a-z0-9_]{1,55}$/.test(payment.processor) ||
        effect.event.processor !== payment.processor ||
        effect.event.providerEventId !== source.providerEventId
      )
        throw new AppError('NOT_FOUND');
      // Current rows are locked inside the same delivery/inbox transaction. NOWAIT refuses an inverse
      // endpoint/connection revocation order rather than holding a connection across any I/O.
      const [endpoint] = await tx
        .select({ connectionId: webhookEndpoints.connectionId, state: webhookEndpoints.state })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.organizationId, context.organizationId),
            eq(webhookEndpoints.id, source.endpointId),
          ),
        )
        .for('share', { noWait: true });
      const [connection] = await tx
        .select({
          id: connections.id,
          state: connections.state,
          connectorType: connections.connectorType,
        })
        .from(connections)
        .where(
          and(
            eq(connections.organizationId, context.organizationId),
            eq(connections.id, source.connectionId),
          ),
        )
        .for('share', { noWait: true });
      if (
        !endpoint ||
        endpoint.state !== 'active' ||
        endpoint.connectionId !== source.connectionId ||
        !connection ||
        connection.state !== 'active' ||
        connection.connectorType !== PAYMENT_CONNECTOR_PREFIX + payment.processor
      )
        throw new AppError('NOT_FOUND');
      await recordPaymentEventInTx(tx, context, effect.event, {
        billingOrganizationId: context.organizationId,
        billingConnectionId: connection.id,
        processor: payment.processor,
        connectionId: endpoint.connectionId,
        deliveryId: source.deliveryId,
        endpointId: source.endpointId,
        observedExecutionIdentitySha256: effect.executionIdentitySha256 ?? null,
        observedAccountNamespaceSha256: effect.accountNamespaceSha256 ?? null,
        verificationToken: source.paymentVerificationToken ?? null,
      });
    },
  };
}

/** Leases each secret that could be valid for this delivery, for just long enough to check it. */
async function checkSignature(
  deps: ConnectorActivityDeps,
  organizationId: string,
  delivery: StoredDelivery,
  nowMs: number,
) {
  const check = async (secretId: string) => {
    try {
      return await deps.secrets.withSecret(
        { organizationId, secretId, purpose: SECRET_PURPOSE_WEBHOOK_SIGNING },
        async (secret) =>
          verifyWebhookSignature(secret, {
            scheme: delivery.scheme,
            body: delivery.body,
            headers: delivery.headers,
            nowMs,
            toleranceSeconds: delivery.toleranceSeconds,
          }),
      );
    } catch (error) {
      // Not the sender's fault, and trying again will not open it. Anything else, such as the
      // database being down, goes on up to be retried.
      if (isSecretUnavailable(error))
        return { ok: false as const, code: 'SECRET_UNAVAILABLE' as const };
      throw error;
    }
  };

  const current = await check(delivery.signingSecretId);
  if (current.ok) return { ...current, signingSecretId: delivery.signingSecretId };
  if (!delivery.previousSigningSecretId) return current;
  // Only these can be a matter of which secret. A signature that is absent is absent under both.
  if (current.code !== 'BAD_SIGNATURE' && current.code !== 'SECRET_UNAVAILABLE') return current;
  const previous = await check(delivery.previousSigningSecretId);
  if (previous.ok) return { ...previous, signingSecretId: delivery.previousSigningSecretId };
  if (previous.code === 'TIMESTAMP_OUTSIDE_WINDOW') return previous;
  return current;
}

/** Checks a signature, and only then reads the body. */
export function createWebhookVerifier(deps: ConnectorActivityDeps): WebhookVerifier {
  return {
    async verify(organizationId, delivery, nowMs): Promise<DeliveryVerdict> {
      const verdict = await checkSignature(deps, organizationId, delivery, nowMs);
      if (!verdict.ok) return { ok: false, code: verdict.code };

      const connector = deps.registry.get(delivery.connectorType);
      if (!connector?.webhooks) return { ok: false, code: 'ENDPOINT_NOT_ACTIVE' };
      const context = createServiceContext(organizationId);
      const [row] = await withTenantTx(deps.database, context, (tx) =>
        tx
          .select({ config: connections.config })
          .from(connections)
          .where(
            and(
              eq(connections.organizationId, organizationId),
              eq(connections.id, delivery.connectionId),
            ),
          ),
      );
      try {
        const connectorContext: ConnectorContext = {
          organizationId,
          connectionId: delivery.connectionId,
          config: connector.parseConfig(row?.config ?? {}),
          credentials: { withCredential: refused },
          network:
            connector.manifest.capabilities.network === 'none'
              ? { openRelay: refused }
              : deps.network,
          signal: new AbortController().signal,
        };
        const effects = connector.webhooks.interpret(connectorContext, {
          providerEventId: verdict.providerEventId,
          signedAtSeconds: verdict.signedAtSeconds,
          body: delivery.body,
        });
        let paymentVerificationToken: string | undefined;
        const payment = effects.find((effect) => effect.kind === 'payment_event');
        if (payment?.kind === 'payment_event') {
          if (effects.length !== 1 || !delivery.connectorType.startsWith(PAYMENT_CONNECTOR_PREFIX)
            || payment.event.processor !== delivery.connectorType.slice(PAYMENT_CONNECTOR_PREFIX.length)
            || payment.event.providerEventId !== verdict.providerEventId) throw new MalformedWebhook();
          if (!deps.attestPaymentWebhook || !delivery.rowVersion || !delivery.bodySha256 || !delivery.requestDigest)
            throw new AppError('PREREQUISITES_INCOMPLETE');
          const bodySha256 = createHash('sha256').update(delivery.body).digest('hex');
          if (bodySha256 !== delivery.bodySha256 || webhookRequestDigest(delivery.body,delivery.headers) !== delivery.requestDigest)
            throw new MalformedWebhook();
          const observed = { accountNamespaceSha256: payment.accountNamespaceSha256 ?? null,
            executionIdentitySha256: payment.executionIdentitySha256 ?? null };
          if ((observed.accountNamespaceSha256 === null) !== (observed.executionIdentitySha256 === null)
            || [observed.accountNamespaceSha256,observed.executionIdentitySha256].some((value) => value !== null && !/^[0-9a-f]{64}$/.test(value)))
            throw new MalformedWebhook();
          const canonical = paymentWebhookFactCanonical(payment.event,observed);
          if (Buffer.byteLength(canonical,'utf8')>4096) throw new MalformedWebhook();
          const proof = Object.freeze({ organizationId, deliveryId:delivery.id,rowVersion:delivery.rowVersion,endpointId:delivery.endpointId,
            connectionId:delivery.connectionId,signingSecretId:verdict.signingSecretId,processor:payment.event.processor,adapterVersion:connector.manifest.version,
            providerEventId:verdict.providerEventId,bodySha256,requestDigest:delivery.requestDigest,
            headersSha256:createHash('sha256').update(canonicalJson(delivery.headers)).digest('hex'),
            factSha256:createHash('sha256').update(canonical,'utf8').digest('hex'),...observed,verifiedAtEpochMs:Date.now() });
          paymentWebhookProofs.add(proof);
          const attestation = await deps.attestPaymentWebhook(proof);
          if (!/^[0-9a-f]{64}$/.test(attestation.token) || !(attestation.expiresAt instanceof Date)
            || attestation.expiresAt.getTime()<=Date.now()) throw new AppError('PREREQUISITES_INCOMPLETE');
          paymentVerificationToken=attestation.token;
        }
        return { ok: true, providerEventId: verdict.providerEventId, effects,
          ...(paymentVerificationToken ? {paymentVerificationToken} : {}),
        };
      } catch (error) {
        if (error instanceof MalformedWebhook) return { ok: false, code: 'MALFORMED_PAYLOAD' };
        throw error;
      }
    },
  };
}

/** On the connector queue, because this opens a signing secret and reads what a stranger sent. */
export function createWebhookActivities(
  deps: ConnectorActivityDeps,
  handlers: WebhookEffectHandlers = createWebhookEffectHandlers(undefined, deps.paymentWebhook),
) {
  const verifier = createWebhookVerifier(deps);
  return {
    /** Verifies, dedupes and applies one delivery. A retry finds it finished and does nothing. */
    async processWebhookDelivery(input: WebhookDeliveryInput): Promise<WebhookDeliveryOutcome> {
      const context = createServiceContext(input.organizationId);
      const delivery = await loadStoredDelivery(deps.database, context, {
        deliveryId: input.deliveryId,
      });
      if (!delivery) return 'skipped';
      const verdict = await verifier.verify(input.organizationId, delivery, delivery.receivedAtMs);
      if (!verdict.ok) {
        const code: WebhookRejectCode = verdict.code;
        return rejectDelivery(deps.database, context, { deliveryId: delivery.id, code });
      }
      return applyVerifiedDelivery(
        deps.database,
        context,
        {
          deliveryId: delivery.id,
          providerEventId: verdict.providerEventId,
          effects: verdict.effects,
          ...(verdict.paymentVerificationToken ? { paymentVerificationToken: verdict.paymentVerificationToken } : {}),
        },
        handlers,
      );
    },
  };
}
export type WebhookActivities = ReturnType<typeof createWebhookActivities>;
