// Generated local TLS + actual app/secrets admission; no shipped provider is selected here.
import { randomUUID } from 'node:crypto';
import {
  memberships,
  openAppDatabase,
  payments,
  paymentAttempts,
  resolveTenantContext,
  withTenantTx,
  type TenantContext,
} from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { createServiceContext } from '@ensemus/database/service';
import {
  beginPaymentAttempt,
  beginPaymentReconcile,
  failUnsentPayment,
  finishPaymentAttempt,
  finishPaymentReconcile,
  inspectInterruptedPayment,
  listInvoicePayments,
  readPaymentOutcome,
  requestInvoicePayment,
  requestInvoicePaymentOnce,
  resolveUnknownPayment,
} from '@ensemus/application/saas/payments';
import { getInvoice } from '@ensemus/application/saas/invoices';
import { runBoundCharge, runBoundPaymentLookup } from '@ensemus/connectors/payment';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativePaymentFixture } from '../helpers/native-payment';
import { seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { paymentFixture, paymentTenant, paymentAgents } from './saas-payment-fixture';

describe('payment attempts preserve uncertain native transport under actual roles', () => {
  const database = openAppDatabase(urls.app()),
    secretsDb = openSecretsDatabase(urls.secrets()),
    auth = new pg.Client({ connectionString: urls.auth() });
  let other: TenantContext;
  beforeAll(async () => {
    await auth.connect();
    await seedTaxTreatment();
    other = await paymentTenant(database.db, auth);
  });
  afterAll(async () => {
    await auth.end();
    await secretsDb.close();
    await database.close();
  });
  const fixture = (options: Parameters<typeof nativePaymentFixture>[3] = {}) =>
    nativePaymentFixture(database.db, auth, secretsDb, options);
  async function prepared(options: Parameters<typeof nativePaymentFixture>[3] = {}) {
    const f = await fixture(options);
    try {
      const q = await f.qualify();
      await f.register();
      return { f, q };
    } catch (error) {
      await f.close();
      throw error;
    }
  }
  it('denies member, service and cross-tenant payment operations before transport', async () => {
    const f = await fixture();
    try {
      await withTenantTx(database.db, f.who.owner, (tx) =>
        tx.insert(memberships).values({
          organizationId: f.who.owner.organizationId,
          userId: other.userId,
          role: 'member',
        }),
      );
      const member = await resolveTenantContext(
        database.db,
        other.userId,
        f.who.owner.organizationId,
      );
      for (const context of [member, other, f.who.service])
        await expect(
          requestInvoicePayment(database.db, context, {
            invoiceId: f.who.invoice.id,
            processor: 'test_scripted',
          }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        beginPaymentAttempt(database.db, f.who.owner, {
          paymentId: f.payment.paymentId,
          runId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        listInvoicePayments(database.db, member, { invoiceId: f.who.invoice.id }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(f.server.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('serializes concurrent bound claims and preserves a request replay after a real wire ACK', async () => {
    const requestKey = randomUUID(),
      { f, q } = await prepared({ requestKey });
    try {
      const input = { invoiceId: f.who.invoice.id, processor: 'test_scripted', requestKey };
      expect(
        await Promise.all([
          requestInvoicePaymentOnce(database.db, f.who.owner, input),
          requestInvoicePaymentOnce(database.db, f.who.owner, input),
        ]),
      ).toEqual(
        Array(2).fill({ kind: 'replayed', paymentId: f.payment.paymentId, status: 'ready' }),
      );
      const claims = await Promise.all([f.beginAttempt(), f.beginAttempt()]);
      expect(claims.filter((row) => row.kind === 'attempt')).toHaveLength(1);
      expect(claims.filter((row) => row.kind === 'reconcile')).toHaveLength(1);
      const attempt = claims.find((row) => row.kind === 'attempt');
      if (!attempt || attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_BOUND_ATTEMPT');
      const result = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: attempt.attemptId }),
        attempt.charge,
        q.authority.authoritySha256,
      );
      expect(result.outcome).toBe('succeeded');
      expect(
        await finishPaymentAttempt(
          database.db,
          f.who.service,
          { attemptId: attempt.attemptId, result },
          paymentAgents,
        ),
      ).toEqual({ step: 'succeeded' });
      expect((await getInvoice(database.db, f.who.owner, f.who.invoice.id)).status).toBe('paid');
      expect(await requestInvoicePaymentOnce(database.db, f.who.owner, input)).toEqual({
        kind: 'replayed',
        paymentId: f.payment.paymentId,
        status: 'ready',
      });
      expect(
        await requestInvoicePaymentOnce(database.db, f.who.owner, {
          ...input,
          invoiceId: randomUUID(),
        }),
      ).toEqual({ kind: 'conflict' });
      expect(
        await withTenantTx(database.db, f.who.service, (tx) => tx.select().from(paymentAttempts)),
      ).toHaveLength(1);
      expect(f.charges.size).toBe(1);
      expect(f.server.requests.filter((row) => row.path === '/charge')).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('a lost response stays unknown and never resends without real absence or human resolution', async () => {
    const { f, q } = await prepared({ lookup: 'none' });
    try {
      const attempt = await f.beginAttempt();
      if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_BOUND_ATTEMPT');
      f.nextCharge('drop_before_accept');
      const result = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: attempt.attemptId }),
        attempt.charge,
        q.authority.authoritySha256,
      );
      expect(result.outcome).toBe('indeterminate');
      expect(
        await finishPaymentAttempt(database.db, f.who.service, {
          attemptId: attempt.attemptId,
          result,
        }),
      ).toEqual({ step: 'reconcile' });
      await beginPaymentReconcile(database.db, f.who.service, {
        paymentId: f.payment.paymentId,
        code: 'PROCESSOR_ERROR',
      });
      const lookup = await runBoundPaymentLookup(
        f.processor,
        f.call('lookup', { attemptId: attempt.attemptId }),
        attempt.charge.idempotencyKey,
        q.authority.authoritySha256,
      );
      expect(lookup).toEqual({ found: 'cannot_answer' });
      expect(
        await finishPaymentReconcile(database.db, f.who.service, {
          attemptId: attempt.attemptId,
          result: lookup,
          lookup: 'none',
        }),
      ).toBe('unknown');
      expect(await f.beginAttempt()).toMatchObject({ kind: 'stop', status: 'unknown' });
      expect(f.server.requests.filter((row) => row.path === '/charge')).toHaveLength(1);
      expect(f.charges.size).toBe(0);
      expect((await getInvoice(database.db, f.who.owner, f.who.invoice.id)).status).toBe('open');
      await expect(
        withTenantTx(database.db, f.who.service, (tx) =>
          tx
            .update(payments)
            .set({ status: 'succeeded' })
            .where(eq(payments.id, f.payment.paymentId)),
        ),
      ).rejects.toThrow();
      const [row] = await listInvoicePayments(database.db, f.who.owner, {
        invoiceId: f.who.invoice.id,
      });
      const resolution = {
        paymentId: row!.id,
        resolution: 'confirmed_not_charged' as const,
        expectedVersion: row!.version,
      };
      await expect(resolveUnknownPayment(database.db, other, resolution)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      // The generated server actually did not accept the key; this is an explicit human action, not a forged provider receipt.
      await resolveUnknownPayment(database.db, f.who.owner, resolution);
      expect(await readPaymentOutcome(database.db, f.who.service, { paymentId: row!.id })).toBe(
        'failed',
      );
    } finally {
      await f.close();
    }
  });
  it('finds a lost accepted charge by its original key without issuing a second charge', async () => {
    const { f, q } = await prepared();
    try {
      const attempt = await f.beginAttempt();
      if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_BOUND_ATTEMPT');
      f.nextCharge('drop_after_accept');
      const result = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: attempt.attemptId }),
        attempt.charge,
        q.authority.authoritySha256,
      );
      expect(result.outcome).toBe('indeterminate');
      await finishPaymentAttempt(database.db, f.who.service, {
        attemptId: attempt.attemptId,
        result,
      });
      await beginPaymentReconcile(database.db, f.who.service, {
        paymentId: f.payment.paymentId,
        code: 'PROCESSOR_ERROR',
      });
      const lookup = await runBoundPaymentLookup(
        f.processor,
        f.call('lookup', { attemptId: attempt.attemptId }),
        attempt.charge.idempotencyKey,
        q.authority.authoritySha256,
      );
      expect(lookup.found).toBe('succeeded');
      const lookupToken = await f.attestLookupResult(lookup);
      expect(
        await finishPaymentReconcile(
          database.db,
          f.who.service,
          { attemptId: attempt.attemptId, result: lookup, lookup: 'authoritative', nativeLookupToken: lookupToken.token },
          paymentAgents,
        ),
      ).toBe('succeeded');
      expect(await f.beginAttempt()).toMatchObject({ kind: 'stop', status: 'succeeded' });
      expect(f.charges.size).toBe(1);
      expect(f.server.requests.filter((row) => row.path === '/charge')).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('only real not-accepted and authoritative absence responses permit subsequent claims', async () => {
    const { f, q } = await prepared();
    try {
      const first = await f.beginAttempt();
      if (first.kind !== 'attempt') throw new Error('TEST_EXPECTED_BOUND_ATTEMPT');
      f.nextCharge('not_sent');
      const rejected = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: first.attemptId }),
        first.charge,
        q.authority.authoritySha256,
      );
      expect(rejected.outcome).toBe('not_sent');
      expect(
        await finishPaymentAttempt(database.db, f.who.service, {
          attemptId: first.attemptId,
          result: rejected,
        }),
      ).toMatchObject({ step: 'retry' });
      const second = await f.beginAttempt();
      if (second.kind !== 'attempt') throw new Error('TEST_EXPECTED_SECOND_ATTEMPT');
      expect(second.charge.attemptNo).toBe(2);
      f.nextCharge('drop_before_accept');
      const lost = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: second.attemptId }),
        second.charge,
        q.authority.authoritySha256,
      );
      expect(lost.outcome).toBe('indeterminate');
      await finishPaymentAttempt(database.db, f.who.service, {
        attemptId: second.attemptId,
        result: lost,
      });
      await beginPaymentReconcile(database.db, f.who.service, {
        paymentId: f.payment.paymentId,
        code: 'PROCESSOR_ERROR',
      });
      const lookup = await runBoundPaymentLookup(
        f.processor,
        f.call('lookup', { attemptId: second.attemptId }),
        second.charge.idempotencyKey,
        q.authority.authoritySha256,
      );
      expect(lookup).toEqual({ found: 'not_found' });
      const lookupToken = await f.attestLookupResult(lookup);
      expect(
        await finishPaymentReconcile(database.db, f.who.service, {
          attemptId: second.attemptId,
          result: lookup,
          lookup: 'authoritative',
          nativeLookupToken: lookupToken.token,
        }),
      ).toBe('retry');
      expect(await f.beginAttempt()).toMatchObject({ kind: 'attempt', charge: { attemptNo: 3 } });
      expect(f.charges.size).toBe(0);
      expect(f.server.requests.filter((row) => row.path === '/charge')).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it('an unsent failure cannot overwrite a genuinely admitted worker claim', async () => {
    const { f } = await prepared();
    try {
      expect(
        await inspectInterruptedPayment(database.db, f.who.service, {
          paymentId: f.payment.paymentId,
        }),
      ).toBe('nothing_sent');
      expect((await f.beginAttempt()).kind).toBe('attempt');
      await failUnsentPayment(database.db, f.who.service, {
        paymentId: f.payment.paymentId,
        code: 'ATTEMPTS_EXHAUSTED',
      });
      expect(
        await inspectInterruptedPayment(database.db, f.who.service, {
          paymentId: f.payment.paymentId,
        }),
      ).toBe('attempt_open');
      await expect(
        readPaymentOutcome(database.db, createServiceContext(other.organizationId), {
          paymentId: f.payment.paymentId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(f.server.requests.filter((row) => row.path === '/charge')).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('does not promote an unqualified legacy customer reference into transport authority', async () => {
    const legacy = await paymentFixture(database.db, auth);
    const payment = await requestInvoicePayment(database.db, legacy.owner, {
      invoiceId: legacy.invoice.id,
      processor: 'test_scripted',
    });
    await expect(
      beginPaymentAttempt(database.db, legacy.service, {
        paymentId: payment.paymentId,
        runId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PREREQUISITES_INCOMPLETE' });
  });
});
