// Real native SQL roles, generated local processor responses and actual offboarding/eraser services.
// Requires composed 0417/0419/0422/0510/0514/0515/0518 and final reviewed0999. Authored, not run.
// No financial witness, child lineage, native admission or physical-deletion receipt is fabricated.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  connections,
  openAppDatabase,
  paymentWebhookEvents,
  webhookDeliveries,
  withTenantTx,
} from '@ensemus/database';
import { openSecretsDatabase } from '@ensemus/database/secrets';
import { eraseTenantRows, openEraserDatabase } from '@ensemus/database/eraser';
import { createServiceContext } from '@ensemus/database/service';
import { ingestWebhookDelivery, pgCode, revokeConnection } from '@ensemus/application';
import {
  bindPaymentExecution,
  preflightPaymentExecution,
  qualifyPaymentWebhookExecution,
} from '@ensemus/application/saas/payment-execution';
import { routePaymentEvent } from '@ensemus/application/saas/payment-events';
import { beginErasure } from '@ensemus/application/saas/offboarding';
import { placeLegalHold, releaseLegalHold } from '@ensemus/application/saas/legal-holds';
import { createStandingAgentHaltPort } from '@ensemus/application/saas/standing-agent-port';
import { sealDelegatedErasureInTx } from '@ensemus/application/knowledge/delegated-erasure';
import { createConnectorRegistry, signWebhook } from '@ensemus/connectors/runtime';
import { runBoundCharge } from '@ensemus/connectors/payment';
import { hashCustomerRef, type PaymentEventFact } from '@ensemus/saas/payment';
import { createWebhookActivities } from '@ensemus/workflows/webhook-activities';
import { nativePaymentFixture } from '../helpers/native-payment';
import { seedTaxTreatment } from '../helpers/saas';
import { urls } from '../helpers/stack';
import { readyToErase } from './saas-offboarding-fixture';

const removedConstraints = [
  'payment_identity_connection',
  'payment_identity_secret',
  'payment_execution_connection',
  'payment_execution_secret',
  'payment_webhook_delivery',
  'payment_webhook_endpoint',
  'payment_webhook_connection',
  'payment_webhook_api_secret',
  'payment_webhook_binding_endpoint',
  'payment_webhook_binding_connection',
  'payment_webhook_binding_credential',
  'payment_webhook_binding_signing',
  'payment_webhook_attestation_delivery',
  'payment_webhook_attestation_endpoint',
  'payment_webhook_attestation_connection',
  'payment_webhook_attestation_signing',
];

describe('historical payment witnesses and live private referent lifetime (0518)', () => {
  const app = openAppDatabase(urls.app()),
    secrets = openSecretsDatabase(urls.secrets()),
    eraser = openEraserDatabase(urls.superuser()),
    auth = new pg.Client({ connectionString: urls.auth() }),
    control = new pg.Client({ connectionString: urls.migrator() });
  beforeAll(async () => {
    await auth.connect();
    await control.connect();
    // The production eraser role is NOLOGIN. Use PostgreSQL's actual session identity, not SET ROLE
    // or an application actor cast; the adapter must independently require this native identity.
    await eraser.db.execute(sql`set session authorization ensemus_eraser`);
    await seedTaxTreatment();
  });
  afterAll(async () => {
    await eraser.db.execute(sql`reset session authorization`);
    await eraser.close();
    await control.end();
    await auth.end();
    await secrets.close();
    await app.close();
  });

  const fixture = () => nativePaymentFixture(app.db, auth, secrets);
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const agents = createStandingAgentHaltPort();

  // Maintenance-only inspection of generated financial metadata. Runtime app/agent/secrets roles
  // receive no private table reader; original financial IDs/hashes must survive byte-for-byte.
  async function witnesses(...organizations: string[]) {
    const result: { organizationId: string; table_ref: string; witness: unknown }[] = [];
    for (const organizationId of organizations) {
      await control.query('begin');
      try {
        await control.query(
          "select set_config('app.organization_id',$1,true),set_config('billing.payment_org',$1,true)",
          [organizationId],
        );
        const rows = await control.query<{ table_ref: string; witness: unknown }>(
          `
          select table_ref,witness from (
          select 'billing.payment_identity_attestations' as table_ref,to_jsonb(p) as witness from billing.payment_identity_attestations p where organization_id=$1
          union all select 'billing.payment_execution_bindings',to_jsonb(p) from billing.payment_execution_bindings p where organization_id=$1
          union all select 'billing.payment_customer_bindings',to_jsonb(p) from billing.payment_customer_bindings p where organization_id=$1
          union all select 'billing.payment_webhook_bindings',to_jsonb(p) from billing.payment_webhook_bindings p where organization_id=$1
          union all select 'billing.payment_webhook_attestations',to_jsonb(p) from billing.payment_webhook_attestations p where organization_id=$1
          union all select 'billing.payment_webhook_events',to_jsonb(p) from billing.payment_webhook_events p where organization_id=$1
          ) proof order by table_ref,witness::text`,
          [organizationId],
        );
        result.push(...rows.rows.map((row) => ({ organizationId, ...row })));
        await control.query('commit');
      } catch (error) {
        await control.query('rollback');
        throw error;
      }
    }
    return result;
  }

  async function completeNativePayment(f: Fixture) {
    const qualified = await f.qualify(),
      customer = await f.register();
    if (!customer) throw new Error('TEST_EXPECTED_NATIVE_CUSTOMER');
    await qualifyPaymentWebhookExecution(app.db, f.operatorContext, {
      originOrganizationId: f.who.owner.organizationId,
      paymentId: f.payment.paymentId,
      bindingId: qualified.binding.id,
      endpointId: f.endpoint.endpointId,
    });
    const attempt = await f.beginAttempt();
    if (attempt.kind !== 'attempt') throw new Error('TEST_EXPECTED_NATIVE_ATTEMPT');
    const answer = await runBoundCharge(
      f.processor,
      f.call('charge', { attemptId: attempt.attemptId }),
      attempt.charge,
      qualified.authority.authoritySha256,
    );
    if (answer.outcome !== 'succeeded') throw new Error('TEST_EXPECTED_NATIVE_ACK');
    const event: PaymentEventFact = {
      processor: 'test_scripted',
      providerEventId: randomUUID(),
      kind: 'payment_succeeded',
      customerRefHash: hashCustomerRef('test_scripted', customer),
      processorPaymentRef: answer.processorPaymentRef,
      paymentId: f.payment.paymentId,
      amountMicros: attempt.charge.amountMicros.toString(),
      currency: attempt.charge.currency,
      occurredAtSeconds: Math.floor(Date.now() / 1000),
    };
    const body = Buffer.from(JSON.stringify({ event, identity: f.currentIdentity })),
      timestampSeconds = Math.floor(Date.now() / 1000);
    expect(
      await ingestWebhookDelivery(app.db, {
        token: f.endpoint.token,
        body,
        headers: {
          'content-type': 'application/json',
          'x-ensemus-event-id': event.providerEventId,
          'x-ensemus-timestamp': String(timestampSeconds),
          'x-ensemus-signature': signWebhook(Buffer.from(f.signingKey), {
            timestampSeconds,
            eventId: event.providerEventId,
            body,
          }),
        },
      }),
    ).toBe('accepted');
    const [delivery] = await withTenantTx(app.db, f.operatorContext, (tx) =>
      tx
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.endpointId, f.endpoint.endpointId),
            eq(webhookDeliveries.state, 'received'),
          ),
        ),
    );
    if (!delivery) throw new Error('TEST_EXPECTED_NATIVE_DELIVERY');
    const webhook = createWebhookActivities({
      database: app.db,
      registry: createConnectorRegistry([f.connector]),
      secrets: f.broker,
      attestPaymentWebhook: f.attestWebhook,
      network: {
        openRelay: async () => {
          throw new Error('TEST_WEBHOOK_HAS_NO_NETWORK');
        },
      },
      paymentWebhook: {
        billingOrganizationId: f.operator.organizationId,
        billingConnectionId: f.connection.id,
        processor: 'test_scripted',
      },
    });
    expect(
      await webhook.processWebhookDelivery({
        organizationId: f.operator.organizationId,
        deliveryId: delivery.id,
      }),
    ).toBe('applied');
    const [receipt] = await withTenantTx(app.db, f.operatorContext, (tx) =>
      tx
        .select({ id: paymentWebhookEvents.id })
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.providerEventId, event.providerEventId)),
    );
    if (!receipt) throw new Error('TEST_EXPECTED_NATIVE_FINANCIAL_RECEIPT');
    expect(
      await routePaymentEvent(
        app.db,
        f.operatorContext,
        { paymentWebhookEventId: receipt.id },
        { billingOrganizationId: f.operator.organizationId },
        agents,
      ),
    ).toBe('applied');
  }

  it('removes only live-body FKs while retaining financial and inbox referential integrity', async () => {
    const missing = await control.query(
      "select conname from pg_constraint where contype='f' and conname=any($1::text[])",
      [removedConstraints],
    );
    expect(missing.rows).toEqual([]);
    const kept = [
      'payment_identity_payment',
      'payment_identity_consumed_binding',
      'payment_execution_payment',
      'payment_execution_attestation',
      'payment_customer_account',
      'payment_customer_execution',
      'payment_webhook_binding_execution',
      'payment_webhook_attestation_inbox',
      'payment_webhook_attestation_event',
      'payment_webhook_verification',
    ];
    const actual = await control.query<{ conname: string }>(
      "select conname from pg_constraint where contype='f' and conname=any($1::text[]) order by conname",
      [kept],
    );
    expect(actual.rows.map((row) => row.conname)).toEqual([...kept].sort());
  });

  it('erases the operator private referents under the real seal, refuses a hold, clears dirty pooled authority and resumes after a lost report', async () => {
    const f = await fixture();
    try {
      await completeNativePayment(f);
      const original = await witnesses(f.who.owner.organizationId, f.operator.organizationId);
      expect(new Set(original.map((row) => row.table_ref)).size).toBe(6);
      await revokeConnection(app.db, f.operator, {
        connectionId: f.connection.id,
        expectedVersion: f.connection.version,
      });
      const ready = await readyToErase(app.db, f.operator);
      await beginErasure(app.db, ready.service, {
        offboardingId: ready.offboardingId,
        operatorRef: 'test-operator@example.invalid',
      });
      const hold = await placeLegalHold(app.db, f.operator, {
        matterRef: randomUUID(),
        scopes: [{ type: 'organization', id: null }],
      });
      expect(
        await withTenantTx(app.db, ready.service, (tx) =>
          sealDelegatedErasureInTx(tx, ready.service, ready),
        ),
      ).toBe(false);
      await expect(eraseTenantRows(eraser.db, f.operator.organizationId)).rejects.toThrow(
        'ERASURE_NOT_OPEN',
      );
      await releaseLegalHold(app.db, f.operator, {
        holdId: hold.holdId,
        expectedVersion: 1,
        reasonCode: 'TEST_CLOSED',
      });
      expect(
        await withTenantTx(app.db, ready.service, (tx) =>
          sealDelegatedErasureInTx(tx, ready.service, ready),
        ),
      ).toBe(true);
      // Pool size1 makes this the next real connection. A forged session selector must never become
      // the Tx's membership, source scope, terminal control or target-tenant authority.
      await eraser.db.execute(
        sql`select set_config('app.organization_id',${f.who.owner.organizationId},false),set_config('app.actor_type','user',false),set_config('app.membership_id',${f.who.owner.membershipId},false),set_config('lifecycle.delegated_erase_org',${f.who.owner.organizationId},false),set_config('app.terminal_work_control_run',${randomUUID()},false)`,
      );
      const first = await eraseTenantRows(eraser.db, f.operator.organizationId);
      for (const tableRef of [
        'integrations.webhook_deliveries',
        'integrations.webhook_endpoints',
        'integrations.connections',
        'secrets.sealed_secrets',
      ]) {
        const table = first.find((row) => row.tableRef === tableRef);
        expect(table?.rowsRemoved, tableRef).toBeGreaterThan(0);
        expect(table?.rowsLeft, tableRef).toBe(0);
      }
      expect(await witnesses(f.who.owner.organizationId, f.operator.organizationId)).toEqual(
        original,
      );
      // Simulate process loss after committed row cleanup, before a final report. Same current
      // immutable witness permits an honest resume; empty rows cannot create a new witness.
      const retry = await eraseTenantRows(eraser.db, f.operator.organizationId);
      expect(retry.every((row) => row.rowsRemoved === 0 && row.rowsLeft === 0)).toBe(true);
      const requests = f.server.requests.length;
      await expect(f.refresh()).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect(f.server.requests).toHaveLength(requests);
      await expect(
        eraser.db.execute(sql`select ciphertext from secrets.sealed_secrets`),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '42501');
    } finally {
      await f.close();
    }
  });

  it('cannot consume a previously real token or mint new I/O from a revoked original credential', async () => {
    const f = await fixture();
    try {
      await f.qualify();
      const token = await f.refresh();
      const original = await witnesses(f.who.owner.organizationId);
      await f.broker.revoke(f.operator.organizationId, f.credential.secretRef);
      const requests = f.server.requests.length;
      await expect(
        bindPaymentExecution(app.db, f.who.service, {
          paymentId: f.payment.paymentId,
          token: token.token,
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      await expect(f.refresh()).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect(f.server.requests).toHaveLength(requests);
      expect(await witnesses(f.who.owner.organizationId)).toEqual(original);
    } finally {
      await f.close();
    }
  });

  it('refuses wrong-tenant live references and a foreign genuine token without using historical IDs as authority', async () => {
    const f = await fixture();
    try {
      const qualified = await f.qualify();
      const token = await f.refresh();
      await expect(
        bindPaymentExecution(app.db, createServiceContext(f.operator.organizationId), {
          paymentId: f.payment.paymentId,
          token: token.token,
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      const requests = f.server.requests.length;
      for (const connectionId of [f.connection.id, randomUUID()])
        await expect(
          preflightPaymentExecution(app.db, f.who.service, {
            paymentId: f.payment.paymentId,
            billingOrganizationId: f.who.owner.organizationId,
            connectionId,
            processor: 'test_scripted',
            adapterVersion: f.processor.manifest.version,
            apiOrigin: 'https://generated.mcp.invalid',
          }),
        ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      const native = new pg.Client({ connectionString: urls.secrets() });
      await native.connect();
      try {
        // A genuine broker login and real read hashes still cannot attest a connection in a
        // different organization. The live native join, rather than a permanent FK, owns birth.
        await expect(
          native.query(
            'select * from billing.attest_payment_identity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              f.who.owner.organizationId,
              f.payment.paymentId,
              f.who.owner.organizationId,
              f.connection.id,
              'test_scripted',
              f.processor.manifest.version,
              qualified.authority.apiOrigin,
              qualified.authority.authoritySha256,
              qualified.proof.sha256,
              qualified.proof.accountNamespaceSha256,
              qualified.proof.readReceiptSha256,
              qualified.proof.restoreGeneration,
            ],
          ),
        ).rejects.toMatchObject({ code: 'EN850' });
      } finally {
        await native.end();
      }
      expect(f.server.requests).toHaveLength(requests);
    } finally {
      await f.close();
    }
  });

  it('gives app/secrets/agent logins no direct private witness INSERT or mutable original identity', async () => {
    const f = await fixture();
    try {
      await f.qualify();
      const original = await witnesses(f.who.owner.organizationId);
      for (const connectionString of [urls.app(), urls.secrets(), urls.agent()]) {
        const caller = new pg.Client({ connectionString });
        await caller.connect();
        try {
          for (const table of [
            'payment_identity_attestations',
            'payment_execution_bindings',
            'payment_webhook_bindings',
            'payment_webhook_attestations',
          ]) {
            await expect(
              caller.query(`insert into billing.${table} default values`),
            ).rejects.toMatchObject({ code: '42501' });
          }
          await expect(
            caller.query(
              'update billing.payment_execution_bindings set connection_id=$1 where organization_id=$2',
              [randomUUID(), f.who.owner.organizationId],
            ),
          ).rejects.toMatchObject({ code: '42501' });
        } finally {
          await caller.end();
        }
      }
      await expect(
        withTenantTx(app.db, f.operatorContext, (tx) =>
          tx.insert(paymentWebhookEvents).values({
            organizationId: f.operator.organizationId,
            verificationId: randomUUID(),
            processor: 'test_scripted',
            providerEventId: randomUUID(),
            kind: 'payment_succeeded',
            sourceDeliveryId: randomUUID(),
            sourceEndpointId: f.endpoint.endpointId,
            sourceConnectionId: f.connection.id,
            customerRefHash: '0'.repeat(64),
            providerOccurredAt: new Date(),
          }),
        ),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect(await witnesses(f.who.owner.organizationId)).toEqual(original);
    } finally {
      await f.close();
    }
  });

  it('holds genuine birth referent locks through commit and refuses that token after committed revocation', async () => {
    const f = await fixture(),
      native = new pg.Client({ connectionString: urls.secrets() });
    await native.connect();
    try {
      const qualified = await f.qualify();
      await native.query('begin');
      const attested = await native.query<{ token: string }>(
        'select * from billing.attest_payment_identity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          f.who.owner.organizationId,
          f.payment.paymentId,
          f.operator.organizationId,
          f.connection.id,
          'test_scripted',
          f.processor.manifest.version,
          qualified.authority.apiOrigin,
          qualified.authority.authoritySha256,
          qualified.proof.sha256,
          qualified.proof.accountNamespaceSha256,
          qualified.proof.readReceiptSha256,
          qualified.proof.restoreGeneration,
        ],
      );
      const token = attested.rows[0]?.token;
      if (!token) throw new Error('TEST_EXPECTED_NATIVE_ATTESTATION');
      // Actual app/native owner transaction, not a synthetic promise barrier. The failed direct
      // mutation rolls back; the eventual successful revocation uses the real domain service.
      await expect(
        withTenantTx(app.db, f.operator, async (tx) => {
          await tx.execute(sql`select set_config('lock_timeout','100ms',true)`);
          return tx
            .update(connections)
            .set({ state: 'revoked', version: f.connection.version + 1 })
            .where(eq(connections.id, f.connection.id));
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === '55P03');
      await native.query('commit');
      await revokeConnection(app.db, f.operator, {
        connectionId: f.connection.id,
        expectedVersion: f.connection.version,
      });
      const requests = f.server.requests.length;
      await expect(
        bindPaymentExecution(app.db, f.who.service, { paymentId: f.payment.paymentId, token }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === 'EN850');
      expect(f.server.requests).toHaveLength(requests);
    } finally {
      await native.query('rollback');
      await native.end();
      await f.close();
    }
  });
});
