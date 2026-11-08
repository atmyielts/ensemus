// Opt-in, exclusive fresh PG project only: this invokes the REAL conservative restore-begin barrier
// and intentionally leaves it pending. No ack, fake ready proof, worker cancellation or provider claim.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openAppDatabase, paymentWebhookEvents, withTenantTx } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { pgCode } from '@ensemus/application';
import { bindPaymentExecution } from '@ensemus/application/saas/payment-execution';
import { runBoundCharge } from '@ensemus/connectors/payment';
import { hashCustomerRef, type PaymentEventFact } from '@ensemus/saas/payment';
import type { VerifiedPaymentWebhook } from '@ensemus/workflows/webhook-activities';
import { nativePaymentFixture } from '../helpers/native-payment';
import { nativePaymentWebhook } from '../helpers/native-payment-webhook';
import { seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';

const enabled = process.env.ENSEMUS_TEST_PAYMENT_RESTORE_EXCLUSIVE === '1';
describe.runIf(enabled)('payment proofs refuse the real pending restore barrier', () => {
  let app: ReturnType<typeof openAppDatabase>, secretsDb: ReturnType<typeof openSecretsDatabase>;
  let auth: pg.Client, migrator: pg.Client;
  beforeAll(async () => {
    // A project guard, never production authority. Root must launch ONLY the owned fresh PG gate,
    // with no native workers/provider jobs, and destroy that project after this one-file suite.
    if (!/^ensemus-payment-restore-[a-z0-9-]+$/.test(process.env.COMPOSE_PROJECT_NAME ?? ''))
      throw new Error('TEST_EXCLUSIVE_PAYMENT_RESTORE_PROJECT_REQUIRED');
    if (!process.env.ENSEMUS_TEST_PG_PORT || process.env.ENSEMUS_TEST_PG_PORT === '55432')
      throw new Error('TEST_DEDICATED_PAYMENT_RESTORE_PORT_REQUIRED');
    app = openAppDatabase(urls.app()); secretsDb = openSecretsDatabase(urls.secrets());
    auth = new pg.Client({ connectionString: urls.auth() });
    migrator = new pg.Client({ connectionString: urls.migrator() });
    await auth.connect(); await migrator.connect(); await seedTaxTreatment();
  });
  afterAll(async () => {
    await auth?.end(); await migrator?.end(); await secretsDb?.close(); await app?.close();
  });
  it('retains an accepted signed receipt while old identity, transport, webhook and token paths refuse', async () => {
    const f = await nativePaymentFixture(app.db, auth, secretsDb);
    try {
      const q = await f.qualify(), customerRef = await f.register();
      if (!customerRef) throw new Error('TEST_EXPECTED_ACTUAL_CUSTOMER');
      const observed: VerifiedPaymentWebhook[] = [];
      const nativeAttester = f.attestWebhook;
      f.attestWebhook = async proof => { observed.push(proof); return nativeAttester(proof); };
      const webhook = nativePaymentWebhook(app.db, f);
      await webhook.qualifyEndpoint(q.binding.id);
      const attempt = await f.beginAttempt();
      if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_NATIVE_ATTEMPT');
      const answer = await runBoundCharge(f.processor, f.call('charge', { attemptId: attempt.attemptId }), attempt.charge, q.authority.authoritySha256);
      if (answer.outcome !== 'succeeded') throw new Error('TEST_EXPECTED_GENERATED_NATIVE_ACK');
      const fact: PaymentEventFact = {
        processor: 'test_scripted', providerEventId: randomUUID(), kind: 'payment_succeeded',
        customerRefHash: hashCustomerRef('test_scripted', customerRef), processorPaymentRef: answer.processorPaymentRef,
        paymentId: f.payment.paymentId, amountMicros: attempt.charge.amountMicros.toString(), currency: attempt.charge.currency,
        occurredAtSeconds: Math.floor(Date.now() / 1000),
      };
      const committed = await webhook.post(fact);
      expect(await webhook.process(committed)).toBe('applied');
      const [receipt] = await withTenantTx(app.db, f.operatorContext, tx => tx.select().from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.sourceDeliveryId, committed.id)));
      if (!receipt) throw new Error('TEST_EXPECTED_ACTUAL_SIGNED_RECEIPT');
      const pending = await webhook.verify(await webhook.post({ ...fact, providerEventId: randomUUID() }));
      const nativeWebhook = observed.at(-1);
      if (!nativeWebhook) throw new Error('TEST_EXPECTED_ACTUAL_NATIVE_VERIFICATION');
      const identityToken = await f.refresh();
      const before = f.server.requests.length;
      // This is an actual privileged closure intent, not proof that a backup/provider was restored.
      // It opens no authority. No post-begin positive case is claimed without the real external-review ack.
      const begun = await migrator.query<{ generation: string }>(
        'select identity.begin_auth_restore($1::uuid,$2::text) as generation',
        [randomUUID(), createHash('sha256').update(randomUUID()).digest('hex')],
      );
      expect(begun.rows[0]?.generation).toMatch(/^[0-9a-f-]{36}$/);
      expect(begun.rows[0]?.generation).not.toBe(q.proof.restoreGeneration);
      await expect(f.refresh()).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN422');
      await expect(f.call('identity').request({ method: 'GET', path: '/identity', headers: {}, timeoutMs: 1000 }))
        .rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN422');
      await expect(f.attest({ organizationId: f.who.owner.organizationId, paymentId: f.payment.paymentId, authority: q.authority, proof: q.proof }))
        .rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN422');
      await expect(bindPaymentExecution(app.db, f.who.service, { paymentId: f.payment.paymentId, token: identityToken.token }))
        .rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN422');
      await expect(f.attestWebhook(nativeWebhook)).rejects.toThrow('PAYMENT_WEBHOOK_VERIFICATION_UNAVAILABLE');
      await expect(webhook.apply(pending)).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN422');
      expect(f.server.requests).toHaveLength(before);
      // Actual migrator maintenance may inspect these fixed content-free receipts while native
      // admission stays closed. This read does not create a ready proof or a financial effect.
      await migrator.query('begin');
      await migrator.query("select set_config('billing.payment_org',$1,true)", [f.operator.organizationId]);
      const retained = await migrator.query('select id,verification_id from billing.payment_webhook_events where organization_id=$1 and id=$2', [f.operator.organizationId, receipt.id]);
      expect(retained.rows).toEqual([{ id: receipt.id, verification_id: receipt.verificationId }]);
      await migrator.query('rollback');
    } finally { await f.close(); }
  });
});
