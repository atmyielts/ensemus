// Actual app/secrets/agent logins, real native SQL admission and generated local TLS only.
// No hosted provider, payment delivery or production merchant/security-review acceptance is claimed.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingAccounts, connections, openAppDatabase, paymentAttempts, paymentEvents, paymentWebhookEvents, webhookDeliveries, withTenantTx } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { createServiceContext } from '@ensemus/database/service';
import { bindPaymentExecution, beginPaymentCustomerRegistration, finishPaymentCustomerRegistration, preflightPaymentExecution, qualifyPaymentWebhookExecution, readPaymentExecutionBinding } from '@ensemus/application/saas/payment-execution';
import { beginPaymentAttempt, finishPaymentAttempt, readPaymentOutcome } from '@ensemus/application/saas/payments';
import { routePaymentEvent, applyPaymentFactInTx } from '@ensemus/application/saas/payment-events';
import { ingestWebhookDelivery, pgCode } from '@ensemus/application';
import { createConnectorRegistry, signWebhook } from '@ensemus/connectors/runtime';
import { runBoundCharge, runBoundCustomerRegistration } from '@ensemus/connectors/payment';
import { hashCustomerRef, type PaymentEventFact } from '@ensemus/saas/payment';
import { createWebhookActivities } from '@ensemus/workflows/webhook-activities';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { and, eq, sql } from 'drizzle-orm';
import { nativePaymentFixture } from '../helpers/native-payment';
import { seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';

const agents = createStandingAgentHaltPort();
describe('original payment identity and customer namespace under real roles', () => {
  const app = openAppDatabase(urls.app()), secretsDb = openSecretsDatabase(urls.secrets());
  const auth = new pg.Client({ connectionString: urls.auth() });
  beforeAll(async () => { await auth.connect(); await seedTaxTreatment(); });
  afterAll(async () => { await auth.end(); await secretsDb.close(); await app.close(); });
  const fixture = () => nativePaymentFixture(app.db, auth, secretsDb);
  it('binds an actual authenticated native response, consumes each token once and reuses only the exact original', async () => {
    const f = await fixture();
    try {
      const first = await f.qualify();
      await expect(bindPaymentExecution(app.db, f.who.service, { paymentId: f.payment.paymentId, token: first.token.token })).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      const next = await f.qualify();
      expect(next.binding.id).toBe(first.binding.id);
      expect(next.binding.identitySha256).toBe(first.binding.identitySha256);
      expect(f.server.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(await withTenantTx(app.db, f.who.service, (tx) => tx.select().from(paymentAttempts))).toEqual([]);
    } finally { await f.close(); }
  });
  it('does not expose a token-minting function or private receipts to app, actual agent SET ROLE app, or forged selectors', async () => {
    const f = await fixture();
    const agent = new pg.Client({ connectionString: urls.agent() });
    try {
      const q = await f.qualify();
      await expect(withTenantTx(app.db, f.who.service, (tx) => tx.execute(sql`select * from billing.payment_identity_attestations`))).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      await agent.connect(); await agent.query('begin'); await agent.query('set local role ensemus_app');
      await agent.query("select set_config('app.organization_id',$1,true),set_config('app.actor_type','service',true),set_config('billing.payment_org',$1,true)",[f.who.owner.organizationId]);
      await expect(agent.query('select * from billing.payment_execution_bindings')).rejects.toMatchObject({ code: '42501' });
      await agent.query('rollback'); await agent.query('begin'); await agent.query('set local role ensemus_app');
      await expect(agent.query('select * from billing.attest_payment_identity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [f.who.owner.organizationId, f.payment.paymentId, f.operator.organizationId, f.connection.id,
        'test_scripted','1.0.0',q.authority.apiOrigin,q.authority.authoritySha256,q.proof.sha256,q.proof.accountNamespaceSha256,q.proof.readReceiptSha256])).rejects.toMatchObject({ code: '42501' });
      await agent.query('rollback');
    } finally { await agent.end(); await f.close(); }
  });
  it('refuses a foreign tenant/token and a legacy unqualified attempt without making a customer or charge', async () => {
    const f = await fixture();
    try {
      const token = await f.refresh();
      await expect(bindPaymentExecution(app.db, createServiceContext(f.operator.organizationId), { paymentId: f.payment.paymentId, token: token.token })).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      await expect(beginPaymentAttempt(app.db, f.who.service, { paymentId: f.payment.paymentId, runId: randomUUID() })).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
      expect(f.server.requests.map((request) => request.method)).toEqual(['GET']);
    } finally { await f.close(); }
  });
  it('rejects an invented verified source and a serialized route proof before any financial effect', async () => {
    const f = await fixture();
    try {
      const q = await f.qualify();
      const event: PaymentEventFact = { processor: 'test_scripted', providerEventId: randomUUID(), kind: 'payment_succeeded', customerRefHash: 'a'.repeat(64),
        processorPaymentRef: 'generated-payment', paymentId:f.payment.paymentId, amountMicros:f.who.invoice.totalMicros.toString(), currency:f.who.invoice.currency, occurredAtSeconds:Math.floor(Date.now()/1000) };
      await expect(withTenantTx(app.db,f.who.service,(tx) => tx.insert(paymentEvents).values({ organizationId:f.who.owner.organizationId,
        processor:event.processor,providerEventId:event.providerEventId,kind:event.kind,paymentId:f.payment.paymentId,invoiceId:f.who.invoice.id,
        amountMicros:f.who.invoice.totalMicros,currency:event.currency,providerOccurredAt:new Date(event.occurredAtSeconds*1000),
        accountNamespaceSha256:q.binding.accountNamespaceSha256,executionBindingId:q.binding.id,executionBindingSha256:q.binding.bindingSha256,
        sourceExecutionBindingSha256:q.binding.bindingSha256,sourceWebhookOrganizationId:f.operator.organizationId,sourceWebhookEventId:randomUUID(),
      })))).rejects.toSatisfy((error:unknown) => pgCode(error)==='EN850');
      const invented = {organizationId:f.who.owner.organizationId,paymentId:f.payment.paymentId,processor:event.processor,providerEventId:event.providerEventId,customerRefHash:event.customerRefHash};
      expect(await withTenantTx(app.db,f.who.service,(tx) => applyPaymentFactInTx(tx,f.who.service,event,agents,
        invented as Parameters<typeof applyPaymentFactInTx>[4]))).toBe('no_matching_payment');
      expect(await withTenantTx(app.db,f.who.service,(tx) => tx.select({id:paymentEvents.id}).from(paymentEvents))).toEqual([]);
      expect(f.server.requests.every((request) => request.method==='GET')).toBe(true);
    } finally { await f.close(); }
  });

  it('uses actual customer and single charge transports and preserves the original success on replay', async () => {
    const f = await fixture();
    try {
      const q = await f.qualify(); expect(await f.register()).not.toBeNull();
      const begun = await f.beginAttempt(); if (begun.kind !== 'attempt') throw new Error('TEST_EXPECTED_ACTUAL_ATTEMPT');
      const call = () => f.call('charge', { attemptId: begun.attemptId });
      const result = await runBoundCharge(f.processor, call(), begun.charge, q.authority.authoritySha256);
      expect(result.outcome).toBe('succeeded');
      expect(await finishPaymentAttempt(app.db, f.who.service, { attemptId: begun.attemptId, result }, agents)).toEqual({ step: 'succeeded' });
      const before = f.server.requests.length;
      expect((await runBoundCharge(f.processor, call(), begun.charge, q.authority.authoritySha256)).outcome).toBe('indeterminate');
      expect(f.server.requests).toHaveLength(before);
      expect(await readPaymentOutcome(app.db, f.who.service, { paymentId: f.payment.paymentId })).toBe('succeeded');
    } finally { await f.close(); }
  });
  it('retains a single uncertain customer claim and never resends after loss of its response', async () => {
    const f = await fixture();
    try {
      const q = await f.qualify();
      const begun = await beginPaymentCustomerRegistration(app.db, f.who.service, { paymentId: f.payment.paymentId, bindingId: q.binding.id });
      if (begun.action !== 'send' || !begun.token) throw new Error('TEST_EXPECTED_CUSTOMER_CLAIM');
      // This simulates a crash before transport, not a fabricated successful provider receipt.
      expect(await beginPaymentCustomerRegistration(app.db, f.who.service, { paymentId: f.payment.paymentId, bindingId: q.binding.id })).toMatchObject({ action: 'unknown', token: begun.token });
      await finishPaymentCustomerRegistration(app.db, f.who.service, { paymentId: f.payment.paymentId, bindingId: q.binding.id, token: begun.token, customerRef: null });
      expect(await beginPaymentCustomerRegistration(app.db, f.who.service, { paymentId: f.payment.paymentId, bindingId: q.binding.id })).toMatchObject({ action: 'unknown' });
      expect(f.server.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally { await f.close(); }
  });
  it('records a known native customer ACK after credential revocation but refuses a new attempt', async () => {
    const f = await fixture();
    try {
      const q = await f.qualify();
      const begun = await beginPaymentCustomerRegistration(app.db, f.who.service, { paymentId: f.payment.paymentId, bindingId: q.binding.id });
      if (begun.action !== 'send' || !begun.token) throw new Error('TEST_EXPECTED_CUSTOMER_CLAIM');
      const customerRef = await runBoundCustomerRegistration(f.processor, f.call('customer',{ customerToken: begun.token }), {
        idempotencyKey: begun.requestKey, billingEmail: 'billing@example.invalid', billingName: 'Generated',
      }, q.authority.authoritySha256);
      expect(customerRef).not.toBeNull();
      await f.broker.revoke(f.operator.organizationId, f.credential.secretRef);
      await finishPaymentCustomerRegistration(app.db, f.who.service, { paymentId: f.payment.paymentId, bindingId: q.binding.id, token: begun.token, customerRef });
      expect(await readPaymentExecutionBinding(app.db, f.who.service, { paymentId: f.payment.paymentId })).toMatchObject({ customerState: 'confirmed' });
      await expect(f.beginAttempt()).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect(f.server.requests.filter((request) => request.path === '/customer')).toHaveLength(1);
      expect(f.server.requests.filter((request) => request.path === '/charge')).toHaveLength(0);
    } finally { await f.close(); }
  });
  it('same connection UUID with a newer version cannot replace the original execution authority', async () => {
    const f = await fixture();
    try {
      const q = await f.qualify();
      await withTenantTx(app.db, f.operator, (tx) => tx.update(connections).set({ version: f.connection.version+1 }).where(eq(connections.id,f.connection.id)));
      const before = f.server.requests.length;
      await expect(preflightPaymentExecution(app.db, f.who.service, { paymentId: f.payment.paymentId, billingOrganizationId: f.operator.organizationId,
        connectionId: f.connection.id, processor: 'test_scripted', adapterVersion: '1.0.0', apiOrigin: q.authority.apiOrigin })).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect(f.server.requests).toHaveLength(before);
    } finally { await f.close(); }
  });
  it('a real different observed merchant under the same credential cannot refresh the original binding', async () => {
    const f = await fixture();
    try {
      await f.qualify(); f.changeMerchant();
      await expect(f.refresh()).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect(f.server.requests.every((request) => request.method === 'GET')).toBe(true);
    } finally { await f.close(); }
  });
  it('qualified signed callbacks use original merchant/customer routing, while a signed foreign merchant remains unmatched', async () => {
    const f = await fixture();
    try {
      const q = await f.qualify(); const customerRef = await f.register(); if (!customerRef) throw new Error('TEST_EXPECTED_NATIVE_CUSTOMER');
      await qualifyPaymentWebhookExecution(app.db, f.operatorContext, { originOrganizationId: f.who.owner.organizationId, paymentId: f.payment.paymentId, bindingId: q.binding.id, endpointId: f.endpoint.endpointId });
      const pending = await f.beginAttempt(); if (pending.kind !== 'attempt') throw new Error('TEST_EXPECTED_ACTUAL_ATTEMPT');
      // A genuine transport occurred; its synchronous result is intentionally not settled here.
      const answer = await runBoundCharge(f.processor, f.call('charge',{attemptId: pending.attemptId}), pending.charge, q.authority.authoritySha256);
      if (answer.outcome !== 'succeeded') throw new Error('TEST_EXPECTED_NATIVE_WIRE_ACK');
      const webhook = createWebhookActivities({ database: app.db, registry: createConnectorRegistry([f.connector]), secrets: f.broker,
        attestPaymentWebhook: f.attestWebhook,
        network: { openRelay: async () => { throw new Error('TEST_WEBHOOK_HAS_NO_NETWORK'); } },
        paymentWebhook: { billingOrganizationId: f.operator.organizationId, billingConnectionId: f.connection.id, processor: 'test_scripted' } });
      const deliver = async (foreign: boolean) => {
        const event: PaymentEventFact = { processor: 'test_scripted', providerEventId: randomUUID(), kind: 'payment_succeeded', customerRefHash: hashCustomerRef('test_scripted',customerRef),
          processorPaymentRef: answer.processorPaymentRef, paymentId: f.payment.paymentId, amountMicros: pending.charge.amountMicros.toString(), currency: pending.charge.currency, occurredAtSeconds: Math.floor(Date.now()/1000) };
        const observed = foreign ? { ...f.currentIdentity, merchantAccountSha256: '0'.repeat(64) } : f.currentIdentity;
        const body = Buffer.from(JSON.stringify({ event, identity: observed })), timestampSeconds = Math.floor(Date.now()/1000);
        expect(await ingestWebhookDelivery(app.db, { token: f.endpoint.token, body, headers: { 'content-type':'application/json', 'x-ensemus-event-id':event.providerEventId,
          'x-ensemus-timestamp':String(timestampSeconds),'x-ensemus-signature':signWebhook(Buffer.from(f.signingKey),{timestampSeconds,eventId:event.providerEventId,body}) } })).toBe('accepted');
        const [delivery] = await withTenantTx(app.db,f.operatorContext,(tx) => tx.select({id:webhookDeliveries.id}).from(webhookDeliveries).where(and(eq(webhookDeliveries.endpointId,f.endpoint.endpointId),eq(webhookDeliveries.state,'received'))));
        if (!delivery) throw new Error('TEST_EXPECTED_REAL_STORED_DELIVERY');
        expect(await webhook.processWebhookDelivery({organizationId:f.operator.organizationId,deliveryId:delivery.id})).toBe('applied');
        const [receipt] = await withTenantTx(app.db,f.operatorContext,(tx) => tx.select().from(paymentWebhookEvents).where(eq(paymentWebhookEvents.providerEventId,event.providerEventId)));
        if (!receipt) throw new Error('TEST_EXPECTED_REAL_M8_RECEIPT');
        return {receipt,delivery};
      };
      const wrong = await deliver(true);
      expect(wrong.receipt.executionIdentitySha256).toBeNull();
      expect(await routePaymentEvent(app.db,f.operatorContext,{paymentWebhookEventId:wrong.receipt.id},{billingOrganizationId:f.operator.organizationId},agents)).toBe('unmatched');
      // Receipt-only capture preserves a genuine original signed ACK after unrelated API replacement.
      // It does not qualify that replacement for a lookup or a new charge.
      await withTenantTx(app.db,f.operator,(tx) => tx.update(connections).set({version:f.connection.version+1}).where(eq(connections.id,f.connection.id)));
      const networkBeforeCallback = f.server.requests.length;
      const valid = await deliver(false);
      expect(valid.receipt.executionIdentitySha256).toBe(q.binding.identitySha256);
      expect(valid.receipt.sourceConnectionVersion).toBe(BigInt(f.connection.version));
      expect(f.server.requests).toHaveLength(networkBeforeCallback);
      expect(await routePaymentEvent(app.db,f.operatorContext,{paymentWebhookEventId:valid.receipt.id},{billingOrganizationId:f.operator.organizationId},agents)).toBe('applied');
      expect(await routePaymentEvent(app.db,f.operatorContext,{paymentWebhookEventId:valid.receipt.id},{billingOrganizationId:f.operator.organizationId},agents)).toBe('already_done');
      expect(await readPaymentOutcome(app.db,f.who.service,{paymentId:f.payment.paymentId})).toBe('succeeded');
      expect(await webhook.processWebhookDelivery({organizationId:f.operator.organizationId,deliveryId:valid.delivery.id})).toBe('skipped');
      const [account] = await withTenantTx(app.db,f.who.owner,(tx) => tx.select({identity:billingAccounts.processorAccountNamespaceSha256}).from(billingAccounts));
      expect(account?.identity).toBe(q.binding.accountNamespaceSha256);
    } finally { await f.close(); }
  });
});
