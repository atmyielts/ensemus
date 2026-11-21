import 'server-only';
import { AppError } from '@ensemus/application';
import {
  ingestCheckoutCall,
  readCheckoutAnswer,
  type CheckoutIngressScheme,
} from '@ensemus/application/saas/checkout-ingress';
import { loadSaasConfig, readSecret } from '@ensemus/config';
import { loadCheckoutConfig } from '@ensemus/config/checkout';
import { openAppDatabase } from '@ensemus/database';
import { boundedRpcId, clickFallbackReply, paymeFallbackReply } from '@ensemus/saas/checkout';
import { errorCode } from '@ensemus/telemetry';
import { createWebhookLimiter, readBoundedBody } from '@/lib/webhook-limiter';
import { getRestoreGate, getRuntime } from './runtime';

// Payme and Click call us and wait on the line (ADR-032 D4a). This door stores the bytes exactly as M3's
// does and believes none of them; it holds no key. It then waits, within a bound, for the one answer the
// connector worker stores for that delivery. Every answer it gives by itself reveals no order and no
// internal state: a refused or unknown caller hears the provider's "not authorized" code, and anything
// else unfinished hears the provider's "try again" code. HTTP status is always 200, as both expect.

/** Neither provider sends anything near this, and a small cap keeps a waiting request cheap. */
const MAX_BODY_BYTES = 65_536;
const READ_DEADLINE_MS = 10_000;
const POLL_MS = 100;

const INGRESS_CONNECTIONS = 2;
let ingress: ReturnType<typeof openAppDatabase> | undefined;
const limiter = createWebhookLimiter();

type Provider = 'payme' | 'click';
const SCHEMES: Record<Provider, CheckoutIngressScheme> = {
  payme: 'payme_basic_v1',
  click: 'click_md5_v1',
};

const json = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const addressOf = (request: Request) =>
  (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown').slice(0, 64);

function fallback(
  provider: Provider,
  kind: 'unauthorized' | 'unavailable' | 'invalid',
  rpcId: unknown,
) {
  if (provider === 'payme')
    return json(
      kind === 'invalid'
        ? paymeFallbackReply('parse', boundedRpcId(rpcId))
        : paymeFallbackReply(kind, boundedRpcId(rpcId)),
    );
  return json(clickFallbackReply(kind === 'invalid' ? 'bad_request' : kind));
}

/** Payme's id is echoed only in answers that say nothing about an order. Read without trusting it. */
function rpcIdOf(body: Uint8Array): unknown {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : null;
  } catch {
    return null;
  }
}

function enabled(provider: Provider): boolean {
  try {
    const { config } = getRuntime();
    return (
      config.connectorsEnabled &&
      loadSaasConfig().billingEnabled &&
      loadCheckoutConfig().providers.includes(provider)
    );
  } catch {
    return false;
  }
}

export async function handleCheckoutCall(
  provider: Provider,
  request: Request,
  token: string,
): Promise<Response> {
  const { log } = getRuntime();
  if (!enabled(provider)) return new Response(null, { status: 404 });
  const admission = limiter.admit(addressOf(request), Date.now());
  if (!admission.ok) return fallback(provider, 'unavailable', null);
  let unknown = false;
  let rpcId: unknown = null;
  try {
    const body = await readBoundedBody(request, {
      maxBytes: MAX_BODY_BYTES,
      deadlineMs: READ_DEADLINE_MS,
    });
    if (body.kind !== 'body') return fallback(provider, 'invalid', null);
    if (provider === 'payme') {
      rpcId = rpcIdOf(body.bytes);
      // Payme's own order: a request that is not JSON is answered as a parse error before anything else.
      try {
        JSON.parse(Buffer.from(body.bytes).toString('utf8'));
      } catch {
        return fallback(provider, 'invalid', null);
      }
    }
    ingress ??= openAppDatabase(readSecret('DATABASE_URL_APP'), { max: INGRESS_CONNECTIONS });
    const database = ingress.db;
    let stored;
    try {
      stored = await ingestCheckoutCall(
        database,
        {
          token,
          body: body.bytes,
          headers: Object.fromEntries(request.headers),
          scheme: SCHEMES[provider],
        },
        { assertServing: (context) => getRestoreGate().assertServing(context) },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'RESTORE_PENDING')
        return fallback(provider, 'unavailable', rpcId);
      throw error;
    }
    if (stored.outcome === 'not_found') {
      unknown = true;
      return fallback(provider, 'unauthorized', rpcId);
    }
    if (stored.outcome !== 'accepted' || !stored.deliveryId)
      return fallback(provider, 'unavailable', rpcId);

    const deadline = Date.now() + loadCheckoutConfig().replyWaitMs;
    for (;;) {
      const answer = await readCheckoutAnswer(database, { token, deliveryId: stored.deliveryId });
      if (answer.kind === 'reply') return json(answer.body);
      if (answer.kind === 'rejected') {
        if (answer.code === 'BAD_SIGNATURE' || answer.code === 'SIGNATURE_MISSING')
          return fallback(provider, 'unauthorized', rpcId);
        // Verified but not a call we can read: Payme hears "invalid request", Click "bad request".
        if (answer.code === 'MALFORMED_PAYLOAD')
          return provider === 'payme'
            ? json(paymeFallbackReply('invalid_request', boundedRpcId(rpcId)))
            : json(clickFallbackReply('bad_request'));
        return fallback(provider, 'unavailable', rpcId);
      }
      if (Date.now() >= deadline) return fallback(provider, 'unavailable', rpcId);
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  } catch (error) {
    log.warn('checkout.ingress_failed', { errorCode: errorCode(error) });
    return fallback(provider, 'unavailable', rpcId);
  } finally {
    admission.release(unknown);
  }
}
