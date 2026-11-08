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
import { createFakePaymentProcessor } from '@ensemus/saas/testing';
import type { ProcessorCallContext } from '@ensemus/saas/payment';
import { runCharge } from '@ensemus/connectors/payment';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { paymentFixture, paymentTenant } from './saas-payment-fixture';

describe('payment attempts preserve an uncertain charge under actual roles', () => {
  const database = openAppDatabase(urls.app()),
    auth = new pg.Client({ connectionString: urls.auth() });
  let other: TenantContext;
  beforeAll(async () => {
    await auth.connect();
    await seedTaxTreatment();
    other = await paymentTenant(database.db, auth);
  });
  afterAll(async () => {
    await auth.end();
    await database.close();
  });
  it('denies member and cross-tenant payment operations before contact', async () => {
    const who = await paymentFixture(database.db, auth);
    await withTenantTx(database.db, who.owner, (tx) =>
      tx
        .insert(memberships)
        .values({ organizationId: who.owner.organizationId, userId: other.userId, role: 'member' }),
    );
    const member = await resolveTenantContext(database.db, other.userId, who.owner.organizationId);
    for (const context of [member, other])
      await expect(
        requestInvoicePayment(database.db, context, {
          invoiceId: who.invoice.id,
          processor: 'test_scripted',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      beginPaymentAttempt(database.db, who.owner, { paymentId: randomUUID(), runId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      listInvoicePayments(database.db, member, { invoiceId: who.invoice.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      requestInvoicePayment(database.db, who.service, {
        invoiceId: who.invoice.id,
        processor: 'test_scripted',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('serializes request keys and concurrent claims; a paid retry replays the original response', async () => {
    const who = await paymentFixture(database.db, auth),
      input = { invoiceId: who.invoice.id, processor: 'test_scripted', requestKey: randomUUID() };
    const [first, second] = await Promise.all([
      requestInvoicePaymentOnce(database.db, who.owner, input),
      requestInvoicePaymentOnce(database.db, who.owner, input),
    ]);
    expect(first.kind).not.toBe('conflict');
    expect(second.kind).not.toBe('conflict');
    if (first.kind === 'conflict' || second.kind === 'conflict')
      throw new Error('fixture conflict');
    expect(first.paymentId).toBe(second.paymentId);
    const claims = await Promise.all([
      beginPaymentAttempt(database.db, who.service, {
        paymentId: first.paymentId,
        runId: randomUUID(),
      }),
      beginPaymentAttempt(database.db, who.service, {
        paymentId: first.paymentId,
        runId: randomUUID(),
      }),
    ]);
    expect(claims.filter((row) => row.kind === 'attempt')).toHaveLength(1);
    expect(claims.filter((row) => row.kind === 'reconcile')).toHaveLength(1);
    const attempt = claims.find((row) => row.kind === 'attempt')!;
    if (attempt.kind !== 'attempt') throw new Error('no attempt');
    expect(
      await finishPaymentAttempt(database.db, who.service, {
        attemptId: attempt.attemptId,
        result: { outcome: 'succeeded', code: 'CHARGED', processorPaymentRef: randomUUID() },
      }),
    ).toEqual({ step: 'succeeded' });
    expect((await getInvoice(database.db, who.owner, who.invoice.id)).status).toBe('paid');
    expect(await requestInvoicePaymentOnce(database.db, who.owner, input)).toMatchObject({
      kind: 'replayed',
      paymentId: first.paymentId,
      status: 'ready',
    });
    expect(
      await requestInvoicePaymentOnce(database.db, who.owner, {
        ...input,
        invoiceId: randomUUID(),
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await withTenantTx(database.db, who.service, (tx) => tx.select().from(paymentAttempts)),
    ).toHaveLength(1);
  });
  it('a timeout after a possible charge ends unknown and never opens another attempt', async () => {
    const who = await paymentFixture(database.db, auth),
      intent = await requestInvoicePayment(database.db, who.owner, {
        invoiceId: who.invoice.id,
        processor: 'test_scripted',
      });
    const attempt = await beginPaymentAttempt(database.db, who.service, {
      paymentId: intent.paymentId,
      runId: randomUUID(),
    });
    if (attempt.kind !== 'attempt') throw new Error('no attempt');
    const fake = createFakePaymentProcessor({
        lookup: 'none',
        onCharge: () => {
          throw new Error('private processor canary');
        },
      }),
      call: ProcessorCallContext = {
        signal: new AbortController().signal,
        withCredential: async () => {
          throw new Error('unexpected credential');
        },
        request: async () => {
          throw new Error('unexpected network');
        },
      };
    expect(
      await finishPaymentAttempt(database.db, who.service, {
        attemptId: attempt.attemptId,
        result: await runCharge(fake, call, attempt.charge),
      }),
    ).toEqual({ step: 'reconcile' });
    const lookup = await beginPaymentReconcile(database.db, who.service, {
      paymentId: intent.paymentId,
      code: 'PROCESSOR_ERROR',
    });
    expect(lookup).not.toBeNull();
    expect(
      await finishPaymentReconcile(database.db, who.service, {
        attemptId: attempt.attemptId,
        result: { found: 'cannot_answer' },
        lookup: 'none',
      }),
    ).toBe('unknown');
    expect(
      await beginPaymentAttempt(database.db, who.service, {
        paymentId: intent.paymentId,
        runId: randomUUID(),
      }),
    ).toMatchObject({ kind: 'stop', status: 'unknown' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.charges).toHaveLength(1);
    expect((await getInvoice(database.db, who.owner, who.invoice.id)).status).toBe('open');
    await expect(
      withTenantTx(database.db, who.service, (tx) =>
        tx.update(payments).set({ status: 'succeeded' }).where(eq(payments.id, intent.paymentId)),
      ),
    ).rejects.toThrow();
    const [row] = await listInvoicePayments(database.db, who.owner, { invoiceId: who.invoice.id });
    await expect(
      resolveUnknownPayment(database.db, other, {
        paymentId: row!.id,
        resolution: 'confirmed_not_charged',
        expectedVersion: row!.version,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await resolveUnknownPayment(database.db, who.owner, {
      paymentId: row!.id,
      resolution: 'confirmed_not_charged',
      expectedVersion: row!.version,
    });
    expect(await readPaymentOutcome(database.db, who.service, { paymentId: row!.id })).toBe(
      'failed',
    );
  });
  it('only explicit not-sent or authoritative absence permits a subsequent claim', async () => {
    const who = await paymentFixture(database.db, auth),
      intent = await requestInvoicePayment(database.db, who.owner, {
        invoiceId: who.invoice.id,
        processor: 'test_scripted',
      });
    let attempt = await beginPaymentAttempt(database.db, who.service, {
      paymentId: intent.paymentId,
      runId: randomUUID(),
    });
    if (attempt.kind !== 'attempt') throw new Error('no attempt');
    expect(
      await finishPaymentAttempt(database.db, who.service, {
        attemptId: attempt.attemptId,
        result: { outcome: 'not_sent', code: 'CONNECTION_REFUSED', retryable: true },
      }),
    ).toMatchObject({ step: 'retry' });
    attempt = await beginPaymentAttempt(database.db, who.service, {
      paymentId: intent.paymentId,
      runId: randomUUID(),
    });
    if (attempt.kind !== 'attempt') throw new Error('no attempt');
    expect(attempt.charge.attemptNo).toBe(2);
    await beginPaymentReconcile(database.db, who.service, {
      paymentId: intent.paymentId,
      code: 'PROCESSOR_ERROR',
    });
    expect(
      await finishPaymentReconcile(database.db, who.service, {
        attemptId: attempt.attemptId,
        result: { found: 'not_found' },
        lookup: 'authoritative',
      }),
    ).toBe('retry');
    expect(
      await beginPaymentAttempt(database.db, who.service, {
        paymentId: intent.paymentId,
        runId: randomUUID(),
      }),
    ).toMatchObject({ kind: 'attempt', charge: { attemptNo: 3 } });
  });
  it('an unsent failure cannot overwrite a worker claim that won the race', async () => {
    const who = await paymentFixture(database.db, auth),
      intent = await requestInvoicePayment(database.db, who.owner, {
        invoiceId: who.invoice.id,
        processor: 'test_scripted',
      });
    expect(
      await inspectInterruptedPayment(database.db, who.service, { paymentId: intent.paymentId }),
    ).toBe('nothing_sent');
    await beginPaymentAttempt(database.db, who.service, {
      paymentId: intent.paymentId,
      runId: randomUUID(),
    });
    await failUnsentPayment(database.db, who.service, {
      paymentId: intent.paymentId,
      code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(
      await inspectInterruptedPayment(database.db, who.service, { paymentId: intent.paymentId }),
    ).toBe('attempt_open');
    await expect(
      readPaymentOutcome(database.db, createServiceContext(other.organizationId), {
        paymentId: intent.paymentId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
