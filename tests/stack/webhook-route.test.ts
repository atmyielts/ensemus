// CONNECT-02: what POST /api/webhooks/{token} really answers, from the built image behind the real proxy.
// The route file imports server-only, so these answers cannot be reached any other way. It needs a stack
// with ENSEMUS_CONNECTORS_ENABLED=true for the first part, and a stack without it for the second, and
// runs in CI, not on a laptop. Everything it sends is generated here.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebhookEndpoint, disableWebhookEndpoint } from '@ensemus/application';
import { signWebhook } from '@ensemus/connectors/runtime';
import {
  createOrganization,
  openAppDatabase,
  resolveTenantContext,
  webhookEndpoints,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { SECRET_PURPOSE_WEBHOOK_SIGNING } from '@ensemus/domain/connector';
import {
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE,
} from '@ensemus/domain/webhook';
import { storeSecret } from '@ensemus/secrets/seal';
import { eq } from 'drizzle-orm';
import { aClientAddress, BASE } from '../helpers/forms';
import { seedConnection } from '../helpers/integrations';
import { secret, urls } from '../helpers/stack';

const enabled = process.env.ENSEMUS_CONNECTORS_ENABLED === 'true';
const SYNC = '{"type":"connector.sync_requested"}';

const send = (token: string, init: RequestInit = {}, client = aClientAddress()) =>
  fetch(`${BASE}/api/webhooks/${token}`, {
    method: 'POST',
    ...init,
    headers: { 'x-ensemus-test-client': client, ...(init.headers as Record<string, string>) },
  });

/** What a stranger could compare. The date and the replica's name change on their own. */
async function shape(response: Response) {
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== 'date' && name !== 'x-ensemus-served-by')
    .sort();
  return { status: response.status, body: await response.text(), headers };
}

describe.runIf(enabled)('the webhook route, with connectors on', () => {
  let app: ReturnType<typeof openAppDatabase>;
  let auth: pg.Client;
  let context: TenantContext;
  let connectionId: string;

  const makeEndpoint = async () => {
    const plaintext = randomBytes(32).toString('base64url');
    const { secretRef } = await storeSecret(app.db, context, {
      publicKeyPem: secret('sealing_public_key.pem'),
      purpose: SECRET_PURPOSE_WEBHOOK_SIGNING,
      plaintext,
    });
    const created = await createWebhookEndpoint(app.db, context, {
      connectionId,
      signingSecretId: secretRef,
      signatureScheme: 'ensemus_hmac_sha256_v1',
    });
    return { ...created, key: Buffer.from(plaintext) };
  };

  const signedHeaders = (key: Buffer, body: string) => {
    const eventId = randomUUID();
    const timestampSeconds = Math.floor(Date.now() / 1000);
    return {
      'content-type': 'application/json',
      'x-ensemus-signature': signWebhook(key, {
        timestampSeconds,
        eventId,
        body: Buffer.from(body),
      }),
      'x-ensemus-timestamp': String(timestampSeconds),
      'x-ensemus-event-id': eventId,
    };
  };

  beforeAll(async () => {
    app = openAppDatabase(urls.app());
    auth = new pg.Client({ connectionString: urls.auth() });
    await auth.connect();
    const userId = randomUUID();
    await auth.query('insert into identity.users (id, name, email) values ($1, $2, $3)', [
      userId,
      'owner',
      `${userId}@example.invalid`,
    ]);
    const org = await createOrganization(app.db, {
      userId,
      name: 'Webhook route',
      commercialMode: 'byom',
    });
    context = await resolveTenantContext(app.db, userId, org.organizationId);
    connectionId = await seedConnection(app.db, context, {
      connectorType: 'inbound_webhook',
      config: {},
    });
  });

  afterAll(async () => {
    await app?.close();
    await auth?.end();
  });

  it('answers 202 with no body, and takes no session', async () => {
    const { token, key } = await makeEndpoint();
    const response = await send(token, { body: SYNC, headers: signedHeaders(key, SYNC) });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('answers a bad signature exactly as it answers a good one', async () => {
    const { token, key } = await makeEndpoint();
    const good = await shape(await send(token, { body: SYNC, headers: signedHeaders(key, SYNC) }));
    const forged = await shape(
      await send(token, { body: SYNC, headers: signedHeaders(randomBytes(32), SYNC) }),
    );
    expect(forged).toEqual(good);
  });

  it('answers an unknown token and a disabled one the same, to the byte', async () => {
    const { token, endpointId } = await makeEndpoint();
    await disableWebhookEndpoint(app.db, context, { endpointId });
    const disabled = await shape(await send(token, { body: SYNC }));
    const unknown = await shape(await send(randomBytes(32).toString('base64url'), { body: SYNC }));
    expect(disabled.status).toBe(404);
    expect(disabled.body).toBe('');
    expect(unknown).toEqual(disabled);
  });

  it('refuses a body over the endpoint limit, and over the ceiling, with no body', async () => {
    const { token, endpointId, key } = await makeEndpoint();
    await withTenantTx(app.db, context, (tx) =>
      tx
        .update(webhookEndpoints)
        .set({ maxBodyBytes: 2048 })
        .where(eq(webhookEndpoints.id, endpointId)),
    );
    const over = 'x'.repeat(2049);
    const limited = await send(token, { body: over, headers: signedHeaders(key, over) });
    expect(limited.status).toBe(413);
    expect(await limited.text()).toBe('');

    // This one is stopped by the proxy or the route, whichever gets there first. Both say 413.
    const huge = await send(randomBytes(32).toString('base64url'), {
      body: Buffer.alloc(WEBHOOK_MAX_BODY_BYTES + 1),
    });
    expect(huge.status).toBe(413);
  });

  it('holds back a flood of unknown tokens from one address, and nobody else', async () => {
    const client = aClientAddress();
    const statuses: number[] = [];
    // Past the limit on whichever replica answers. The test overlay's proxy sends these all to one.
    for (let i = 0; i < WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE + 5; i += 1) {
      const response = await send(randomBytes(32).toString('base64url'), { body: '{}' }, client);
      await response.arrayBuffer();
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 404)).toHaveLength(
      WEBHOOK_UNKNOWN_CALLER_LIMIT_PER_MINUTE,
    );
    const limited = await send(randomBytes(32).toString('base64url'), { body: '{}' }, client);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.text()).toBe('');

    const someoneElse = await send(randomBytes(32).toString('base64url'), { body: '{}' });
    expect(someoneElse.status).toBe(404);
  });

  it('has no other method, and sends no session cookie back', async () => {
    const { token } = await makeEndpoint();
    const read = await fetch(`${BASE}/api/webhooks/${token}`);
    expect(read.status).toBe(405);
    const posted = await send(token, { body: '{}' });
    expect(posted.headers.getSetCookie()).toEqual([]);
  });
});

describe.runIf(!enabled)('the webhook route, with connectors off', () => {
  it('answers 404 with no body, whatever is sent, and makes no outbound attempt possible', async () => {
    const response = await send(randomBytes(32).toString('base64url'), { body: SYNC });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });
});
