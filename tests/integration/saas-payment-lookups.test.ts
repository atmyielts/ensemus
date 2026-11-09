// Authored, unrun: real app/secrets SQL + generated TLS/native adapter only. No hosted provider claim.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { openAppDatabase, paymentAttempts, payments, withTenantTx } from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { pgCode } from '@ensemus/application';
import {
  beginPaymentReconcile,
  finishPaymentAttempt,
  finishPaymentReconcile,
  readPaymentOutcome,
} from '@ensemus/application/saas/payments';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import {
  getVerifiedPaymentLookupOutcome,
  runBoundCharge,
  runBoundPaymentLookup,
} from '@ensemus/connectors/payment';
import { canonicalJson } from '@ensemus/domain/approval';
import { nativePaymentFixture } from '../helpers/native-payment';
import { seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';

describe('exact native lookup operation and one-use financial effect under actual roles', () => {
  const app = openAppDatabase(urls.app()),
    secretsDb = openSecretsDatabase(urls.secrets());
  const auth = new pg.Client({ connectionString: urls.auth() });
  const agents = createStandingAgentHaltPort();
  beforeAll(async () => {
    await auth.connect();
    await seedTaxTreatment();
  });
  afterAll(async () => {
    await auth.end();
    await secretsDb.close();
    await app.close();
  });
  async function prepared() {
    const f = await nativePaymentFixture(app.db, auth, secretsDb);
    try {
      const q = await f.qualify();
      await f.register();
      const attempt = await f.beginAttempt();
      if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_ACTUAL_NATIVE_ATTEMPT');
      f.nextCharge('drop_after_accept');
      const answer = await runBoundCharge(
        f.processor,
        f.call('charge', { attemptId: attempt.attemptId }),
        attempt.charge,
        q.authority.authoritySha256,
      );
      expect(answer.outcome).toBe('indeterminate');
      await finishPaymentAttempt(app.db, f.who.service, {
        attemptId: attempt.attemptId,
        result: answer,
      });
      await beginPaymentReconcile(app.db, f.who.service, {
        paymentId: f.payment.paymentId,
        code: 'PROCESSOR_ERROR',
      });
      const lookup = () =>
        runBoundPaymentLookup(
          f.processor,
          f.call('lookup', { attemptId: attempt.attemptId }),
          attempt.charge.idempotencyKey,
          q.authority.authoritySha256,
        );
      const state = async () => {
        const [row] = await withTenantTx(app.db, f.who.service, (tx) =>
          tx
            .select()
            .from(paymentAttempts)
            .where(
              and(
                eq(paymentAttempts.organizationId, f.who.owner.organizationId),
                eq(paymentAttempts.id, attempt.attemptId),
              ),
            ),
        );
        if (!row) throw new Error('TEST_EXPECTED_ACTUAL_ATTEMPT_ROW');
        return row;
      };
      return { f, q, attempt, lookup, state };
    } catch (error) {
      await f.close();
      throw error;
    }
  }
  it('settles only a genuine native fact and preserves the already-committed result on replay', async () => {
    const p = await prepared();
    try {
      const result = await p.lookup(),
        token = await p.f.attestLookupResult(result);
      expect(result.found).toBe('succeeded');
      const input = {
        attemptId: p.attempt.attemptId,
        result,
        lookup: 'authoritative' as const,
        nativeLookupToken: token.token,
      };
      expect(await finishPaymentReconcile(app.db, p.f.who.service, input, agents)).toBe(
        'succeeded',
      );
      const committed = await p.state();
      expect(committed.lookupOutcomeConsumedXid).toMatch(/^[0-9]+$/);
      expect(await finishPaymentReconcile(app.db, p.f.who.service, input, agents)).toBe(
        'succeeded',
      );
      expect(await p.state()).toEqual(committed);
      await expect(
        withTenantTx(app.db, p.f.who.service, (tx) =>
          tx.execute(sql`select billing.consume_payment_lookup(
        ${p.attempt.attemptId}::uuid,${token.token},${canonicalJson(result)})`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
    } finally {
      await p.f.close();
    }
  });
  it('invalidates an earlier native result and token on a fresh lookup in the same generation', async () => {
    const p = await prepared();
    try {
      const oldResult = await p.lookup(),
        oldProof = getVerifiedPaymentLookupOutcome(oldResult);
      if (!oldProof) throw new Error('TEST_EXPECTED_NATIVE_OLD_LOOKUP');
      const oldToken = await p.f.attestLookupResult(oldResult);
      const current = await p.lookup(),
        currentProof = getVerifiedPaymentLookupOutcome(current);
      expect(currentProof?.restoreGeneration).toBe(oldProof.restoreGeneration);
      expect(currentProof?.lookupOperationId).not.toBe(oldProof.lookupOperationId);
      await expect(p.f.attestLookup(oldProof)).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === 'EN850',
      );
      await expect(
        finishPaymentReconcile(
          app.db,
          p.f.who.service,
          {
            attemptId: p.attempt.attemptId,
            result: oldResult,
            lookup: 'authoritative',
            nativeLookupToken: oldToken.token,
          },
          agents,
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect((await p.state()).outcome).toBe('indeterminate');
      const currentToken = await p.f.attestLookupResult(current);
      expect(
        await finishPaymentReconcile(
          app.db,
          p.f.who.service,
          {
            attemptId: p.attempt.attemptId,
            result: current,
            lookup: 'authoritative',
            nativeLookupToken: currentToken.token,
          },
          agents,
        ),
      ).toBe('succeeded');
    } finally {
      await p.f.close();
    }
  });
  it('refuses a swapped absence fact and a different tenant, leaving the genuine token usable', async () => {
    const p = await prepared();
    const other = await nativePaymentFixture(app.db, auth, secretsDb);
    try {
      const result = await p.lookup(),
        token = await p.f.attestLookupResult(result);
      await expect(
        finishPaymentReconcile(
          app.db,
          p.f.who.service,
          {
            attemptId: p.attempt.attemptId,
            result: { found: 'not_found' },
            lookup: 'authoritative',
            nativeLookupToken: token.token,
          },
          agents,
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      await expect(
        withTenantTx(app.db, other.who.service, (tx) =>
          tx.execute(sql`select billing.consume_payment_lookup(
        ${p.attempt.attemptId}::uuid,${token.token},${canonicalJson(result)})`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect((await p.state()).lookupOutcomeConsumedXid).toBeNull();
      expect(
        await finishPaymentReconcile(
          app.db,
          p.f.who.service,
          {
            attemptId: p.attempt.attemptId,
            result,
            lookup: 'authoritative',
            nativeLookupToken: token.token,
          },
          agents,
        ),
      ).toBe('succeeded');
    } finally {
      await other.close();
      await p.f.close();
    }
  });
  it('rolls back both token consumption and its real native outcome, and cannot consume without the effect', async () => {
    const p = await prepared();
    try {
      const result = await p.lookup(),
        token = await p.f.attestLookupResult(result);
      if (result.found !== 'succeeded') throw new Error('TEST_EXPECTED_NATIVE_PAYMENT_FOUND');
      await expect(
        withTenantTx(app.db, p.f.who.service, async (tx) => {
          await tx.execute(
            sql`select billing.consume_payment_lookup(${p.attempt.attemptId}::uuid,${token.token},${canonicalJson(result)})`,
          );
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      await expect(
        withTenantTx(app.db, p.f.who.service, async (tx) => {
          await tx.execute(
            sql`select billing.consume_payment_lookup(${p.attempt.attemptId}::uuid,${token.token},${canonicalJson(result)})`,
          );
          await tx.execute(
            sql`select billing.consume_payment_lookup(${p.attempt.attemptId}::uuid,${token.token},${canonicalJson(result)})`,
          );
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      await expect(
        withTenantTx(app.db, p.f.who.service, async (tx) => {
          await tx.execute(
            sql`select billing.consume_payment_lookup(${p.attempt.attemptId}::uuid,${token.token},${canonicalJson(result)})`,
          );
          await tx
            .update(paymentAttempts)
            .set({
              outcome: 'succeeded',
              outcomeCode: 'FOUND_BY_LOOKUP',
              processorPaymentRef: result.processorPaymentRef,
            })
            .where(eq(paymentAttempts.id, p.attempt.attemptId));
          throw new Error('TEST_NATIVE_LOOKUP_ROLLBACK');
        }),
      ).rejects.toThrow('TEST_NATIVE_LOOKUP_ROLLBACK');
      expect((await p.state()).outcome).toBe('indeterminate');
      expect((await p.state()).lookupOutcomeConsumedXid).toBeNull();
      // readPaymentOutcome reads only a terminal outcome and refuses a pending one (payments.ts), so
      // the rolled-back payment is read as still reconciling from its own row.
      await expect(
        readPaymentOutcome(app.db, p.f.who.service, { paymentId: p.f.payment.paymentId }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      const [still] = await withTenantTx(app.db, p.f.who.service, (tx) =>
        tx
          .select({ status: payments.status })
          .from(payments)
          .where(eq(payments.id, p.f.payment.paymentId)),
      );
      expect(still?.status).toBe('reconciling');
      expect(
        await finishPaymentReconcile(
          app.db,
          p.f.who.service,
          {
            attemptId: p.attempt.attemptId,
            result,
            lookup: 'authoritative',
            nativeLookupToken: token.token,
          },
          agents,
        ),
      ).toBe('succeeded');
    } finally {
      await p.f.close();
    }
  });
  it('denies app minting, direct operation stamps and a cloned in-process proof', async () => {
    const p = await prepared();
    try {
      const result = await p.lookup(),
        proof = getVerifiedPaymentLookupOutcome(result);
      if (!proof) throw new Error('TEST_EXPECTED_NATIVE_LOOKUP');
      await expect(p.f.attestLookup({ ...proof })).rejects.toMatchObject({
        code: 'PREREQUISITES_INCOMPLETE',
      });
      await expect(
        withTenantTx(app.db, p.f.who.service, (tx) =>
          tx.execute(sql`select billing.attest_payment_lookup(
        ${proof.organizationId}::uuid,${proof.paymentId}::uuid,${proof.attemptId}::uuid,${proof.executionBindingId}::uuid,
        ${proof.lookupOperationId}::uuid,${proof.restoreGeneration}::uuid,${proof.authoritySha256},${proof.requestKeySha256},${proof.factCanonical})`),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      await expect(
        withTenantTx(app.db, p.f.who.service, (tx) =>
          tx
            .update(paymentAttempts)
            .set({ lookupOperationId: randomUUID() })
            .where(eq(paymentAttempts.id, p.attempt.attemptId)),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
      expect((await p.state()).outcome).toBe('indeterminate');
    } finally {
      await p.f.close();
    }
  });
});
