// Webhooks, from the door to the inbox (CONNECT-02, ADR-027 D4). The web tier stores what arrived and can
// check nothing, because it can never open a signing secret. The connector worker checks it later, and
// until then nothing reads the body or believes a word of it.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  auditEvents,
  connections,
  inboxEvents,
  webhookDeliveries,
  webhookEndpoints,
  withWebhookEndpointTx,
  type AppDatabase,
  type TenantContext,
  type Tx,
} from '@ensemus/database';
import { AGGREGATE_WEBHOOK_DELIVERY, WEBHOOK_RECEIVED } from '@ensemus/domain/integration-events';
import { can } from '@ensemus/domain/policy';
import { assertInteractivePrivilege, withPrivilegeTx as withTenantTx } from './product/privileged';
import {
  hashWebhookToken,
  isWebhookTokenShape,
  SIGNATURE_SCHEMES,
  storedWebhookHeaders,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_METADATA_RETENTION_DAYS,
  WEBHOOK_TOKEN_BYTES,
  WEBHOOK_UNPROCESSED_RETENTION_HOURS,
  webhookInboxConsumer,
  webhookInboxEventId,
  webhookRequestDigest,
  type SignatureScheme,
  type WebhookDeliveryState,
  type WebhookEffect,
  type WebhookIngressOutcome,
  type WebhookRejectCode,
} from '@ensemus/domain/webhook';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import { AppError } from './errors';
import { emit } from './events';
import type { StoredDelivery, WebhookEffectHandlers } from './integration-ports';
import { auditAction } from './work';

const HOUR_MS = 60 * 60 * 1000;
/** Upkeep works through this many at a time, so one run cannot hold a tenant up. */
const PURGE_BATCH = 500;

export type IngestWebhookInput = {
  /** The opaque part of the URL. Only its hash is looked up. */
  token: string;
  body: Uint8Array;
  /** Request headers, lower case. Only those on the scheme's allowlist are kept. */
  headers: Readonly<Record<string, string>>;
};

/** Rolls the insert back. A delivery that was not let in leaves no row, so a retry can get in. */
class NotAdmitted extends Error {}

/**
 * What the web tier does, with no session and no secret: finds the endpoint by the token's hash, admits
 * the bytes against its limits, stores them with an outbox event, and answers. It believes nothing it
 * was sent. An exact repeat stores nothing and answers the same. Uses withWebhookEndpointTx.
 */
export async function ingestWebhookDelivery(
  database: AppDatabase,
  input: IngestWebhookInput,
  options: {
    /** Refuses while this tenant is being restored. */
    assertServing?: (context: TenantContext) => Promise<void>;
  } = {},
): Promise<WebhookIngressOutcome> {
  if (input.body.byteLength > WEBHOOK_MAX_BODY_BYTES) return 'too_large';
  if (!isWebhookTokenShape(input.token)) return 'not_found';
  const size = input.body.byteLength;
  try {
    const outcome = await withWebhookEndpointTx(
      database,
      hashWebhookToken(input.token),
      async (tx, { endpoint, context }): Promise<WebhookIngressOutcome> => {
        // A revoked connection's address answers as if it never existed, whatever its endpoint says.
        const [connection] = await tx
          .select({ state: connections.state })
          .from(connections)
          .where(
            and(
              eq(connections.organizationId, endpoint.organizationId),
              eq(connections.id, endpoint.connectionId),
            ),
          );
        if (connection?.state !== 'active') return 'not_found';
        await options.assertServing?.(context);
        if (size > endpoint.maxBodyBytes) return 'too_large';

        const headers = storedWebhookHeaders(endpoint.signatureScheme, input.headers);
        const deliveryId = randomUUID();
        const inserted = await tx
          .insert(webhookDeliveries)
          .values({
            organizationId: endpoint.organizationId,
            id: deliveryId,
            endpointId: endpoint.id,
            requestDigest: webhookRequestDigest(input.body, headers),
            body: Buffer.from(input.body),
            bodySha256: createHash('sha256').update(input.body).digest('hex'),
            sizeBytes: size,
            headers,
          })
          .onConflictDoNothing()
          .returning({ id: webhookDeliveries.id });
        // The same bytes again: nothing new to do, and the sender hears what it heard the first time.
        if (inserted.length === 0) return 'accepted';

        const admission = await tx.execute(
          sql`select integrations.admit_webhook_delivery(${endpoint.id}::uuid, ${size}::integer) as admitted`,
        );
        if (admission.rows[0]?.admitted !== true) throw new NotAdmitted();

        await emit(tx, context, {
          eventType: WEBHOOK_RECEIVED,
          aggregateType: AGGREGATE_WEBHOOK_DELIVERY,
          aggregateId: deliveryId,
          aggregateVersion: 1,
          classification: 'internal',
          payload: { endpoint_id: endpoint.id, size_bytes: size },
        });
        return 'accepted';
      },
    );
    return outcome ?? 'not_found';
  } catch (error) {
    if (error instanceof NotAdmitted) return 'rate_limited';
    throw error;
  }
}

function assertManages(context: TenantContext) {
  if (!can(context.role, 'connection.manage')) throw new AppError('FORBIDDEN');
}

/** The verifying side is the worker's. Nothing a person does should read a stranger's bytes. */
function assertService(context: TenantContext) {
  if (context.actorType !== 'service') throw new AppError('FORBIDDEN');
}

const sqlStateOf = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  const code = cause?.code ?? (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

export type CreatedWebhookEndpoint = {
  endpointId: string;
  /** Goes in the URL. Shown once, and only its hash is kept. */
  token: string;
};

/** Needs connection.manage. Generates the token here, and takes a secret the caller already sealed. */
export async function createWebhookEndpoint(
  database: AppDatabase,
  context: TenantContext,
  input: { connectionId: string; signingSecretId: string; signatureScheme: SignatureScheme },
): Promise<CreatedWebhookEndpoint> {
  assertManages(context);
  if (!SIGNATURE_SCHEMES.includes(input.signatureScheme)) throw new AppError('INVALID_INPUT');
  const token = randomBytes(WEBHOOK_TOKEN_BYTES).toString('base64url');
  const endpointId = randomUUID();
  try {
    await withTenantTx(database, context, async (tx) => {
      await assertInteractivePrivilege(tx, context, 'connection.manage');
      const [connection] = await tx
        .select({ state: connections.state })
        .from(connections)
        .where(
          and(
            eq(connections.organizationId, context.organizationId),
            eq(connections.id, input.connectionId),
          ),
        );
      if (!connection) throw new AppError('NOT_FOUND');
      if (connection.state !== 'active') throw new AppError('CONNECTION_NOT_ACTIVE');
      await tx.insert(webhookEndpoints).values({
        organizationId: context.organizationId,
        id: endpointId,
        connectionId: input.connectionId,
        tokenHash: hashWebhookToken(token),
        signingSecretId: input.signingSecretId,
        signatureScheme: input.signatureScheme,
        createdByMembershipId: context.membershipId,
      });
      await auditAction(tx, context, 'webhook_endpoint.created', `webhook_endpoint:${endpointId}`);
    });
  } catch (error) {
    // The foreign key is on (tenant, secret), so another tenant's secret looks like no secret at all.
    if (sqlStateOf(error) === '23503') throw new AppError('NOT_FOUND');
    throw error;
  }
  return { endpointId, token };
}

/** Needs connection.manage. Takes effect at once: the address answers as if it never existed. */
export async function disableWebhookEndpoint(
  database: AppDatabase,
  context: TenantContext,
  input: { endpointId: string },
): Promise<void> {
  assertManages(context);
  await withTenantTx(database, context, async (tx) => {
    await assertInteractivePrivilege(tx, context, 'connection.manage');
    const updated = await tx
      .update(webhookEndpoints)
      .set({ state: 'disabled', updatedAt: new Date() })
      .where(
        and(
          eq(webhookEndpoints.organizationId, context.organizationId),
          eq(webhookEndpoints.id, input.endpointId),
        ),
      )
      .returning({ id: webhookEndpoints.id });
    if (updated.length === 0) throw new AppError('NOT_FOUND');
    await auditAction(
      tx,
      context,
      'webhook_endpoint.disabled',
      `webhook_endpoint:${input.endpointId}`,
    );
  });
}

export type DeliveryStep = Extract<WebhookDeliveryState, 'applied' | 'duplicate' | 'rejected'>;

/** A delivery's row and what it hangs off, locked so two runs cannot both finish it. */
async function lockDelivery(tx: Tx, context: TenantContext, deliveryId: string) {
  const [row] = await tx
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      state: webhookDeliveries.state,
      sizeBytes: webhookDeliveries.sizeBytes,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.organizationId, context.organizationId),
        eq(webhookDeliveries.id, deliveryId),
      ),
    )
    .for('update');
  return row;
}

type LockedDelivery = NonNullable<Awaited<ReturnType<typeof lockDelivery>>>;

/** One row an hour per endpoint and code, however many arrive, so a flood cannot fill the log. */
async function auditRejection(
  tx: Tx,
  context: TenantContext,
  endpointId: string,
  code: WebhookRejectCode,
  now: Date,
) {
  await tx
    .insert(auditEvents)
    .values({
      organizationId: context.organizationId,
      actorType: 'service',
      action: 'webhook.delivery_rejected',
      targetRef: `webhook_endpoint:${endpointId}`,
      decision: 'deny',
      safeReason: code,
      dedupeKey: `webhook:${endpointId}:${code}:${now.toISOString().slice(0, 13)}`,
    })
    .onConflictDoNothing();
}

/** Every ending goes through here: the bytes are dropped and the endpoint's backlog gets them back. */
async function finishDelivery(
  tx: Tx,
  context: TenantContext,
  delivery: LockedDelivery,
  ending: {
    state: DeliveryStep;
    rejectCode?: WebhookRejectCode;
    providerEventId?: string;
    now?: Date;
  },
): Promise<DeliveryStep> {
  const now = ending.now ?? new Date();
  await tx
    .update(webhookDeliveries)
    .set({
      body: null,
      headers: null,
      state: ending.state,
      rejectCode: ending.rejectCode ?? null,
      providerEventId: ending.providerEventId ?? null,
      processedAt: now,
    })
    .where(
      and(
        eq(webhookDeliveries.organizationId, context.organizationId),
        eq(webhookDeliveries.id, delivery.id),
      ),
    );
  await tx.execute(
    sql`select integrations.release_webhook_bytes(${delivery.endpointId}::uuid, ${delivery.sizeBytes}::integer)`,
  );
  if (ending.rejectCode) {
    await auditRejection(tx, context, delivery.endpointId, ending.rejectCode, now);
  }
  return ending.state;
}

const stepOf = (state: string): DeliveryStep =>
  state === 'applied' || state === 'duplicate' ? state : 'rejected';

/** Whether the endpoint and its connection still take callbacks. Either can change after storing. */
async function isListening(tx: Tx, context: TenantContext, endpointId: string) {
  const [row] = await tx
    .select({ endpoint: webhookEndpoints.state, connection: connections.state })
    .from(webhookEndpoints)
    .innerJoin(
      connections,
      and(
        eq(connections.organizationId, webhookEndpoints.organizationId),
        eq(connections.id, webhookEndpoints.connectionId),
      ),
    )
    .where(
      and(
        eq(webhookEndpoints.organizationId, context.organizationId),
        eq(webhookEndpoints.id, endpointId),
      ),
    );
  return row?.endpoint === 'active' && row.connection === 'active';
}

/**
 * The delivery as the worker needs it, and when it arrived. The window is measured from then, by
 * PostgreSQL's clock: a sender who got a 202 will not send again, so a worker that was down for an hour
 * must not turn its genuine callbacks into "too old" (ADR-027: a worker outage loses nothing).
 */
export type LoadedDelivery = StoredDelivery & { receivedAtMs: number };

/**
 * Reads a delivery for the worker. Null if it is not waiting any more, so a retry does nothing. An
 * endpoint switched off since storing ends it here, with no secret opened.
 */
export async function loadStoredDelivery(
  database: AppDatabase,
  context: TenantContext,
  input: { deliveryId: string },
): Promise<LoadedDelivery | null> {
  assertService(context);
  return withTenantTx(database, context, async (tx) => {
    const [row] = await tx
      .select({
        delivery: webhookDeliveries,
        endpoint: webhookEndpoints,
        connectorType: connections.connectorType,
        rowVersion: sql<string>`webhook_deliveries.xmin::text`,
      })
      .from(webhookDeliveries)
      .innerJoin(
        webhookEndpoints,
        and(
          eq(webhookEndpoints.organizationId, webhookDeliveries.organizationId),
          eq(webhookEndpoints.id, webhookDeliveries.endpointId),
        ),
      )
      .innerJoin(
        connections,
        and(
          eq(connections.organizationId, webhookEndpoints.organizationId),
          eq(connections.id, webhookEndpoints.connectionId),
        ),
      )
      .where(
        and(
          eq(webhookDeliveries.organizationId, context.organizationId),
          eq(webhookDeliveries.id, input.deliveryId),
        ),
      );
    if (!row || row.delivery.state !== 'received') return null;
    const { delivery, endpoint } = row;
    const body = delivery.body;
    if (!body) return null;

    if (!(await isListening(tx, context, endpoint.id))) {
      const locked = await lockDelivery(tx, context, delivery.id);
      if (locked?.state === 'received') {
        await finishDelivery(tx, context, locked, {
          state: 'rejected',
          rejectCode: 'ENDPOINT_NOT_ACTIVE',
        });
      }
      return null;
    }

    const previousValid =
      endpoint.previousSigningSecretId !== null &&
      endpoint.previousSecretValidUntil !== null &&
      endpoint.previousSecretValidUntil.getTime() > delivery.receivedAt.getTime();
    return {
      id: delivery.id,
      endpointId: endpoint.id,
      connectionId: endpoint.connectionId,
      connectorType: row.connectorType,
      scheme: endpoint.signatureScheme as SignatureScheme,
      body,
      headers: (delivery.headers ?? {}) as Record<string, string>,
      sizeBytes: delivery.sizeBytes,
      toleranceSeconds: endpoint.timestampToleranceSeconds,
      signingSecretId: endpoint.signingSecretId,
      previousSigningSecretId: previousValid ? endpoint.previousSigningSecretId : null,
      rowVersion: row.rowVersion,
      requestDigest: delivery.requestDigest,
      bodySha256: delivery.bodySha256,
      receivedAtMs: delivery.receivedAt.getTime(),
    };
  });
}

/**
 * Records a rejection and drops the bytes. A valid old payload ends here, with its body gone and no
 * effect, and one audit row an hour per code.
 */
export async function rejectDelivery(
  database: AppDatabase,
  context: TenantContext,
  input: { deliveryId: string; code: WebhookRejectCode },
): Promise<DeliveryStep> {
  assertService(context);
  return withTenantTx(database, context, async (tx) => {
    const delivery = await lockDelivery(tx, context, input.deliveryId);
    if (!delivery) throw new AppError('NOT_FOUND');
    if (delivery.state !== 'received') return stepOf(delivery.state);
    return finishDelivery(tx, context, delivery, { state: 'rejected', rejectCode: input.code });
  });
}

/** An effect the rules would not take, as opposed to the database being down, which is worth a retry. */
const isRefusal = (error: unknown) => {
  if (error instanceof AppError) return true;
  const state = sqlStateOf(error);
  // Class 23 is an integrity rule, and EN is ours (migration 0013). Neither gets better by trying again.
  return state !== undefined && (state.startsWith('23') || state.startsWith('EN'));
};

class EffectRefused extends Error {}

/**
 * The signature passed. In one transaction: writes platform.inbox_events first, and if that row already
 * exists marks this `duplicate` with no effect. Otherwise applies the effects and marks it `applied`. The
 * bytes go either way. An effect the rules refuse rolls all of it back and rejects the delivery, so the
 * sender's event ID is not used up by something that did nothing, and there is no retry loop.
 */
export async function applyVerifiedDelivery(
  database: AppDatabase,
  context: TenantContext,
  input: {
    deliveryId: string;
    providerEventId: string;
    effects: readonly WebhookEffect[];
    paymentVerificationToken?: string;
  },
  handlers: WebhookEffectHandlers,
): Promise<DeliveryStep> {
  assertService(context);
  try {
    return await withTenantTx(database, context, async (tx) => {
      const delivery = await lockDelivery(tx, context, input.deliveryId);
      if (!delivery) throw new AppError('NOT_FOUND');
      if (delivery.state !== 'received') return stepOf(delivery.state);
      if (!(await isListening(tx, context, delivery.endpointId))) {
        return finishDelivery(tx, context, delivery, {
          state: 'rejected',
          rejectCode: 'ENDPOINT_NOT_ACTIVE',
        });
      }

      const inbox = (save: Tx) =>
        save
          .insert(inboxEvents)
          .values({
            organizationId: context.organizationId,
            consumerId: webhookInboxConsumer(delivery.endpointId),
            eventId: webhookInboxEventId(delivery.endpointId, input.providerEventId),
          })
          .onConflictDoNothing()
          .returning({ eventId: inboxEvents.eventId });
      const payment = input.effects.some((effect) => effect.kind === 'payment_event');
      if (
        payment &&
        (input.effects.length !== 1 ||
          !input.paymentVerificationToken ||
          !/^[0-9a-f]{64}$/.test(input.paymentVerificationToken))
      )
        throw new AppError('PREREQUISITES_INCOMPLETE');
      // Only the real payment inbox INSERT sees this opaque native token. A savepoint restores the
      // selector after any failure; success restores it before other effects. It is not an authority GUC.
      const first = payment
        ? await tx.transaction(async (save) => {
            const previous = await save.execute<{ value: string | null }>(
              sql`select current_setting('billing.payment_webhook_token',true) as value`,
            );
            await save.execute(
              sql`select set_config('billing.payment_webhook_token',${input.paymentVerificationToken!},true)`,
            );
            const inserted = await inbox(save);
            await save.execute(
              sql`select set_config('billing.payment_webhook_token',${previous.rows[0]?.value ?? ''},true)`,
            );
            return inserted;
          })
        : await inbox(tx);
      if (first.length === 0) {
        return finishDelivery(tx, context, delivery, {
          state: 'duplicate',
          providerEventId: input.providerEventId,
        });
      }

      const [endpoint] = await tx
        .select({ connectionId: webhookEndpoints.connectionId })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.organizationId, context.organizationId),
            eq(webhookEndpoints.id, delivery.endpointId),
          ),
        );
      if (!endpoint) throw new EffectRefused();
      try {
        for (const effect of input.effects) {
          if (effect.kind === 'action_proposed') await handlers.proposeAction(tx, context, effect);
          else if (effect.kind === 'sync_requested')
            await handlers.requestSync(tx, context, endpoint.connectionId);
          else if (effect.kind === 'payment_event') {
            if (!effect.event || effect.event.providerEventId !== input.providerEventId)
              throw new AppError('INVALID_INPUT');
            await handlers.recordPaymentEvent(
              tx,
              context,
              effect,
              Object.freeze({
                deliveryId: delivery.id,
                endpointId: delivery.endpointId,
                connectionId: endpoint.connectionId,
                providerEventId: input.providerEventId,
                ...(input.paymentVerificationToken
                  ? { paymentVerificationToken: input.paymentVerificationToken }
                  : {}),
              }),
            );
          } else throw new AppError('INVALID_INPUT');
        }
      } catch (error) {
        if (isRefusal(error)) throw new EffectRefused();
        throw error;
      }
      return finishDelivery(tx, context, delivery, {
        state: 'applied',
        providerEventId: input.providerEventId,
      });
    });
  } catch (error) {
    if (!(error instanceof EffectRefused)) throw error;
    return rejectDelivery(database, context, {
      deliveryId: input.deliveryId,
      code: 'MALFORMED_PAYLOAD',
    });
  }
}

/**
 * Upkeep, run from the tenant's periodic Activity. Drops bodies nobody processed within the retention
 * period, gives their bytes back, and removes old rows. A row is kept for a week after that because it
 * is what recognizes an exact repeat at the door. Returns how many it dealt with.
 */
export async function purgeExpiredWebhookDeliveries(
  database: AppDatabase,
  context: TenantContext,
  now: Date,
): Promise<number> {
  const unprocessedBefore = new Date(now.getTime() - WEBHOOK_UNPROCESSED_RETENTION_HOURS * HOUR_MS);
  const rowsBefore = new Date(now.getTime() - WEBHOOK_METADATA_RETENTION_DAYS * 24 * HOUR_MS);
  return withTenantTx(database, context, async (tx) => {
    // Skipping what is locked, because that one is being finished by its own run right now.
    const expired = await tx
      .select({
        id: webhookDeliveries.id,
        endpointId: webhookDeliveries.endpointId,
        state: webhookDeliveries.state,
        sizeBytes: webhookDeliveries.sizeBytes,
      })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.organizationId, context.organizationId),
          eq(webhookDeliveries.state, 'received'),
          lt(webhookDeliveries.receivedAt, unprocessedBefore),
        ),
      )
      .limit(PURGE_BATCH)
      .for('update', { skipLocked: true });
    for (const delivery of expired) {
      await finishDelivery(tx, context, delivery, {
        state: 'rejected',
        rejectCode: 'NOT_PROCESSED_IN_TIME',
        now,
      });
    }
    const removed = await tx
      .delete(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.organizationId, context.organizationId),
          ne(webhookDeliveries.state, 'received'),
          lt(webhookDeliveries.receivedAt, rowsBefore),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return expired.length + removed.length;
  });
}
